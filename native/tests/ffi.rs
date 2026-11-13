use base64::{engine::general_purpose::STANDARD, Engine};
use image::{codecs::png::PngEncoder, ImageEncoder};
use otools_clipboard_native::{
    ffi, otools_plugin_free, otools_plugin_invoke, otools_plugin_on_event,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{ptr, sync::Mutex};
use tempfile::TempDir;

static FFI_LOCK: Mutex<()> = Mutex::new(());
type Entry = extern "C" fn(*const u8, usize, *mut usize) -> *mut u8;

fn call(entry: Entry, input: Value) -> Value {
    let bytes = serde_json::to_vec(&input).unwrap();
    call_bytes(entry, &bytes)
}
fn call_bytes(entry: Entry, bytes: &[u8]) -> Value {
    let mut len = 0;
    let ptr = entry(bytes.as_ptr(), bytes.len(), &mut len);
    assert!(!ptr.is_null());
    assert!(len > 0);
    let value = serde_json::from_slice(unsafe { std::slice::from_raw_parts(ptr, len) }).unwrap();
    otools_plugin_free(ptr, len);
    value
}
fn event(dir: &TempDir, topic: &str, seq: u64, payload: Value) -> Value {
    json!({"schemaVersion":1,"topic":topic,"sessionId":"ffi-test","seq":seq,"timestamp":2_000_000_000_000u64,"pluginDir":"/plugin-install","pluginDataDir":dir.path(),"payload":payload})
}
fn invoke(dir: &TempDir, method: &str, payload: Value) -> Value {
    call(
        otools_plugin_invoke,
        json!({"pluginDataDir":dir.path(),"method":method,"payload":payload}),
    )
}

#[test]
fn ffi_started_capture_list_pause_stopped_and_reserved_shutdown_use_standard_buffers() {
    let _guard = FFI_LOCK.lock().unwrap_or_else(|error| error.into_inner());
    call(
        otools_plugin_invoke,
        json!({"method":"__otools_shutdown__"}),
    );
    let dir = TempDir::new().unwrap();
    assert_eq!(
        call(
            otools_plugin_on_event,
            event(&dir, "host.events.started", 1, json!({}))
        ),
        json!({"ok":true,"data":{"accepted":true}})
    );
    call(
        otools_plugin_on_event,
        event(
            &dir,
            "host.events.status",
            2,
            json!({"source":"clipboard","state":"ready"}),
        ),
    );
    let mut text_hash = Sha256::new();
    text_hash.update(b"otools:clipboard:text:v1\0");
    text_hash.update(b"FFI literal");
    let rgba = [255, 0, 0, 255];
    let mut png = vec![];
    PngEncoder::new(&mut png)
        .write_image(&rgba, 1, 1, image::ExtendedColorType::Rgba8)
        .unwrap();
    let mut image_hash = Sha256::new();
    image_hash.update(b"otools:clipboard:image:v1\0");
    image_hash.update(1u64.to_le_bytes());
    image_hash.update(1u64.to_le_bytes());
    image_hash.update(rgba);
    let payload = json!({"text":{"text":"FFI literal","hash":format!("{:x}",text_hash.finalize())},"image":{"pngBase64":STANDARD.encode(png),"width":1,"height":1,"hash":format!("{:x}",image_hash.finalize())}});
    assert_eq!(
        call(
            otools_plugin_on_event,
            event(&dir, "clipboard.changed", 3, payload)
        ),
        json!({"ok":true,"data":{"accepted":true}})
    );
    let page = invoke(&dir, "clipboard_list", json!({}));
    assert_eq!(page["ok"], true);
    assert_eq!(page["data"]["total"], 2);
    assert!(page["data"]["items"]
        .as_array()
        .unwrap()
        .iter()
        .all(|x| x.get("pngBase64").is_none() && x.get("text").is_none()));
    assert_eq!(
        invoke(&dir, "clipboard_update_settings", json!({"paused":true}))["data"]["paused"],
        true
    );
    assert_eq!(
        invoke(&dir, "clipboard_status", json!({}))["data"]["recording"],
        false
    );
    assert_eq!(
        call(
            otools_plugin_on_event,
            event(&dir, "host.events.stopped", 4, json!({}))
        ),
        json!({"ok":true,"data":{"accepted":true}})
    );
    assert_eq!(
        invoke(&dir, "clipboard_list", json!({}))["data"]["total"],
        2
    );
    assert_eq!(
        invoke(&dir, "__otools_shutdown__", json!({})),
        json!({"ok":true,"data":{"stopped":true}})
    );
}

#[test]
fn invalid_json_and_unknown_method_never_echo_captured_input() {
    let _guard = FFI_LOCK.lock().unwrap_or_else(|error| error.into_inner());
    for entry in [
        otools_plugin_invoke as Entry,
        otools_plugin_on_event as Entry,
    ] {
        let reply = call_bytes(entry, b"private clipboard not JSON");
        assert_eq!(reply, json!({"ok":false,"error":"invalidRequest"}));
        assert!(!reply.to_string().contains("private"));
    }
    assert_eq!(
        call(
            otools_plugin_invoke,
            json!({"method":"PRIVATE clipboard user text","payload":{}})
        ),
        json!({"ok":false,"error":"unknownMethod"})
    );
}

#[test]
fn rejects_null_and_over_limit_buffers_before_reading_them() {
    let _guard = FFI_LOCK.lock().unwrap_or_else(|error| error.into_inner());
    for entry in [
        otools_plugin_invoke as Entry,
        otools_plugin_on_event as Entry,
    ] {
        let mut len = 999;
        assert!(entry(ptr::null(), 0, &mut len).is_null());
        assert_eq!(len, 0);
        assert!(entry(b"{}".as_ptr(), 2, ptr::null_mut()).is_null());
        let ptr = entry(b"x".as_ptr(), usize::MAX, &mut len);
        assert!(!ptr.is_null());
        let reply: Value =
            serde_json::from_slice(unsafe { std::slice::from_raw_parts(ptr, len) }).unwrap();
        assert_eq!(reply, json!({"ok":false,"error":"requestTooLarge"}));
        otools_plugin_free(ptr, len);
    }
    otools_plugin_free(ptr::null_mut(), 0);
}

#[test]
fn panic_guard_redacts_panic_payload_and_keeps_free_ownership() {
    let _guard = FFI_LOCK.lock().unwrap_or_else(|error| error.into_inner());
    let mut len = 0;
    let ptr = ffi::guarded(b"{}".as_ptr(), 2, &mut len, |_| -> Result<Value, String> {
        panic!("PRIVATE clipboard panic content")
    });
    assert!(!ptr.is_null());
    let reply: Value =
        serde_json::from_slice(unsafe { std::slice::from_raw_parts(ptr, len) }).unwrap();
    assert_eq!(reply, json!({"ok":false,"error":"internalError"}));
    otools_plugin_free(ptr, len);
}

#[test]
fn permits_bounded_dual_representation_json_over_24mib_before_decoding() {
    let _guard = FFI_LOCK.lock().unwrap_or_else(|error| error.into_inner());
    // Worst-case escaped 1MiB text + base64 for 16MiB PNG fits the host 32MiB
    // envelope budget, but exceeds the initial 24MiB plugin boundary.
    let bytes = vec![b' '; 28 * 1024 * 1024];
    let mut len = 0;
    let ptr = ffi::guarded(bytes.as_ptr(), bytes.len(), &mut len, |_| {
        Ok(json!({"ok":true,"data":{"accepted":true}}))
    });
    assert!(!ptr.is_null());
    let reply: Value =
        serde_json::from_slice(unsafe { std::slice::from_raw_parts(ptr, len) }).unwrap();
    assert_eq!(reply, json!({"ok":true,"data":{"accepted":true}}));
    otools_plugin_free(ptr, len);
}

#[test]
fn panic_guard_does_not_print_payload_to_stderr() {
    if std::env::var_os("OTOOLS_CLIPBOARD_PANIC_CHILD").is_some() {
        let mut len = 0;
        let ptr = ffi::guarded(b"{}".as_ptr(), 2, &mut len, |_| -> Result<Value, String> {
            panic!("PRIVATE_PANIC_LOG_SENTINEL")
        });
        otools_plugin_free(ptr, len);
        return;
    }
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "panic_guard_does_not_print_payload_to_stderr",
            "--nocapture",
        ])
        .env("OTOOLS_CLIPBOARD_PANIC_CHILD", "1")
        .output()
        .unwrap();
    assert!(output.status.success());
    assert!(
        !String::from_utf8_lossy(&output.stderr).contains("PRIVATE_PANIC_LOG_SENTINEL"),
        "panic payload was written to process stderr"
    );
}

#[test]
fn many_variable_size_replies_can_be_read_and_freed() {
    let _guard = FFI_LOCK.lock().unwrap_or_else(|error| error.into_inner());
    for size in [0, 1, 2, 31, 128, 1024, 8192, 65536] {
        let mut len = 0;
        let text = "x".repeat(size);
        let ptr = ffi::guarded(b"{}".as_ptr(), 2, &mut len, |_| {
            Ok(json!({"ok":true,"data":{"text":text}}))
        });
        assert!(!ptr.is_null());
        let reply: Value =
            serde_json::from_slice(unsafe { std::slice::from_raw_parts(ptr, len) }).unwrap();
        assert_eq!(reply["data"]["text"].as_str().unwrap().len(), size);
        otools_plugin_free(ptr, len);
    }
}
