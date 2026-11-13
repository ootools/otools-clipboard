use base64::{engine::general_purpose::STANDARD, Engine};
use image::{codecs::png::PngEncoder, ImageEncoder};
use otools_clipboard_native::store::Store;
use rusqlite::Connection;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::fs;
use tempfile::TempDir;

const DAY: u64 = 86_400_000;
const NOW: u64 = 2_000_000_000_000;

// Fixtures derive hashes from the published convention, independently of production helpers.
fn text_payload(text: &str) -> Value {
    let mut digest = Sha256::new();
    digest.update(b"otools:clipboard:text:v1\0");
    digest.update(text.as_bytes());
    json!({"text":{"text":text,"hash":format!("{:x}", digest.finalize())}})
}

fn image_payload(width: u32, height: u32, rgba: &[u8]) -> Value {
    let mut png = Vec::new();
    PngEncoder::new(&mut png)
        .write_image(rgba, width, height, image::ExtendedColorType::Rgba8)
        .unwrap();
    let mut digest = Sha256::new();
    digest.update(b"otools:clipboard:image:v1\0");
    digest.update((width as u64).to_le_bytes());
    digest.update((height as u64).to_le_bytes());
    digest.update(rgba);
    json!({"image":{"pngBase64":STANDARD.encode(png),"width":width,"height":height,"hash":format!("{:x}",digest.finalize())}})
}

fn open() -> (TempDir, Store) {
    let dir = TempDir::new().unwrap();
    let store = Store::open(dir.path(), NOW).expect("storage feature must initialize real SQLite");
    (dir, store)
}

fn command(store: &mut Store, method: &str, payload: Value) -> Value {
    store.command(method, payload, NOW).unwrap()
}

fn list(store: &mut Store) -> Value {
    command(store, "clipboard_list", json!({}))
}

#[test]
fn captures_text_with_bounded_preview_without_list_content() {
    let (_dir, mut store) = open();
    let text = format!("<b>literal</b> {}", "界".repeat(600));
    assert!(store.capture(text_payload(&text), NOW).unwrap());
    let page = list(&mut store);
    assert_eq!(page["total"], 1);
    assert_eq!(page["offset"], 0);
    assert_eq!(page["limit"], 50);
    let item = &page["items"][0];
    assert_eq!(item["kind"], "text");
    assert_eq!(item["byteSize"], text.len());
    assert_eq!(item["createdAt"], NOW);
    assert_eq!(item["lastCopiedAt"], NOW);
    assert_eq!(item["copyCount"], 1);
    assert_eq!(item["pinned"], false);
    assert!(item["preview"].as_str().unwrap().chars().count() <= 256);
    assert!(item.get("text").is_none());
    assert!(item.get("pngBase64").is_none());
    let detail = command(&mut store, "clipboard_get", json!({"id":item["id"]}));
    assert_eq!(detail["text"], text);
}

#[test]
fn dedup_updates_times_count_and_preserves_pin_and_creation() {
    let (_dir, mut store) = open();
    store.capture(text_payload("same"), NOW).unwrap();
    let id = list(&mut store)["items"][0]["id"].clone();
    assert_eq!(
        command(
            &mut store,
            "clipboard_set_pinned",
            json!({"id":id,"pinned":true})
        ),
        json!({"removed":0})
    );
    store.capture(text_payload("same"), NOW + 1234).unwrap();
    let page = list(&mut store);
    assert_eq!(page["total"], 1);
    assert_eq!(page["items"][0]["id"], id);
    assert_eq!(page["items"][0]["createdAt"], NOW);
    assert_eq!(page["items"][0]["lastCopiedAt"], NOW + 1234);
    assert_eq!(page["items"][0]["copyCount"], 2);
    assert_eq!(page["items"][0]["pinned"], true);
}

#[test]
fn captures_both_representations_and_content_addressed_png() {
    let (dir, mut store) = open();
    let mut payload = text_payload("dual");
    let image = image_payload(2, 1, &[255, 0, 0, 255, 0, 255, 0, 128]);
    payload["image"] = image["image"].clone();
    store.capture(payload.clone(), NOW).unwrap();
    store.capture(payload, NOW + 1).unwrap();
    let page = list(&mut store);
    assert_eq!(page["total"], 2);
    let item = page["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|x| x["kind"] == "image")
        .unwrap();
    let file = dir
        .path()
        .join("clipboard/images")
        .join(format!("{}.png", image["image"]["hash"].as_str().unwrap()));
    assert!(file.is_file());
    assert_eq!(item["byteSize"], fs::metadata(file).unwrap().len());
    assert_eq!(item["copyCount"], 2);
    let data = command(&mut store, "clipboard_get_image", json!({"id":item["id"]}));
    assert_eq!(data["width"], 2);
    assert_eq!(data["height"], 1);
    assert!(data["dataUrl"]
        .as_str()
        .unwrap()
        .starts_with("data:image/png;base64,"));
    let detail = command(&mut store, "clipboard_get", json!({"id":item["id"]}));
    assert!(detail.get("text").is_none());
}

#[test]
fn thumbnail_is_bounded_and_keeps_original_metadata() {
    let (_dir, mut store) = open();
    store
        .capture(image_payload(600, 300, &vec![127; 600 * 300 * 4]), NOW)
        .unwrap();
    let id = list(&mut store)["items"][0]["id"].clone();
    let thumbnail = command(
        &mut store,
        "clipboard_get_image",
        json!({"id":id,"thumbnail":true}),
    );
    assert!(thumbnail["width"].as_u64().unwrap() <= 256);
    assert!(thumbnail["height"].as_u64().unwrap() <= 256);
    let bytes = STANDARD
        .decode(
            thumbnail["dataUrl"]
                .as_str()
                .unwrap()
                .split_once(',')
                .unwrap()
                .1,
        )
        .unwrap();
    let decoded = image::load_from_memory(&bytes).unwrap();
    assert_eq!(decoded.width() as u64, thumbnail["width"].as_u64().unwrap());
    assert_eq!(list(&mut store)["items"][0]["width"], 600);
}

#[test]
fn search_filters_pagination_and_literal_like_metacharacters() {
    let (_dir, mut store) = open();
    for (i, text) in ["alpha%_", "alphaXX", "beta"].iter().enumerate() {
        store.capture(text_payload(text), NOW + i as u64).unwrap();
    }
    store
        .capture(image_payload(1, 1, &[0, 0, 0, 255]), NOW + 3)
        .unwrap();
    let id =
        command(&mut store, "clipboard_list", json!({"query":"beta"}))["items"][0]["id"].clone();
    command(
        &mut store,
        "clipboard_set_pinned",
        json!({"id":id,"pinned":true}),
    );
    assert_eq!(
        command(&mut store, "clipboard_list", json!({"query":"%_"}))["total"],
        1
    );
    assert_eq!(
        command(&mut store, "clipboard_list", json!({"kind":"image"}))["total"],
        1
    );
    assert_eq!(
        command(&mut store, "clipboard_list", json!({"pinnedOnly":true}))["total"],
        1
    );
    let page = command(
        &mut store,
        "clipboard_list",
        json!({"kind":"text","offset":1,"limit":1}),
    );
    assert_eq!(page["total"], 3);
    assert_eq!(page["offset"], 1);
    assert_eq!(page["items"].as_array().unwrap().len(), 1);
    assert_eq!(
        command(&mut store, "clipboard_list", json!({"limit":999}))["limit"],
        100
    );
}

#[test]
fn count_cleanup_excludes_pins_and_evicts_oldest_unpinned() {
    let (_dir, mut store) = open();
    command(
        &mut store,
        "clipboard_update_settings",
        json!({"maxEntries":2}),
    );
    store.capture(text_payload("pinned"), NOW).unwrap();
    let id = list(&mut store)["items"][0]["id"].clone();
    command(
        &mut store,
        "clipboard_set_pinned",
        json!({"id":id,"pinned":true}),
    );
    for (i, text) in ["oldest", "middle", "newest"].iter().enumerate() {
        store
            .capture(text_payload(text), NOW + i as u64 + 1)
            .unwrap();
    }
    let page = list(&mut store);
    assert_eq!(page["total"], 3);
    let previews: Vec<_> = page["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|x| x["preview"].as_str().unwrap())
        .collect();
    assert!(previews.contains(&"pinned"));
    assert!(previews.contains(&"newest"));
    assert!(!previews.contains(&"oldest"));
}

#[test]
fn retention_uses_last_copy_and_keeps_pins() {
    let (_dir, mut store) = open();
    command(
        &mut store,
        "clipboard_update_settings",
        json!({"retentionDays":1}),
    );
    store.capture(text_payload("pin"), NOW).unwrap();
    let id = list(&mut store)["items"][0]["id"].clone();
    command(
        &mut store,
        "clipboard_set_pinned",
        json!({"id":id,"pinned":true}),
    );
    store.capture(text_payload("expired"), NOW).unwrap();
    store.capture(text_payload("recent"), NOW).unwrap();
    store.capture(text_payload("recent"), NOW + DAY).unwrap();
    store.maintain(NOW + DAY + 1).unwrap();
    let page = list(&mut store);
    assert_eq!(page["total"], 2);
    assert!(page["items"]
        .as_array()
        .unwrap()
        .iter()
        .all(|x| x["preview"] != "expired"));
}

#[test]
fn byte_budget_counts_pins_and_does_not_destroy_history_on_failed_arrival() {
    let (_dir, mut store) = open();
    command(
        &mut store,
        "clipboard_update_settings",
        json!({"maxBytes":6}),
    );
    store.capture(text_payload("pin"), NOW).unwrap();
    let id = list(&mut store)["items"][0]["id"].clone();
    command(
        &mut store,
        "clipboard_set_pinned",
        json!({"id":id,"pinned":true}),
    );
    store.capture(text_payload("old"), NOW + 1).unwrap();
    let error = store.capture(text_payload("four"), NOW + 2).unwrap_err();
    assert_eq!(error.to_string(), "storageFull");
    assert_eq!(list(&mut store)["total"], 2);
    store.capture(text_payload("new"), NOW + 3).unwrap();
    let page = list(&mut store);
    assert_eq!(page["total"], 2);
    assert!(page["items"]
        .as_array()
        .unwrap()
        .iter()
        .any(|x| x["preview"] == "pin"));
    assert!(!page["items"]
        .as_array()
        .unwrap()
        .iter()
        .any(|x| x["preview"] == "old"));
}

#[test]
fn lowered_capacity_never_evicts_pins() {
    let (_dir, mut store) = open();
    store.capture(text_payload("pinned-data"), NOW).unwrap();
    let id = list(&mut store)["items"][0]["id"].clone();
    command(
        &mut store,
        "clipboard_set_pinned",
        json!({"id":id,"pinned":true}),
    );
    store.capture(text_payload("unpinned"), NOW + 1).unwrap();
    command(
        &mut store,
        "clipboard_update_settings",
        json!({"maxBytes":1}),
    );
    assert_eq!(list(&mut store)["total"], 1);
    assert_eq!(
        store
            .capture(text_payload("x"), NOW + 2)
            .unwrap_err()
            .to_string(),
        "storageFull"
    );
}

#[test]
fn pause_is_persisted_and_direct_capture_obeys_it() {
    let (dir, mut store) = open();
    command(
        &mut store,
        "clipboard_update_settings",
        json!({"paused":true}),
    );
    assert!(!store.capture(text_payload("not recorded"), NOW).unwrap());
    drop(store);
    let mut reopened = Store::open(dir.path(), NOW).unwrap();
    assert_eq!(
        command(&mut reopened, "clipboard_get_settings", json!({}))["paused"],
        true
    );
    assert_eq!(list(&mut reopened)["total"], 0);
}

#[test]
fn clear_defaults_to_unpinned_and_delete_removes_png() {
    let (dir, mut store) = open();
    store.capture(text_payload("keep"), NOW).unwrap();
    let pin = list(&mut store)["items"][0]["id"].clone();
    command(
        &mut store,
        "clipboard_set_pinned",
        json!({"id":pin,"pinned":true}),
    );
    let image = image_payload(1, 1, &[0, 0, 255, 255]);
    let image_hash = image["image"]["hash"].as_str().unwrap().to_owned();
    store.capture(image.clone(), NOW + 1).unwrap();
    let id =
        command(&mut store, "clipboard_list", json!({"kind":"image"}))["items"][0]["id"].clone();
    assert_eq!(
        command(&mut store, "clipboard_delete", json!({"id":id})),
        json!({"removed":1})
    );
    assert!(!dir
        .path()
        .join(format!("clipboard/images/{image_hash}.png"))
        .exists());
    store.capture(image, NOW + 2).unwrap();
    assert_eq!(
        command(&mut store, "clipboard_clear", json!({})),
        json!({"removed":1})
    );
    assert_eq!(list(&mut store)["total"], 1);
    assert_eq!(
        command(&mut store, "clipboard_clear", json!({"includePinned":true})),
        json!({"removed":1})
    );
}

#[test]
fn sqlite_is_wal_and_restart_preserves_history_settings() {
    let (dir, mut store) = open();
    store.capture(text_payload("survives"), NOW).unwrap();
    command(
        &mut store,
        "clipboard_update_settings",
        json!({"maxEntries":17,"retentionDays":2}),
    );
    store.flush().unwrap();
    let db = Connection::open(dir.path().join("clipboard/history.sqlite3")).unwrap();
    assert_eq!(
        db.query_row("PRAGMA journal_mode", [], |r| r.get::<_, String>(0))
            .unwrap(),
        "wal"
    );
    drop(db);
    drop(store);
    let mut reopened = Store::open(dir.path(), NOW).unwrap();
    assert_eq!(list(&mut reopened)["total"], 1);
    assert_eq!(
        command(&mut reopened, "clipboard_get_settings", json!({}))["maxEntries"],
        17
    );
}

#[test]
fn flush_rejects_busy_checkpoint_instead_of_claiming_durable_stop() {
    let (dir, mut store) = open();
    store.capture(text_payload("before reader"), NOW).unwrap();
    let reader = Connection::open(dir.path().join("clipboard/history.sqlite3")).unwrap();
    reader
        .execute_batch("BEGIN; SELECT COUNT(*) FROM history;")
        .unwrap();
    store
        .capture(text_payload("after reader"), NOW + 1)
        .unwrap();
    assert_eq!(store.flush().unwrap_err(), "databaseBusy");
    reader.execute_batch("ROLLBACK").unwrap();
    store.flush().unwrap();
}

#[test]
fn image_reads_verify_content_hash_after_same_dimension_file_corruption() {
    let (dir, mut store) = open();
    let original = image_payload(1, 1, &[255, 0, 0, 255]);
    store.capture(original.clone(), NOW).unwrap();
    let id = list(&mut store)["items"][0]["id"].clone();
    let changed = image_payload(1, 1, &[0, 0, 255, 255]);
    let bytes = STANDARD
        .decode(changed["image"]["pngBase64"].as_str().unwrap())
        .unwrap();
    let file = dir.path().join("clipboard/images").join(format!(
        "{}.png",
        original["image"]["hash"].as_str().unwrap()
    ));
    fs::write(&file, bytes).unwrap();
    assert_eq!(
        store
            .command("clipboard_get_image", json!({"id":id}), NOW)
            .unwrap_err(),
        "hashMismatch"
    );
    assert_eq!(list(&mut store)["total"], 1);
}

#[test]
fn startup_applies_expiry_and_cleans_only_managed_orphans() {
    let (dir, mut store) = open();
    store.capture(text_payload("expires"), NOW).unwrap();
    drop(store);
    let images = dir.path().join("clipboard/images");
    let orphan = images.join(format!("{}.png", "a".repeat(64)));
    fs::write(&orphan, b"unreferenced").unwrap();
    let unrelated = images.join("notes.txt");
    fs::write(&unrelated, b"do not remove").unwrap();
    let mut reopened = Store::open(dir.path(), NOW + 31 * DAY).unwrap();
    assert_eq!(list(&mut reopened)["total"], 0);
    assert!(!orphan.exists());
    assert!(unrelated.exists());
}

#[test]
fn corrupt_database_is_preserved_without_silent_rebuild() {
    let dir = TempDir::new().unwrap();
    fs::create_dir_all(dir.path().join("clipboard")).unwrap();
    let db = dir.path().join("clipboard/history.sqlite3");
    let sentinel = b"not a database; private sentinel";
    fs::write(&db, sentinel).unwrap();
    let error = match Store::open(dir.path(), NOW) {
        Ok(_) => panic!("corruption must be reported"),
        Err(error) => error,
    };
    assert_eq!(error.to_string(), "databaseCorrupt");
    assert_eq!(fs::read(db).unwrap(), sentinel);
}

#[test]
fn zero_length_existing_database_is_not_silently_recreated() {
    let dir = TempDir::new().unwrap();
    fs::create_dir_all(dir.path().join("clipboard")).unwrap();
    let file = dir.path().join("clipboard/history.sqlite3");
    fs::write(&file, []).unwrap();
    let result = Store::open(dir.path(), NOW);
    assert!(result.is_err(), "truncated DB was silently reset");
    assert_eq!(result.err().unwrap(), "databaseCorrupt");
    assert_eq!(fs::metadata(file).unwrap().len(), 0);
}

#[test]
fn missing_history_table_is_corruption_not_permission_to_rebuild() {
    let (dir, mut store) = open();
    store.capture(text_payload("would be lost"), NOW).unwrap();
    store.flush().unwrap();
    drop(store);
    let file = dir.path().join("clipboard/history.sqlite3");
    let db = Connection::open(&file).unwrap();
    db.execute_batch("DROP TABLE history; PRAGMA wal_checkpoint(TRUNCATE)")
        .unwrap();
    drop(db);
    let before = fs::read(&file).unwrap();
    let result = Store::open(dir.path(), NOW);
    assert!(result.is_err(), "missing history was rebuilt as empty");
    assert_eq!(result.err().unwrap(), "databaseCorrupt");
    assert_eq!(fs::read(file).unwrap(), before);
}

#[test]
fn rejects_text_oversize_and_hash_mismatch_without_content_in_errors() {
    let (_dir, mut store) = open();
    let huge = "s".repeat(1024 * 1024 + 1);
    assert_eq!(
        store
            .capture(text_payload(&huge), NOW)
            .unwrap_err()
            .to_string(),
        "textTooLarge"
    );
    let mut bad = text_payload("private captured text");
    bad["text"]["hash"] = json!("0".repeat(64));
    assert_eq!(
        store.capture(bad, NOW).unwrap_err().to_string(),
        "hashMismatch"
    );
    assert_eq!(list(&mut store)["total"], 0);
}

#[test]
fn verifies_image_dimensions_pixels_png_size_and_decoded_hash() {
    let (_dir, mut store) = open();
    let valid = image_payload(1, 1, &[1, 2, 3, 255]);
    let mut dimensions = valid.clone();
    dimensions["image"]["width"] = json!(2);
    assert_eq!(
        store.capture(dimensions, NOW).unwrap_err().to_string(),
        "imageDimensionsMismatch"
    );
    let mut hash = valid.clone();
    hash["image"]["hash"] = json!("0".repeat(64));
    assert_eq!(
        store.capture(hash, NOW).unwrap_err().to_string(),
        "hashMismatch"
    );
    let mut large = valid.clone();
    large["image"]["width"] = json!(16385);
    assert_eq!(
        store.capture(large, NOW).unwrap_err().to_string(),
        "imageTooLarge"
    );
    let mut pixels = valid.clone();
    pixels["image"]["width"] = json!(8192);
    pixels["image"]["height"] = json!(8192);
    assert_eq!(
        store.capture(pixels, NOW).unwrap_err().to_string(),
        "imageTooLarge"
    );
    let mut png = valid;
    png["image"]["pngBase64"] = json!("A".repeat((16 * 1024 * 1024 / 3 + 1) * 4 + 4));
    assert_eq!(
        store.capture(png, NOW).unwrap_err().to_string(),
        "imageTooLarge"
    );
    assert_eq!(list(&mut store)["total"], 0);
}

#[test]
fn validates_actual_png_header_before_decoding_oversized_allocation() {
    let (_dir, mut store) = open();
    let mut payload = image_payload(1, 1, &[1, 2, 3, 4]);
    let mut png = STANDARD
        .decode(payload["image"]["pngBase64"].as_str().unwrap())
        .unwrap();
    png[16..20].copy_from_slice(&20000u32.to_be_bytes());
    payload["image"]["pngBase64"] = json!(STANDARD.encode(png));
    assert_eq!(
        store.capture(payload, NOW).unwrap_err().to_string(),
        "imageTooLarge"
    );
}

#[test]
fn rejects_path_ids_and_bad_settings_with_safe_codes() {
    let (_dir, mut store) = open();
    for id in [
        "../outside",
        "/tmp/private",
        "..\\outside",
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    ] {
        for method in [
            "clipboard_get",
            "clipboard_get_image",
            "clipboard_delete",
            "clipboard_set_pinned",
        ] {
            let result = store.command(method, json!({"id":id,"pinned":true}), NOW);
            assert_eq!(result.unwrap_err().to_string(), "invalidId");
        }
    }
    for payload in [
        json!({"maxEntries":0}),
        json!({"retentionDays":-1}),
        json!({"maxBytes":0}),
        json!({"paused":"yes"}),
    ] {
        assert_eq!(
            store
                .command("clipboard_update_settings", payload, NOW)
                .unwrap_err()
                .to_string(),
            "invalidSettings"
        );
    }
}

#[test]
fn settings_accept_all_positive_js_safe_integers_and_reject_unsafe_values() {
    let (_dir, mut store) = open();
    let maximum = json!({"maxEntries":9007199254740991u64,"retentionDays":9007199254740991u64,"maxBytes":9007199254740991u64});
    assert_eq!(
        command(&mut store, "clipboard_update_settings", maximum.clone()),
        json!({"maxEntries":9007199254740991u64,"retentionDays":9007199254740991u64,"maxBytes":9007199254740991u64,"paused":false})
    );
    for field in ["maxEntries", "retentionDays", "maxBytes"] {
        for value in [json!(9007199254740992u64), json!(1.5)] {
            let mut input = json!({});
            input[field] = value;
            assert_eq!(
                store
                    .command("clipboard_update_settings", input, NOW)
                    .unwrap_err(),
                "invalidSettings"
            );
        }
    }
}

#[cfg(unix)]
#[test]
fn refuses_symlinked_storage_and_image_paths() {
    use std::os::unix::fs::symlink;
    let dir = TempDir::new().unwrap();
    let outside = TempDir::new().unwrap();
    symlink(outside.path(), dir.path().join("clipboard")).unwrap();
    assert!(Store::open(dir.path(), NOW).is_err());
    let (dir, mut store) = open();
    let image = image_payload(1, 1, &[4, 3, 2, 1]);
    store.capture(image.clone(), NOW).unwrap();
    let id = list(&mut store)["items"][0]["id"].clone();
    let file = dir
        .path()
        .join("clipboard/images")
        .join(format!("{}.png", image["image"]["hash"].as_str().unwrap()));
    fs::remove_file(&file).unwrap();
    let sentinel = outside.path().join("sentinel");
    fs::write(&sentinel, b"private").unwrap();
    symlink(&sentinel, &file).unwrap();
    assert_eq!(
        store
            .command("clipboard_get_image", json!({"id":id}), NOW)
            .unwrap_err()
            .to_string(),
        "invalidPath"
    );
    assert_eq!(fs::read(sentinel).unwrap(), b"private");
}
