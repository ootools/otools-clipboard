use crate::content::{decode_png, normalize};
use crate::protocol::{
    valid_hash, validate_id, HistoryItem, ListParams, Result, Settings, MAX_PNG_BYTES,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use image::{codecs::png::PngEncoder, ImageEncoder};
use rusqlite::{params, Connection, ErrorCode, OptionalExtension, Row, Transaction};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;
use uuid::Uuid;

const DAY_MS: u64 = 86_400_000;
const FIELDS: &str =
    "id,kind,hash,preview,byte_size,width,height,created_at,last_copied_at,copy_count,pinned";

fn database_error(error: rusqlite::Error) -> String {
    match error.sqlite_error_code() {
        Some(ErrorCode::DatabaseCorrupt | ErrorCode::NotADatabase) => "databaseCorrupt",
        Some(ErrorCode::DatabaseBusy | ErrorCode::DatabaseLocked) => "databaseBusy",
        Some(ErrorCode::DiskFull) => "storageFull",
        _ => "databaseError",
    }
    .into()
}

fn safe_dir(path: &Path) -> Result<()> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_symlink() || !metadata.is_dir() => Err("invalidPath".into()),
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir(path).map_err(|_| "storageIo".to_owned())
        }
        Err(_) => Err("storageIo".into()),
    }
}

fn safe_file(path: &Path) -> Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_symlink() || !metadata.is_file() => Err("invalidPath".into()),
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(_) => Err("storageIo".into()),
    }
}

fn item(row: &Row<'_>) -> rusqlite::Result<HistoryItem> {
    Ok(HistoryItem {
        id: row.get(0)?,
        kind: row.get(1)?,
        hash: row.get(2)?,
        preview: row.get(3)?,
        byte_size: row.get(4)?,
        width: row.get(5)?,
        height: row.get(6)?,
        created_at: row.get(7)?,
        last_copied_at: row.get(8)?,
        copy_count: row.get(9)?,
        pinned: row.get(10)?,
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct IdParams {
    id: String,
    #[serde(default)]
    pinned: Option<bool>,
    #[serde(default)]
    thumbnail: bool,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ClearParams {
    #[serde(default)]
    include_pinned: bool,
}

pub struct Store {
    db: Connection,
    images: PathBuf,
    settings: Settings,
}

impl Store {
    pub fn open(plugin_data_dir: &Path, now: u64) -> Result<Self> {
        if !plugin_data_dir.is_absolute() {
            return Err("invalidDataDir".into());
        }
        fs::create_dir_all(plugin_data_dir).map_err(|_| "storageIo")?;
        let canonical = fs::canonicalize(plugin_data_dir).map_err(|_| "invalidDataDir")?;
        let root = canonical.join("clipboard");
        safe_dir(&root)?;
        let images = root.join("images");
        safe_dir(&images)?;
        let db_path = root.join("history.sqlite3");
        let existing = safe_file(&db_path)?;
        if existing && fs::metadata(&db_path).map_err(|_| "storageIo")?.len() < 100 {
            return Err("databaseCorrupt".into());
        }
        safe_file(&root.join("history.sqlite3-wal"))?;
        safe_file(&root.join("history.sqlite3-shm"))?;
        let db = Connection::open(&db_path).map_err(database_error)?;
        db.busy_timeout(Duration::from_secs(1))
            .map_err(database_error)?;
        if existing {
            let check: String = db
                .query_row("PRAGMA quick_check", [], |row| row.get(0))
                .map_err(database_error)?;
            if check != "ok" {
                return Err("databaseCorrupt".into());
            }
        }
        let version: u64 = db
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .map_err(database_error)?;
        if version > 1 {
            return Err("unsupportedDatabaseVersion".into());
        }
        if existing {
            if version != 1 {
                return Err("databaseCorrupt".into());
            }
            db.prepare(&format!("SELECT {FIELDS},text FROM history LIMIT 0"))
                .map_err(|_| "databaseCorrupt")?;
            db.prepare("SELECT max_entries,retention_days,max_bytes,paused FROM settings WHERE singleton=1").map_err(|_| "databaseCorrupt")?;
        }
        db.execute_batch(
            "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;",
        )
        .map_err(database_error)?;
        if !existing {
            db.execute_batch(
                "BEGIN IMMEDIATE;
             CREATE TABLE settings (
                 singleton INTEGER PRIMARY KEY CHECK(singleton=1),
                 max_entries INTEGER NOT NULL, retention_days INTEGER NOT NULL,
                 max_bytes INTEGER NOT NULL, paused INTEGER NOT NULL CHECK(paused IN (0,1))
             );
             CREATE TABLE history (
                 id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('text','image')),
                 hash TEXT NOT NULL, text TEXT, preview TEXT NOT NULL,
                 byte_size INTEGER NOT NULL CHECK(byte_size>=0), width INTEGER, height INTEGER,
                 created_at INTEGER NOT NULL, last_copied_at INTEGER NOT NULL,
                 copy_count INTEGER NOT NULL CHECK(copy_count>=1),
                 pinned INTEGER NOT NULL CHECK(pinned IN (0,1)), UNIQUE(kind,hash)
             );
             CREATE INDEX history_recency ON history(pinned,last_copied_at);
             INSERT INTO settings VALUES (1,500,30,268435456,0);
             PRAGMA user_version=1;
             COMMIT;",
            )
            .map_err(database_error)?;
        }
        let settings = db
            .query_row("SELECT max_entries,retention_days,max_bytes,paused FROM settings WHERE singleton=1", [], |row| {
                Ok(Settings { max_entries: row.get(0)?, retention_days: row.get(1)?, max_bytes: row.get(2)?, paused: row.get(3)? })
            })
            .map_err(database_error)?;
        // Invalid settings are evidence of a damaged or incompatible DB, not a reset request.
        settings.updated(json!({})).map_err(|_| "databaseCorrupt")?;
        let mut store = Self {
            db,
            images,
            settings,
        };
        store.maintain(now)?;
        Ok(store)
    }

    pub fn settings(&self) -> &Settings {
        &self.settings
    }

    pub fn stats(&self) -> Result<(u64, u64)> {
        self.db
            .query_row(
                "SELECT COUNT(*),COALESCE(SUM(byte_size),0) FROM history",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .map_err(database_error)
    }

    pub fn capture(&mut self, payload: Value, now: u64) -> Result<bool> {
        if self.settings.paused {
            return Ok(false);
        }
        let captures = normalize(payload)?;
        if captures.is_empty() {
            return self.maintain(now);
        }
        self.maintain(now)?;
        let transaction = self.db.transaction().map_err(database_error)?;
        let pinned_bytes: u64 = transaction
            .query_row(
                "SELECT COALESCE(SUM(byte_size),0) FROM history WHERE pinned=1",
                [],
                |row| row.get(0),
            )
            .map_err(database_error)?;
        let mut new_bytes = 0u64;
        for capture in &captures {
            let exists: bool = transaction
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM history WHERE kind=?1 AND hash=?2)",
                    params![capture.kind, capture.hash],
                    |row| row.get(0),
                )
                .map_err(database_error)?;
            if !exists {
                new_bytes = new_bytes
                    .checked_add(capture.byte_size)
                    .ok_or("storageFull")?;
            }
        }
        if new_bytes > 0 && pinned_bytes.saturating_add(new_bytes) > self.settings.max_bytes {
            return Err("storageFull".into());
        }
        for capture in &captures {
            if let Some(png) = &capture.png {
                Self::atomic_image(&self.images, &capture.hash, png)?;
            }
            transaction.execute(
                "INSERT INTO history (id,kind,hash,text,preview,byte_size,width,height,created_at,last_copied_at,copy_count,pinned)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?9,1,0)
                 ON CONFLICT(kind,hash) DO UPDATE SET
                    last_copied_at=MAX(history.last_copied_at,excluded.last_copied_at),
                    copy_count=MIN(history.copy_count+1,9007199254740991)",
                params![Uuid::new_v4().to_string(),capture.kind,capture.hash,capture.text,capture.preview,
                        capture.byte_size,capture.width,capture.height,now.min(i64::MAX as u64)],
            ).map_err(database_error)?;
        }
        Self::cleanup_transaction(&transaction, &self.settings, now)?;
        transaction.commit().map_err(database_error)?;
        self.cleanup_orphans()?;
        Ok(true)
    }

    fn atomic_image(images: &Path, hash: &str, png: &[u8]) -> Result<()> {
        if !valid_hash(hash) {
            return Err("invalidHash".into());
        }
        safe_dir(images)?;
        let destination = images.join(format!("{hash}.png"));
        if safe_file(&destination)? {
            // A committed content-addressed resource is immutable; do not overwrite it.
            return Ok(());
        }
        let temporary = images.join(format!(".tmp-{}.png", Uuid::new_v4()));
        let outcome = (|| {
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temporary)
                .map_err(|_| "storageIo")?;
            file.write_all(png).map_err(|_| "storageIo")?;
            file.sync_all().map_err(|_| "storageIo")?;
            drop(file);
            fs::rename(&temporary, &destination).map_err(|_| "storageIo")?;
            #[cfg(unix)]
            File::open(images)
                .and_then(|dir| dir.sync_all())
                .map_err(|_| "storageIo")?;
            Ok(())
        })();
        if outcome.is_err() {
            let _ = fs::remove_file(&temporary);
        }
        outcome
    }

    fn cleanup_transaction(
        transaction: &Transaction<'_>,
        settings: &Settings,
        now: u64,
    ) -> Result<bool> {
        let cutoff = now.saturating_sub(settings.retention_days.saturating_mul(DAY_MS));
        let mut removed = transaction
            .execute(
                "DELETE FROM history WHERE pinned=0 AND last_copied_at<?1",
                [cutoff],
            )
            .map_err(database_error)?;
        let unpinned: u64 = transaction
            .query_row("SELECT COUNT(*) FROM history WHERE pinned=0", [], |row| {
                row.get(0)
            })
            .map_err(database_error)?;
        if unpinned > settings.max_entries {
            removed += transaction.execute(
                "DELETE FROM history WHERE id IN (SELECT id FROM history WHERE pinned=0 ORDER BY last_copied_at ASC,created_at ASC,id ASC LIMIT ?1)",
                [unpinned - settings.max_entries],
            ).map_err(database_error)?;
        }
        let mut total: u64 = transaction
            .query_row(
                "SELECT COALESCE(SUM(byte_size),0) FROM history",
                [],
                |row| row.get(0),
            )
            .map_err(database_error)?;
        if total > settings.max_bytes {
            let oldest: Vec<(String, u64)> = {
                let mut statement = transaction.prepare("SELECT id,byte_size FROM history WHERE pinned=0 ORDER BY last_copied_at ASC,created_at ASC,id ASC").map_err(database_error)?;
                let rows = statement
                    .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
                    .map_err(database_error)?;
                rows.collect::<std::result::Result<_, _>>()
                    .map_err(database_error)?
            };
            for (id, size) in oldest {
                if total <= settings.max_bytes {
                    break;
                }
                removed += transaction
                    .execute("DELETE FROM history WHERE id=?1", [id])
                    .map_err(database_error)?;
                total = total.saturating_sub(size);
            }
        }
        Ok(removed > 0)
    }

    fn cleanup_orphans(&self) -> Result<()> {
        safe_dir(&self.images)?;
        let referenced: HashSet<String> = {
            let mut statement = self
                .db
                .prepare("SELECT hash FROM history WHERE kind='image'")
                .map_err(database_error)?;
            let rows = statement
                .query_map([], |row| row.get(0))
                .map_err(database_error)?;
            rows.collect::<std::result::Result<_, _>>()
                .map_err(database_error)?
        };
        for entry in fs::read_dir(&self.images).map_err(|_| "storageIo")? {
            let entry = entry.map_err(|_| "storageIo")?;
            let file_type = entry.file_type().map_err(|_| "storageIo")?;
            if !file_type.is_file() || file_type.is_symlink() {
                continue;
            }
            let name = entry.file_name();
            let Some(name) = name.to_str() else { continue };
            let stale_image = name
                .strip_suffix(".png")
                .is_some_and(|hash| valid_hash(hash) && !referenced.contains(hash));
            let owned_temporary = name
                .strip_prefix(".tmp-")
                .and_then(|x| x.strip_suffix(".png"))
                .is_some_and(|id| validate_id(id).is_ok());
            if stale_image || owned_temporary {
                fs::remove_file(entry.path()).map_err(|_| "storageIo")?;
            }
        }
        Ok(())
    }

    pub fn maintain(&mut self, now: u64) -> Result<bool> {
        let transaction = self.db.transaction().map_err(database_error)?;
        let changed = Self::cleanup_transaction(&transaction, &self.settings, now)?;
        transaction.commit().map_err(database_error)?;
        self.cleanup_orphans()?;
        Ok(changed)
    }

    pub fn flush(&mut self) -> Result<()> {
        let busy: u32 = self
            .db
            .query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |row| row.get(0))
            .map_err(database_error)?;
        if busy != 0 {
            return Err("databaseBusy".into());
        }
        Ok(())
    }

    pub fn command(&mut self, method: &str, payload: Value, now: u64) -> Result<Value> {
        match method {
            "clipboard_list" => self.list(payload),
            "clipboard_get"
            | "clipboard_get_image"
            | "clipboard_set_pinned"
            | "clipboard_delete" => {
                let arguments: IdParams =
                    serde_json::from_value(payload).map_err(|_| "invalidPayload")?;
                validate_id(&arguments.id)?;
                match method {
                    "clipboard_get" => self.get(&arguments.id),
                    "clipboard_get_image" => self.get_image(&arguments.id, arguments.thumbnail),
                    "clipboard_set_pinned" => {
                        let pinned = arguments.pinned.ok_or("invalidPayload")?;
                        let affected = self
                            .db
                            .execute(
                                "UPDATE history SET pinned=?1 WHERE id=?2",
                                params![pinned, arguments.id],
                            )
                            .map_err(database_error)?;
                        if affected == 0 {
                            return Err("notFound".into());
                        }
                        self.maintain(now)?;
                        Ok(json!({"removed":0}))
                    }
                    _ => {
                        let removed = self
                            .db
                            .execute("DELETE FROM history WHERE id=?1", [arguments.id])
                            .map_err(database_error)?;
                        self.cleanup_orphans()?;
                        Ok(json!({"removed":removed}))
                    }
                }
            }
            "clipboard_clear" => {
                let arguments: ClearParams =
                    serde_json::from_value(payload).map_err(|_| "invalidPayload")?;
                let removed = self
                    .db
                    .execute(
                        "DELETE FROM history WHERE ?1 OR pinned=0",
                        [arguments.include_pinned],
                    )
                    .map_err(database_error)?;
                self.cleanup_orphans()?;
                Ok(json!({"removed":removed}))
            }
            "clipboard_get_settings" => {
                serde_json::to_value(&self.settings).map_err(|_| "serializeError".into())
            }
            "clipboard_update_settings" => {
                let next = self.settings.updated(payload)?;
                let transaction = self.db.transaction().map_err(database_error)?;
                transaction.execute("UPDATE settings SET max_entries=?1,retention_days=?2,max_bytes=?3,paused=?4 WHERE singleton=1",
                    params![next.max_entries,next.retention_days,next.max_bytes,next.paused]).map_err(database_error)?;
                Self::cleanup_transaction(&transaction, &next, now)?;
                transaction.commit().map_err(database_error)?;
                self.settings = next;
                self.cleanup_orphans()?;
                serde_json::to_value(&self.settings).map_err(|_| "serializeError".into())
            }
            _ => Err("unknownMethod".into()),
        }
    }

    fn list(&self, payload: Value) -> Result<Value> {
        let arguments: ListParams =
            serde_json::from_value(payload).map_err(|_| "invalidPayload")?;
        let kind = arguments.kind.unwrap_or_else(|| "all".into());
        if !matches!(kind.as_str(), "all" | "text" | "image") {
            return Err("invalidFilter".into());
        }
        let query = arguments.query.unwrap_or_default();
        if query.len() > 4096 {
            return Err("queryTooLarge".into());
        }
        let offset = arguments.offset.unwrap_or(0).min(9_007_199_254_740_991);
        let limit = arguments.limit.unwrap_or(50).clamp(1, 100);
        let pinned = arguments.pinned_only.unwrap_or(false);
        let filter="(?1='all' OR kind=?1) AND (?2=0 OR pinned=1) AND (?3='' OR (kind='text' AND INSTR(LOWER(text),LOWER(?3))>0))";
        let total: u64 = self
            .db
            .query_row(
                &format!("SELECT COUNT(*) FROM history WHERE {filter}"),
                params![kind, pinned, query],
                |row| row.get(0),
            )
            .map_err(database_error)?;
        let mut statement=self.db.prepare(&format!("SELECT {FIELDS} FROM history WHERE {filter} ORDER BY pinned DESC,last_copied_at DESC,id ASC LIMIT ?4 OFFSET ?5")).map_err(database_error)?;
        let rows = statement
            .query_map(params![kind, pinned, query, limit, offset], item)
            .map_err(database_error)?;
        let items: Vec<HistoryItem> = rows
            .collect::<std::result::Result<_, _>>()
            .map_err(database_error)?;
        Ok(json!({"items":items,"total":total,"offset":offset,"limit":limit}))
    }

    fn record(&self, id: &str) -> Result<HistoryItem> {
        self.db
            .query_row(
                &format!("SELECT {FIELDS} FROM history WHERE id=?1"),
                [id],
                item,
            )
            .optional()
            .map_err(database_error)?
            .ok_or_else(|| "notFound".into())
    }

    fn get(&self, id: &str) -> Result<Value> {
        let record = self.record(id)?;
        let mut value = serde_json::to_value(&record).map_err(|_| "serializeError")?;
        if record.kind == "text" {
            let text: String = self
                .db
                .query_row("SELECT text FROM history WHERE id=?1", [id], |row| {
                    row.get(0)
                })
                .map_err(database_error)?;
            value["text"] = json!(text);
        }
        Ok(value)
    }

    fn get_image(&self, id: &str, thumbnail: bool) -> Result<Value> {
        let record = self.record(id)?;
        if record.kind != "image" {
            return Err("notImage".into());
        }
        if !valid_hash(&record.hash) {
            return Err("invalidHash".into());
        }
        safe_dir(&self.images)?;
        let file = self.images.join(format!("{}.png", record.hash));
        if !safe_file(&file)? {
            return Err("imageMissing".into());
        }
        let mut png = Vec::new();
        File::open(file)
            .map_err(|_| "storageIo")?
            .take((MAX_PNG_BYTES + 1) as u64)
            .read_to_end(&mut png)
            .map_err(|_| "storageIo")?;
        let decoded = decode_png(&png)?;
        if Some(decoded.width()) != record.width || Some(decoded.height()) != record.height {
            return Err("imageDimensionsMismatch".into());
        }
        let rgba = decoded.to_rgba8();
        let mut digest = Sha256::new();
        digest.update(b"otools:clipboard:image:v1\0");
        digest.update(u64::from(decoded.width()).to_le_bytes());
        digest.update(u64::from(decoded.height()).to_le_bytes());
        digest.update(rgba.as_raw());
        if format!("{:x}", digest.finalize()) != record.hash {
            return Err("hashMismatch".into());
        }
        let (bytes, width, height) = if thumbnail {
            let small = decoded.thumbnail(256, 256).to_rgba8();
            let mut bytes = Vec::new();
            PngEncoder::new(&mut bytes)
                .write_image(
                    small.as_raw(),
                    small.width(),
                    small.height(),
                    image::ExtendedColorType::Rgba8,
                )
                .map_err(|_| "imageEncodingError")?;
            (bytes, small.width(), small.height())
        } else {
            (png, decoded.width(), decoded.height())
        };
        Ok(
            json!({"dataUrl":format!("data:image/png;base64,{}",STANDARD.encode(bytes)),"width":width,"height":height}),
        )
    }
}
