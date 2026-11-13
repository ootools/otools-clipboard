use crate::protocol::{unix_millis, Result, Settings};
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    mpsc::Sender,
    Condvar, Mutex,
};
use std::time::{Duration, Instant};

pub const MAX_QUEUED_EVENTS: usize = 64;
pub const MAX_QUEUED_BYTES: usize = 32 * 1024 * 1024;
const MAX_QUEUED_COMMANDS: usize = 32;

pub struct Admission {
    pub active: AtomicBool,
    pub paused: AtomicBool,
    pub epoch: AtomicU64,
    pub resumed_at: AtomicU64,
    pub dropped: AtomicU64,
}

impl Default for Admission {
    fn default() -> Self {
        Self {
            active: AtomicBool::new(false),
            paused: AtomicBool::new(false),
            epoch: AtomicU64::new(0),
            resumed_at: AtomicU64::new(0),
            dropped: AtomicU64::new(0),
        }
    }
}

pub struct CaptureEvent {
    pub payload: Value,
    pub timestamp: u64,
    pub epoch: u64,
    bytes: usize,
}

pub struct Command {
    pub method: String,
    pub payload: Value,
    pub deadline: Instant,
    pub cancelled: std::sync::Arc<AtomicBool>,
    pub response: Sender<Result<Value>>,
    pub pause_epoch: Option<u64>,
}

pub enum Work {
    Capture(CaptureEvent),
    Command(Command),
    Stop(Sender<Result<Value>>),
}

#[derive(Default)]
struct Queue {
    work: VecDeque<Work>,
    event_count: usize,
    event_bytes: usize,
    command_count: usize,
    stopping: bool,
}

#[derive(Default)]
pub struct Mailbox {
    queue: Mutex<Queue>,
    wake: Condvar,
}

fn payload_bytes(value: &Value) -> usize {
    match value {
        Value::String(text) => text.len().saturating_add(16),
        Value::Array(values) => values
            .iter()
            .fold(16usize, |n, value| n.saturating_add(payload_bytes(value))),
        Value::Object(object) => object.iter().fold(32usize, |n, (key, value)| {
            n.saturating_add(key.len())
                .saturating_add(payload_bytes(value))
        }),
        _ => 16,
    }
}

impl Mailbox {
    pub fn capture(&self, payload: Value, timestamp: u64, admission: &Admission) -> Result<()> {
        let bytes = payload_bytes(&payload);
        let mut queue = self.queue.lock().unwrap_or_else(|error| error.into_inner());
        if queue.stopping || !admission.active.load(Ordering::SeqCst) {
            return Err("eventNotStarted".into());
        }
        if admission.paused.load(Ordering::SeqCst)
            || timestamp <= admission.resumed_at.load(Ordering::SeqCst)
        {
            return Ok(());
        }
        if bytes > MAX_QUEUED_BYTES {
            admission.dropped.fetch_add(1, Ordering::Relaxed);
            return Err("eventTooLarge".into());
        }
        while queue.event_count >= MAX_QUEUED_EVENTS
            || queue.event_bytes.saturating_add(bytes) > MAX_QUEUED_BYTES
        {
            let Some(index) = queue
                .work
                .iter()
                .position(|work| matches!(work, Work::Capture(_)))
            else {
                admission.dropped.fetch_add(1, Ordering::Relaxed);
                return Err("eventQueueFull".into());
            };
            if let Some(Work::Capture(old)) = queue.work.remove(index) {
                queue.event_count -= 1;
                queue.event_bytes -= old.bytes;
                admission.dropped.fetch_add(1, Ordering::Relaxed);
            }
        }
        queue.event_count += 1;
        queue.event_bytes += bytes;
        queue.work.push_back(Work::Capture(CaptureEvent {
            payload,
            timestamp,
            epoch: admission.epoch.load(Ordering::SeqCst),
            bytes,
        }));
        self.wake.notify_one();
        Ok(())
    }

    pub fn command(
        &self,
        mut command: Command,
        paused: Option<bool>,
        admission: &Admission,
    ) -> Result<()> {
        let mut queue = self.queue.lock().unwrap_or_else(|error| error.into_inner());
        if queue.stopping {
            return Err("runtimeStopping".into());
        }
        if queue.command_count >= MAX_QUEUED_COMMANDS {
            return Err("commandQueueFull".into());
        }
        if let Some(paused) = paused {
            let epoch = admission
                .epoch
                .fetch_add(1, Ordering::SeqCst)
                .wrapping_add(1);
            if !paused {
                admission.resumed_at.store(unix_millis(), Ordering::SeqCst);
            }
            admission.paused.store(paused, Ordering::SeqCst);
            command.pause_epoch = Some(epoch);
        }
        queue.command_count += 1;
        queue.work.push_back(Work::Command(command));
        self.wake.notify_one();
        Ok(())
    }

    pub fn stop(&self, response: Sender<Result<Value>>, admission: &Admission) -> bool {
        let mut queue = self.queue.lock().unwrap_or_else(|error| error.into_inner());
        admission.active.store(false, Ordering::SeqCst);
        if queue.stopping {
            return false;
        }
        queue.stopping = true;
        // Lifecycle barriers are reserved, never evicted by content or commands.
        queue.work.push_back(Work::Stop(response));
        self.wake.notify_all();
        true
    }

    pub fn next(&self, timeout: Duration) -> Option<Work> {
        let mut queue = self.queue.lock().unwrap_or_else(|error| error.into_inner());
        if queue.work.is_empty() {
            queue = self
                .wake
                .wait_timeout(queue, timeout)
                .unwrap_or_else(|error| error.into_inner())
                .0;
        }
        let work = queue.work.pop_front()?;
        match &work {
            Work::Capture(event) => {
                queue.event_count -= 1;
                queue.event_bytes -= event.bytes;
            }
            Work::Command(_) => queue.command_count -= 1,
            Work::Stop(_) => {}
        }
        Some(work)
    }
}

pub struct SharedState {
    pub ready: bool,
    pub settings: Settings,
    pub total_entries: u64,
    pub storage_bytes: u64,
    pub storage_error: Option<String>,
    pub source_error: Option<String>,
    pub source_status: String,
    pub source_dropped: u64,
    pub session_id: Option<String>,
    pub last_seq: u64,
    pub root: Option<std::path::PathBuf>,
    pub sink: Option<std::sync::Arc<Mailbox>>,
    pub changed_invalidation: bool,
    pub status_invalidation: bool,
}

impl Default for SharedState {
    fn default() -> Self {
        Self {
            ready: false,
            settings: Settings::default(),
            total_entries: 0,
            storage_bytes: 0,
            storage_error: None,
            source_error: None,
            source_status: "unavailable".into(),
            source_dropped: 0,
            session_id: None,
            last_seq: 0,
            root: None,
            sink: None,
            changed_invalidation: false,
            status_invalidation: false,
        }
    }
}

impl SharedState {
    pub fn status(&self, admission: &Admission) -> Value {
        let error = self.storage_error.as_ref().or(self.source_error.as_ref());
        json!({
            "ready":self.ready,
            "recording":self.ready && admission.active.load(Ordering::SeqCst)
                && !admission.paused.load(Ordering::SeqCst) && self.source_status=="ready"
                && self.storage_error.is_none(),
            "paused":admission.paused.load(Ordering::SeqCst),
            "totalEntries":self.total_entries,
            "storageBytes":self.storage_bytes,
            "droppedEvents":admission.dropped.load(Ordering::Relaxed).saturating_add(self.source_dropped).min(9_007_199_254_740_991),
            "lastError":error,
            "sourceStatus":self.source_status,
        })
    }

    pub fn poll(&mut self) -> Value {
        let mut events = vec![];
        if self.changed_invalidation {
            events.push(json!({"topic":"clipboard:changed","payload":{}}));
            self.changed_invalidation = false;
        }
        if self.status_invalidation {
            events.push(json!({"topic":"clipboard:status","payload":{}}));
            self.status_invalidation = false;
        }
        json!({"events":events})
    }
}
