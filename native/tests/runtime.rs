use otools_clipboard_native::runtime::Runtime;
use rusqlite::Connection;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs,
    sync::Arc,
    time::{Duration, Instant},
};
use tempfile::TempDir;

fn envelope(dir: &TempDir, topic: &str, seq: u64, payload: Value) -> Value {
    json!({"schemaVersion":1,"topic":topic,"sessionId":"test-session","seq":seq,"timestamp":2_000_000_000_000u64,"pluginDir":"/plugin-install","pluginDataDir":dir.path(),"payload":payload})
}

fn text(text: &str) -> Value {
    let mut digest = Sha256::new();
    digest.update(b"otools:clipboard:text:v1\0");
    digest.update(text.as_bytes());
    json!({"text":{"text":text,"hash":format!("{:x}",digest.finalize())}})
}

fn invoke(runtime: &Runtime, dir: &TempDir, method: &str, payload: Value) -> Value {
    runtime.invoke(json!({"method":method,"payload":payload,"pluginDataDir":dir.path(),"pluginDir":"/plugin-install"})).unwrap()
}

fn started(runtime: &Runtime, dir: &TempDir) {
    assert_eq!(
        runtime
            .on_event(envelope(dir, "host.events.started", 1, json!({})))
            .unwrap(),
        json!({"accepted":true})
    );
    runtime
        .on_event(envelope(
            dir,
            "host.events.status",
            2,
            json!({"source":"clipboard","state":"ready"}),
        ))
        .unwrap();
}

#[test]
fn delayed_host_event_from_paused_interval_is_not_backfilled_after_resume() {
    let dir = TempDir::new().unwrap();
    let runtime = Runtime::new();
    started(&runtime, &dir);
    invoke(
        &runtime,
        &dir,
        "clipboard_update_settings",
        json!({"paused":true}),
    );
    let mut delayed = envelope(&dir, "clipboard.changed", 3, text("copied while paused"));
    delayed["timestamp"] = json!(otools_clipboard_native::protocol::unix_millis());
    std::thread::sleep(Duration::from_millis(2));
    invoke(
        &runtime,
        &dir,
        "clipboard_update_settings",
        json!({"paused":false}),
    );
    runtime.on_event(delayed).unwrap();
    assert_eq!(
        invoke(&runtime, &dir, "clipboard_list", json!({}))["total"],
        0
    );
    runtime
        .on_event(envelope(
            &dir,
            "clipboard.changed",
            4,
            text("new copy after resume"),
        ))
        .unwrap();
    assert_eq!(
        invoke(&runtime, &dir, "clipboard_list", json!({}))["total"],
        1
    );
    runtime.shutdown().unwrap();
}

#[test]
fn stale_ids_and_invalid_read_arguments_do_not_change_recording_health() {
    let dir = TempDir::new().unwrap();
    let runtime = Runtime::new();
    started(&runtime, &dir);
    for (method, payload, expected) in [
        (
            "clipboard_get",
            json!({"id":"00000000-0000-0000-0000-000000000001"}),
            "notFound",
        ),
        ("clipboard_get", json!({"id":"../nope"}), "invalidId"),
        (
            "clipboard_list",
            json!({"kind":"unsupported"}),
            "invalidFilter",
        ),
    ] {
        assert_eq!(
            runtime
                .invoke(json!({"method":method,"payload":payload,"pluginDataDir":dir.path()}))
                .unwrap_err(),
            expected
        );
        assert_eq!(runtime.status()["recording"], true);
        assert_eq!(runtime.status()["lastError"], Value::Null);
    }
    runtime.shutdown().unwrap();
}

#[test]
fn missing_host_context_is_unavailable_and_never_creates_storage() {
    let runtime = Runtime::new();
    let status = runtime
        .invoke(json!({"method":"clipboard_status","payload":{},"pluginDir":"/irrelevant"}))
        .unwrap();
    assert_eq!(status["ready"], false);
    assert_eq!(status["recording"], false);
    assert_eq!(status["sourceStatus"], "unavailable");
    assert_eq!(
        runtime
            .invoke(json!({"method":"clipboard_list","payload":{}}))
            .unwrap_err(),
        "hostContextUnavailable"
    );
}

#[test]
fn ui_invoke_initializes_store_but_cannot_start_recording() {
    let dir = TempDir::new().unwrap();
    let runtime = Runtime::new();
    assert_eq!(
        invoke(&runtime, &dir, "clipboard_list", json!({}))["total"],
        0
    );
    let status = invoke(&runtime, &dir, "clipboard_status", json!({}));
    assert_eq!(status["ready"], true);
    assert_eq!(status["recording"], false);
    assert_eq!(
        runtime
            .on_event(envelope(&dir, "clipboard.changed", 1, text("not started")))
            .unwrap_err(),
        "eventNotStarted"
    );
    started(&runtime, &dir);
    runtime
        .on_event(envelope(&dir, "clipboard.changed", 3, text("accepted")))
        .unwrap();
    assert_eq!(
        invoke(&runtime, &dir, "clipboard_list", json!({}))["total"],
        1
    );
    assert_eq!(
        invoke(&runtime, &dir, "clipboard_status", json!({}))["recording"],
        true
    );
    runtime.shutdown().unwrap();
}

#[test]
fn started_is_canonical_idempotent_and_root_changes_require_joined_stop() {
    let dir = TempDir::new().unwrap();
    let other = TempDir::new().unwrap();
    let runtime = Runtime::new();
    started(&runtime, &dir);
    runtime
        .on_event(envelope(&dir, "clipboard.changed", 3, text("persist")))
        .unwrap();
    invoke(&runtime, &dir, "clipboard_list", json!({}));
    let mut repeated = envelope(&dir, "host.events.started", 1, json!({}));
    repeated["pluginDataDir"] = json!(dir.path().join("."));
    runtime.on_event(repeated).unwrap();
    assert_eq!(
        runtime
            .on_event(envelope(&other, "host.events.started", 1, json!({})))
            .unwrap_err(),
        "dataRootChanged"
    );
    assert_eq!(
        invoke(&runtime, &dir, "clipboard_list", json!({}))["total"],
        1
    );
    runtime
        .on_event(envelope(&dir, "host.events.stopped", 4, json!({})))
        .unwrap();
    assert_eq!(runtime.status()["ready"], false);
    started(&runtime, &other);
    assert_eq!(
        invoke(&runtime, &other, "clipboard_list", json!({}))["total"],
        0
    );
    runtime.shutdown().unwrap();
}

#[test]
fn stop_flushes_accepted_data_and_restart_keeps_paused_setting() {
    let dir = TempDir::new().unwrap();
    let runtime = Runtime::new();
    started(&runtime, &dir);
    runtime
        .on_event(envelope(&dir, "clipboard.changed", 3, text("flush this")))
        .unwrap();
    runtime
        .on_event(envelope(&dir, "host.events.stopped", 4, json!({})))
        .unwrap();
    let other = Runtime::new();
    assert_eq!(
        invoke(&other, &dir, "clipboard_list", json!({}))["total"],
        1
    );
    invoke(
        &other,
        &dir,
        "clipboard_update_settings",
        json!({"paused":true}),
    );
    other.shutdown().unwrap();
    started(&runtime, &dir);
    let status = invoke(&runtime, &dir, "clipboard_status", json!({}));
    assert_eq!(status["paused"], true);
    assert_eq!(status["recording"], false);
    runtime
        .on_event(envelope(&dir, "clipboard.changed", 3, text("skip paused")))
        .unwrap();
    assert_eq!(
        invoke(&runtime, &dir, "clipboard_list", json!({}))["total"],
        1
    );
    runtime.shutdown().unwrap();
}

#[test]
fn global_sequence_gaps_do_not_claim_real_dropped_events() {
    let dir = TempDir::new().unwrap();
    let runtime = Runtime::new();
    started(&runtime, &dir);
    runtime
        .on_event(envelope(
            &dir,
            "clipboard.changed",
            10,
            text("global sequence"),
        ))
        .unwrap();
    invoke(&runtime, &dir, "clipboard_list", json!({}));
    assert_eq!(runtime.status()["droppedEvents"], 0);
    runtime.shutdown().unwrap();
}

#[test]
fn source_status_is_safe_and_poll_events_contains_only_invalidations() {
    let dir = TempDir::new().unwrap();
    let runtime = Runtime::new();
    started(&runtime, &dir);
    runtime
        .on_event(envelope(
            &dir,
            "clipboard.changed",
            3,
            text("private literal"),
        ))
        .unwrap();
    invoke(&runtime, &dir, "clipboard_list", json!({}));
    runtime.on_event(envelope(&dir,"host.events.status",4,json!({"source":"clipboard","state":"busy","code":"PRIVATE captured payload","droppedEvents":7}))).unwrap();
    let status = runtime.status();
    assert_eq!(status["sourceStatus"], "busy");
    assert_eq!(status["recording"], false);
    assert_eq!(status["droppedEvents"], 7);
    assert!(!status.to_string().contains("PRIVATE"));
    let events = invoke(&runtime, &dir, "poll_events", json!({}));
    assert!(events["events"]
        .as_array()
        .unwrap()
        .iter()
        .all(|e| e["payload"] == json!({})
            && ["clipboard:status", "clipboard:changed"].contains(&e["topic"].as_str().unwrap())));
    assert!(!events.to_string().contains("private literal"));
    assert_eq!(
        invoke(&runtime, &dir, "poll_events", json!({})),
        json!({"events":[]})
    );
    runtime
        .on_event(envelope(
            &dir,
            "host.events.status",
            5,
            json!({"source":"clipboard","state":"idle"}),
        ))
        .unwrap();
    assert_eq!(runtime.status()["sourceStatus"], "idle");
    runtime.shutdown().unwrap();
}

#[test]
fn read_commands_do_not_emit_status_invalidation_loops() {
    let dir = TempDir::new().unwrap();
    let runtime = Runtime::new();
    started(&runtime, &dir);
    runtime
        .on_event(envelope(
            &dir,
            "clipboard.changed",
            3,
            text("read stability"),
        ))
        .unwrap();
    let page = invoke(&runtime, &dir, "clipboard_list", json!({}));
    let id = page["items"][0]["id"].clone();
    invoke(&runtime, &dir, "poll_events", json!({}));
    invoke(&runtime, &dir, "clipboard_list", json!({}));
    invoke(&runtime, &dir, "clipboard_get_settings", json!({}));
    invoke(&runtime, &dir, "clipboard_get", json!({"id":id}));
    invoke(&runtime, &dir, "clipboard_status", json!({}));
    assert_eq!(
        invoke(&runtime, &dir, "poll_events", json!({})),
        json!({"events":[]})
    );
    runtime.shutdown().unwrap();
}

#[test]
fn capacity_error_survives_reads_until_capacity_or_capture_recovers() {
    let dir = TempDir::new().unwrap();
    let runtime = Runtime::new();
    started(&runtime, &dir);
    invoke(
        &runtime,
        &dir,
        "clipboard_update_settings",
        json!({"maxBytes":1}),
    );
    runtime
        .on_event(envelope(&dir, "clipboard.changed", 3, text("does not fit")))
        .unwrap();
    invoke(&runtime, &dir, "poll_events", json!({}));
    assert_eq!(runtime.status()["lastError"], "storageFull");
    invoke(&runtime, &dir, "clipboard_list", json!({}));
    invoke(&runtime, &dir, "clipboard_get_settings", json!({}));
    assert_eq!(runtime.status()["lastError"], "storageFull");
    assert_eq!(runtime.status()["recording"], false);
    invoke(
        &runtime,
        &dir,
        "clipboard_update_settings",
        json!({"maxBytes":100}),
    );
    assert_eq!(runtime.status()["lastError"], Value::Null);
    runtime.shutdown().unwrap();
}

#[test]
fn invalid_events_and_sequence_replays_are_rejected_without_content() {
    let dir = TempDir::new().unwrap();
    let runtime = Runtime::new();
    started(&runtime, &dir);
    let mut schema = envelope(&dir, "clipboard.changed", 3, text("private"));
    schema["schemaVersion"] = json!(2);
    assert_eq!(runtime.on_event(schema).unwrap_err(), "unsupportedSchema");
    let mut session = envelope(&dir, "clipboard.changed", 3, text("private"));
    session["sessionId"] = json!("other");
    assert_eq!(runtime.on_event(session).unwrap_err(), "staleSession");
    runtime
        .on_event(envelope(&dir, "clipboard.changed", 3, text("once")))
        .unwrap();
    assert_eq!(
        runtime
            .on_event(envelope(&dir, "clipboard.changed", 3, text("once")))
            .unwrap_err(),
        "staleEvent"
    );
    assert_eq!(
        invoke(&runtime, &dir, "clipboard_list", json!({}))["items"][0]["copyCount"],
        1
    );
    runtime.shutdown().unwrap();
}

#[test]
fn callback_does_not_wait_on_busy_sqlite_writer_and_queue_drops_are_observable() {
    let dir = TempDir::new().unwrap();
    let runtime = Runtime::new();
    started(&runtime, &dir);
    let db = Connection::open(dir.path().join("clipboard/history.sqlite3")).unwrap();
    db.execute_batch("BEGIN IMMEDIATE").unwrap();
    let started_at = Instant::now();
    for seq in 3..103 {
        runtime
            .on_event(envelope(
                &dir,
                "clipboard.changed",
                seq,
                text(&format!("item-{seq}")),
            ))
            .unwrap();
    }
    assert!(
        started_at.elapsed() < Duration::from_millis(500),
        "callbacks blocked behind SQLite"
    );
    assert!(runtime.status()["droppedEvents"].as_u64().unwrap() > 0);
    db.execute_batch("ROLLBACK").unwrap();
    let page = invoke(&runtime, &dir, "clipboard_list", json!({}));
    assert!(page["total"].as_u64().unwrap() <= 65);
    assert_eq!(
        invoke(
            &runtime,
            &dir,
            "clipboard_list",
            json!({"query":"item-102"})
        )["total"],
        1
    );
    runtime.shutdown().unwrap();
}

#[test]
fn byte_bounded_queue_drops_even_below_count_limit() {
    let dir = TempDir::new().unwrap();
    let runtime = Runtime::new();
    started(&runtime, &dir);
    let db = Connection::open(dir.path().join("clipboard/history.sqlite3")).unwrap();
    db.execute_batch("BEGIN IMMEDIATE").unwrap();
    runtime
        .on_event(envelope(&dir, "clipboard.changed", 3, text("block writer")))
        .unwrap();
    std::thread::sleep(Duration::from_millis(20));
    let large = text(&"a".repeat(1024 * 1024));
    for seq in 4..44 {
        runtime
            .on_event(envelope(&dir, "clipboard.changed", seq, large.clone()))
            .unwrap();
    }
    assert!(
        runtime.status()["droppedEvents"].as_u64().unwrap() >= 8,
        "byte limit must apply before 64 items"
    );
    db.execute_batch("ROLLBACK").unwrap();
    invoke(&runtime, &dir, "clipboard_list", json!({}));
    runtime.shutdown().unwrap();
}

#[test]
fn pause_epoch_drops_pre_pause_queue_even_after_resume() {
    let dir = TempDir::new().unwrap();
    let runtime = Arc::new(Runtime::new());
    started(&runtime, &dir);
    let db = Connection::open(dir.path().join("clipboard/history.sqlite3")).unwrap();
    db.execute_batch("BEGIN IMMEDIATE").unwrap();
    runtime
        .on_event(envelope(
            &dir,
            "clipboard.changed",
            3,
            text("inflight before pause"),
        ))
        .unwrap();
    std::thread::sleep(Duration::from_millis(20));
    for seq in 4..14 {
        runtime
            .on_event(envelope(
                &dir,
                "clipboard.changed",
                seq,
                text(&format!("stale-{seq}")),
            ))
            .unwrap();
    }
    let cloned = runtime.clone();
    let root = dir.path().to_owned();
    let pause = std::thread::spawn(move || {
        cloned.invoke(json!({"method":"clipboard_update_settings","pluginDataDir":root,"payload":{"paused":true}}))
    });
    let deadline = Instant::now() + Duration::from_secs(1);
    while !runtime.status()["paused"].as_bool().unwrap() && Instant::now() < deadline {
        std::thread::yield_now();
    }
    assert_eq!(
        runtime.status()["paused"],
        true,
        "pause must close admission before waiting for DB"
    );
    db.execute_batch("ROLLBACK").unwrap();
    pause.join().unwrap().unwrap();
    runtime
        .on_event(envelope(
            &dir,
            "clipboard.changed",
            14,
            text("during pause"),
        ))
        .unwrap();
    invoke(
        &runtime,
        &dir,
        "clipboard_update_settings",
        json!({"paused":false}),
    );
    runtime
        .on_event(envelope(
            &dir,
            "clipboard.changed",
            15,
            text("after resume"),
        ))
        .unwrap();
    let page = invoke(&runtime, &dir, "clipboard_list", json!({}));
    assert!(page["items"]
        .as_array()
        .unwrap()
        .iter()
        .all(|x| !x["preview"].as_str().unwrap().starts_with("stale-")
            && x["preview"] != "during pause"));
    assert!(page["items"]
        .as_array()
        .unwrap()
        .iter()
        .any(|x| x["preview"] == "after resume"));
    runtime.shutdown().unwrap();
}

#[test]
fn shutdown_timeout_retains_writer_and_rejects_restart_until_joined() {
    let dir = TempDir::new().unwrap();
    let runtime = Runtime::new();
    started(&runtime, &dir);
    let db = Connection::open(dir.path().join("clipboard/history.sqlite3")).unwrap();
    db.execute_batch("BEGIN IMMEDIATE").unwrap();
    for seq in 3..20 {
        runtime
            .on_event(envelope(
                &dir,
                "clipboard.changed",
                seq,
                text(&format!("blocked-{seq}")),
            ))
            .unwrap();
    }
    let stopped_at = Instant::now();
    assert_eq!(runtime.shutdown().unwrap_err(), "shutdownTimeout");
    assert!(stopped_at.elapsed() < Duration::from_millis(2200));
    assert_eq!(runtime.status()["ready"], false);
    assert_eq!(
        runtime
            .on_event(envelope(&dir, "host.events.started", 30, json!({})))
            .unwrap_err(),
        "runtimeStopping"
    );
    db.execute_batch("ROLLBACK").unwrap();
    runtime.shutdown().unwrap();
    started(&runtime, &dir);
    runtime.shutdown().unwrap();
}

#[test]
fn timed_out_pending_command_does_not_later_persist_settings() {
    let dir = TempDir::new().unwrap();
    let runtime = Runtime::new();
    started(&runtime, &dir);
    let db = Connection::open(dir.path().join("clipboard/history.sqlite3")).unwrap();
    db.execute_batch("BEGIN IMMEDIATE").unwrap();
    for seq in 3..20 {
        runtime
            .on_event(envelope(
                &dir,
                "clipboard.changed",
                seq,
                text(&format!("held-{seq}")),
            ))
            .unwrap();
    }
    let result=runtime.invoke(json!({"method":"clipboard_update_settings","pluginDataDir":dir.path(),"payload":{"maxEntries":11}}));
    assert_eq!(result.unwrap_err(), "commandTimeout");
    db.execute_batch("ROLLBACK").unwrap();
    let settings = invoke(&runtime, &dir, "clipboard_get_settings", json!({}));
    assert_eq!(settings["maxEntries"], 500);
    runtime.shutdown().unwrap();
}

#[test]
fn corruption_returns_safe_status_and_started_never_acks_ready() {
    let dir = TempDir::new().unwrap();
    fs::create_dir_all(dir.path().join("clipboard")).unwrap();
    let file = dir.path().join("clipboard/history.sqlite3");
    fs::write(&file, b"private corrupt DB").unwrap();
    let runtime = Runtime::new();
    assert_eq!(
        runtime
            .on_event(envelope(&dir, "host.events.started", 1, json!({})))
            .unwrap_err(),
        "databaseCorrupt"
    );
    assert_eq!(runtime.status()["ready"], false);
    assert_eq!(runtime.status()["lastError"], "databaseCorrupt");
    assert_eq!(fs::read(file).unwrap(), b"private corrupt DB");
    runtime.shutdown().unwrap();
}

#[test]
fn concurrent_shutdown_is_idempotent_and_cannot_spawn_duplicate_writer() {
    let dir = TempDir::new().unwrap();
    let runtime = Arc::new(Runtime::new());
    started(&runtime, &dir);
    for seq in 3..13 {
        runtime
            .on_event(envelope(&dir, "clipboard.changed", seq, text("same")))
            .unwrap();
    }
    let mut joins = vec![];
    for _ in 0..8 {
        let runtime = runtime.clone();
        joins.push(std::thread::spawn(move || runtime.shutdown()));
    }
    for join in joins {
        let result = join.join().unwrap();
        assert!(result.is_ok() || result == Err("runtimeBusy".into()));
    }
    runtime.shutdown().unwrap();
    assert_eq!(runtime.status()["ready"], false);
    started(&runtime, &dir);
    assert_eq!(
        invoke(&runtime, &dir, "clipboard_list", json!({}))["items"][0]["copyCount"],
        10
    );
    runtime.shutdown().unwrap();
}
