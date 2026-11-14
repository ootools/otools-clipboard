use serde::{Deserialize, Serialize};
use serde_json::Value;

pub type Result<T> = std::result::Result<T, String>;

pub const MAX_TEXT_BYTES: usize = 1024 * 1024;
pub const MAX_PNG_BYTES: usize = 16 * 1024 * 1024;
pub const MAX_DIMENSION: u32 = 16_384;
pub const MAX_PIXELS: u64 = 32_000_000;
pub const PREVIEW_CHARS: usize = 256;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub max_entries: u64,
    pub retention_days: u64,
    pub max_bytes: u64,
    pub paused: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            max_entries: 500,
            retention_days: 30,
            max_bytes: 268_435_456,
            paused: false,
        }
    }
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SettingsUpdate {
    pub max_entries: Option<u64>,
    pub retention_days: Option<u64>,
    pub max_bytes: Option<u64>,
    pub paused: Option<bool>,
}

impl Settings {
    pub fn updated(&self, value: Value) -> Result<Self> {
        let update: SettingsUpdate =
            serde_json::from_value(value).map_err(|_| "invalidSettings".to_owned())?;
        let next = Self {
            max_entries: update.max_entries.unwrap_or(self.max_entries),
            retention_days: update.retention_days.unwrap_or(self.retention_days),
            max_bytes: update.max_bytes.unwrap_or(self.max_bytes),
            paused: update.paused.unwrap_or(self.paused),
        };
        const JS_SAFE_MAX: u64 = 9_007_199_254_740_991;
        if !(1..=JS_SAFE_MAX).contains(&next.max_entries)
            || !(1..=JS_SAFE_MAX).contains(&next.retention_days)
            || !(1..=JS_SAFE_MAX).contains(&next.max_bytes)
        {
            return Err("invalidSettings".into());
        }
        Ok(next)
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryItem {
    pub id: String,
    pub kind: String,
    pub hash: String,
    pub preview: String,
    pub byte_size: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
    pub created_at: u64,
    pub last_copied_at: u64,
    pub copy_count: u64,
    pub pinned: bool,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ListParams {
    pub query: Option<String>,
    pub kind: Option<String>,
    pub pinned_only: Option<bool>,
    pub offset: Option<u64>,
    pub limit: Option<u64>,
    /// Optional half-open `last_copied_at` window `[from, until)` in Unix ms.
    /// Both bounds must be provided together; see `Store::list`.
    pub from: Option<u64>,
    pub until: Option<u64>,
}

pub fn valid_hash(hash: &str) -> bool {
    hash.len() == 64
        && hash
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

pub fn validate_id(id: &str) -> Result<()> {
    if uuid::Uuid::parse_str(id)
        .ok()
        .is_some_and(|parsed| parsed.to_string() == id)
    {
        Ok(())
    } else {
        Err("invalidId".into())
    }
}

pub fn unix_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_millis().min(i64::MAX as u128) as u64)
        .unwrap_or(0)
}
