use crate::event_sink::{Admission, Command, Mailbox, SharedState, Work};
use crate::protocol::{unix_millis, Result, SettingsUpdate};
use crate::store::Store;
use serde::Deserialize;
use serde_json::{json, Value};
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    mpsc::{self, Receiver},
    Arc, Mutex,
};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

const COMMAND_TIMEOUT: Duration = Duration::from_millis(1700);
const MAINTENANCE_INTERVAL: Duration = Duration::from_secs(60);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EventEnvelope {
    schema_version: u32,
    topic: String,
    session_id: String,
    seq: u64,
    timestamp: u64,
    plugin_dir: String,
    plugin_data_dir: String,
    payload: Value,
}

#[derive(Clone)]
struct StartRequest {
    session_id: String,
    seq: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct InvokeEnvelope {
    method: String,
    #[serde(default = "empty_object")]
    payload: Value,
    plugin_data_dir: Option<String>,
}

fn empty_object() -> Value {
    json!({})
}

fn guarded<T>(operation: impl FnOnce() -> Result<T>) -> Result<T> {
    crate::panic_guard::catch(operation).unwrap_or_else(|_| Err("internalError".into()))
}

fn lexical_root(path: &Path) -> Result<PathBuf> {
    if !path.is_absolute() {
        return Err("invalidDataDir".into());
    }
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            _ => normalized.push(component.as_os_str()),
        }
    }
    Ok(normalized)
}

fn same_root(raw: &str, canonical: &Path) -> bool {
    let path = Path::new(raw);
    lexical_root(path).is_ok_and(|path| path == canonical)
        || fs::canonicalize(path).is_ok_and(|path| path == canonical)
}

fn canonical_root(raw: &str) -> Result<PathBuf> {
    let path = Path::new(raw);
    if raw.is_empty() || raw.len() > 8192 || !path.is_absolute() {
        return Err("invalidDataDir".into());
    }
    fs::create_dir_all(path).map_err(|_| "storageIo")?;
    fs::canonicalize(path).map_err(|_| "invalidDataDir".into())
}

struct Worker {
    root: PathBuf,
    sink: Arc<Mailbox>,
    join: Option<JoinHandle<()>>,
    startup: Option<Receiver<Result<Value>>>,
    stopping: bool,
    stop_response: Option<Receiver<Result<Value>>>,
}

pub struct Runtime {
    worker: Mutex<Option<Worker>>,
    shared: Arc<Mutex<SharedState>>,
    admission: Arc<Admission>,
}

impl Default for Runtime {
    fn default() -> Self {
        Self::new()
    }
}

impl Runtime {
    pub fn new() -> Self {
        Self {
            worker: Mutex::new(None),
            shared: Arc::new(Mutex::new(SharedState::default())),
            admission: Arc::new(Admission::default()),
        }
    }

    pub fn status(&self) -> Value {
        self.shared
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .status(&self.admission)
    }

    fn ensure_store(&self, raw_root: &str) -> Result<Arc<Mailbox>> {
        self.ensure_store_for(raw_root, None)
    }

    fn ensure_store_for(
        &self,
        raw_root: &str,
        start: Option<StartRequest>,
    ) -> Result<Arc<Mailbox>> {
        // This lock owns the unique JoinHandle, not the DB. Lifecycle never waits while
        // holding the event/status lock, and a callback does not use this lock for data.
        let mut guard = self.worker.try_lock().map_err(|_| "runtimeBusy")?;
        if guard
            .as_ref()
            .is_some_and(|worker| worker.join.as_ref().is_some_and(JoinHandle::is_finished))
        {
            let mut old = guard.take().ok_or("runtimeUnavailable")?;
            if let Some(join) = old.join.take() {
                let _ = join.join();
            }
        }
        if let Some(worker) = guard.as_mut() {
            if !same_root(raw_root, &worker.root) {
                return Err("dataRootChanged".into());
            }
            if worker.stopping {
                return Err("runtimeStopping".into());
            }
            if let Some(startup) = worker.startup.take() {
                match startup.recv_timeout(COMMAND_TIMEOUT) {
                    Ok(Ok(_)) => {}
                    Ok(Err(error)) => {
                        worker.stopping = true;
                        return Err(error);
                    }
                    Err(mpsc::RecvTimeoutError::Timeout) => {
                        worker.startup = Some(startup);
                        return Err("initializationTimeout".into());
                    }
                    Err(_) => return Err("runtimeUnavailable".into()),
                }
            }
            let ready = self
                .shared
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .ready;
            return if ready {
                self.admit_start(start)?;
                Ok(worker.sink.clone())
            } else {
                Err("runtimeUnavailable".into())
            };
        }
        let root = canonical_root(raw_root)?;
        let sink = Arc::new(Mailbox::default());
        let (sender, receiver) = mpsc::channel();
        {
            let mut shared = self
                .shared
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            shared.root = Some(root.clone());
            shared.sink = Some(sink.clone());
            shared.source_status = "idle".into();
            shared.source_error = None;
            shared.ready = false;
        }
        let thread_sink = sink.clone();
        let shared = self.shared.clone();
        let admission = self.admission.clone();
        let thread_root = root.clone();
        let join = thread::Builder::new()
            .name("otools-clipboard-storage".into())
            .spawn(move || storage_worker(thread_root, thread_sink, shared, admission, sender))
            .map_err(|_| "workerSpawnFailed")?;
        *guard = Some(Worker {
            root,
            sink: sink.clone(),
            join: Some(join),
            startup: None,
            stopping: false,
            stop_response: None,
        });
        match receiver.recv_timeout(COMMAND_TIMEOUT) {
            Ok(Ok(_)) => {
                self.admit_start(start)?;
                Ok(sink)
            }
            Ok(Err(error)) => {
                if let Some(worker) = guard.as_mut() {
                    worker.stopping = true;
                }
                Err(error)
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if let Some(worker) = guard.as_mut() {
                    worker.startup = Some(receiver);
                }
                Err("initializationTimeout".into())
            }
            Err(_) => Err("runtimeUnavailable".into()),
        }
    }

    fn admit_start(&self, start: Option<StartRequest>) -> Result<()> {
        let Some(start) = start else {
            return Ok(());
        };
        // Called while the unique worker lifecycle mutex is held. Shutdown cannot
        // close/join the writer between initialization and capture admission.
        let mut shared = self
            .shared
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if self.admission.active.load(Ordering::SeqCst) {
            if shared.session_id.as_deref() != Some(&start.session_id) {
                return Err("staleSession".into());
            }
            return Ok(());
        }
        if !shared.ready {
            return Err("runtimeUnavailable".into());
        }
        shared.session_id = Some(start.session_id);
        shared.last_seq = start.seq;
        shared.source_dropped = 0;
        shared.status_invalidation = true;
        self.admission.active.store(true, Ordering::SeqCst);
        Ok(())
    }

    pub fn invoke(&self, input: Value) -> Result<Value> {
        let envelope: InvokeEnvelope =
            serde_json::from_value(input).map_err(|_| "invalidRequest")?;
        if envelope.method == "__otools_shutdown__" {
            self.shutdown()?;
            return Ok(json!({"stopped":true}));
        }
        if !matches!(
            envelope.method.as_str(),
            "clipboard_status"
                | "poll_events"
                | "clipboard_list"
                | "clipboard_get"
                | "clipboard_get_image"
                | "clipboard_set_pinned"
                | "clipboard_delete"
                | "clipboard_clear"
                | "clipboard_get_settings"
                | "clipboard_update_settings"
        ) {
            return Err("unknownMethod".into());
        }
        let Some(root) = envelope
            .plugin_data_dir
            .as_deref()
            .filter(|root| !root.is_empty())
        else {
            if envelope.method == "clipboard_status" {
                return Ok(
                    json!({"ready":false,"recording":false,"paused":false,"totalEntries":0,"storageBytes":0,"droppedEvents":self.admission.dropped.load(Ordering::Relaxed),"lastError":"hostContextUnavailable","sourceStatus":"unavailable"}),
                );
            }
            return Err("hostContextUnavailable".into());
        };
        let sink = match self.ensure_store(root) {
            Ok(sink) => sink,
            Err(error) => {
                if envelope.method == "clipboard_status" {
                    let mut status = self.status();
                    status["ready"] = json!(false);
                    status["recording"] = json!(false);
                    status["lastError"] = json!(error);
                    return Ok(status);
                }
                return Err(error);
            }
        };
        if envelope.method == "clipboard_status" {
            return Ok(self.status());
        }
        let pause = if envelope.method == "clipboard_update_settings" {
            let update: SettingsUpdate =
                serde_json::from_value(envelope.payload.clone()).map_err(|_| "invalidSettings")?;
            self.shared
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .settings
                .updated(envelope.payload.clone())?;
            update.paused
        } else {
            None
        };
        // UI commands are tiny; do not allow arbitrary request payloads to exhaust a
        // count-bounded command queue while the storage worker is occupied.
        if serde_json::to_vec(&envelope.payload)
            .map_err(|_| "invalidPayload")?
            .len()
            > 64 * 1024
        {
            return Err("requestTooLarge".into());
        }
        let (response, receiver) = mpsc::channel();
        let cancelled = Arc::new(AtomicBool::new(false));
        sink.command(
            Command {
                method: envelope.method,
                payload: envelope.payload,
                deadline: Instant::now() + COMMAND_TIMEOUT,
                cancelled: cancelled.clone(),
                response,
                pause_epoch: None,
            },
            pause,
            &self.admission,
        )?;
        if pause.is_some() {
            self.shared
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .status_invalidation = true;
        }
        match receiver.recv_timeout(COMMAND_TIMEOUT) {
            Ok(result) => result,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                cancelled.store(true, Ordering::SeqCst);
                Err("commandTimeout".into())
            }
            Err(_) => Err("runtimeUnavailable".into()),
        }
    }

    pub fn on_event(&self, input: Value) -> Result<Value> {
        let envelope: EventEnvelope = serde_json::from_value(input).map_err(|_| "invalidEvent")?;
        if envelope.schema_version != 1 {
            return Err("unsupportedSchema".into());
        }
        if envelope.session_id.is_empty()
            || envelope.session_id.len() > 256
            || envelope.plugin_dir.is_empty()
        {
            return Err("invalidEvent".into());
        }
        match envelope.topic.as_str() {
            "host.events.started" => {
                self.ensure_store_for(
                    &envelope.plugin_data_dir,
                    Some(StartRequest {
                        session_id: envelope.session_id,
                        seq: envelope.seq,
                    }),
                )?;
                Ok(json!({"accepted":true}))
            }
            "clipboard.changed" | "host.events.status" | "host.events.stopped" => {
                let mut shared = self
                    .shared
                    .lock()
                    .unwrap_or_else(|error| error.into_inner());
                if !self.admission.active.load(Ordering::SeqCst) {
                    return Err("eventNotStarted".into());
                }
                if shared.session_id.as_deref() != Some(&envelope.session_id) {
                    return Err("staleSession".into());
                }
                if !shared
                    .root
                    .as_ref()
                    .is_some_and(|root| same_root(&envelope.plugin_data_dir, root))
                {
                    return Err("dataRootChanged".into());
                }
                if envelope.seq <= shared.last_seq {
                    return Err("staleEvent".into());
                }
                let gap = envelope
                    .seq
                    .saturating_sub(shared.last_seq.saturating_add(1));
                if gap > 0 {
                    // Host seq is global across subscribers: a gap is not evidence
                    // that this plugin lost clipboard content.
                    shared.status_invalidation = true;
                }
                shared.last_seq = envelope.seq;
                if envelope.topic == "host.events.status" {
                    let source = envelope
                        .payload
                        .get("source")
                        .and_then(Value::as_str)
                        .ok_or("invalidStatus")?;
                    let state = envelope
                        .payload
                        .get("state")
                        .and_then(Value::as_str)
                        .ok_or("invalidStatus")?;
                    if source != "clipboard"
                        || !matches!(
                            state,
                            "ready" | "busy" | "unavailable" | "unsupported" | "idle"
                        )
                    {
                        return Err("invalidStatus".into());
                    }
                    shared.source_status = state.into();
                    shared.source_error = match state {
                        "busy" => Some("sourceBusy".into()),
                        "unavailable" => Some("sourceUnavailable".into()),
                        "unsupported" => Some("sourceUnsupported".into()),
                        _ => None,
                    };
                    if let Some(dropped) = envelope
                        .payload
                        .get("droppedEvents")
                        .and_then(Value::as_u64)
                    {
                        shared.source_dropped = shared.source_dropped.max(dropped);
                    }
                    shared.status_invalidation = true;
                    return Ok(json!({"accepted":true}));
                }
                if envelope.topic == "host.events.stopped" {
                    drop(shared);
                    self.shutdown()?;
                    return Ok(json!({"accepted":true}));
                }
                let sink = shared.sink.clone().ok_or("runtimeUnavailable")?;
                drop(shared);
                sink.capture(envelope.payload, envelope.timestamp, &self.admission)?;
                Ok(json!({"accepted":true}))
            }
            _ => Err("unknownTopic".into()),
        }
    }

    pub fn shutdown(&self) -> Result<()> {
        let mut guard = self.worker.try_lock().map_err(|_| "runtimeBusy")?;
        let Some(worker) = guard.as_mut() else {
            return Ok(());
        };
        if !worker.stopping {
            let (sender, receiver) = mpsc::channel();
            worker.sink.stop(sender, &self.admission);
            worker.stopping = true;
            worker.stop_response = Some(receiver);
        }
        {
            let mut shared = self
                .shared
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            shared.ready = false;
            shared.status_invalidation = true;
        }
        if let Some(receiver) = worker.stop_response.take() {
            match receiver.recv_timeout(COMMAND_TIMEOUT) {
                Ok(result) => {
                    result?;
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    worker.stop_response = Some(receiver);
                    return Err("shutdownTimeout".into());
                }
                Err(_) => {}
            }
        }
        // The worker has returned from DB flush. Retain its handle if a timed-out
        // startup or shutdown still owns the DB; never create a replacement writer.
        let deadline = Instant::now() + COMMAND_TIMEOUT;
        while worker.join.as_ref().is_some_and(|join| !join.is_finished()) {
            if Instant::now() >= deadline {
                return Err("shutdownTimeout".into());
            }
            thread::yield_now();
        }
        if let Some(join) = worker.join.take() {
            join.join().map_err(|_| "internalError")?;
        }
        *guard = None;
        let mut shared = self
            .shared
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        shared.sink = None;
        shared.session_id = None;
        shared.root = None;
        shared.source_status = "idle".into();
        Ok(())
    }
}

impl Drop for Runtime {
    fn drop(&mut self) {
        let _ = self.shutdown();
    }
}

fn refresh(
    store: &Store,
    shared: &Arc<Mutex<SharedState>>,
    admission: &Admission,
    error: Option<String>,
    changed: bool,
    pause_epoch: Option<u64>,
) {
    let stats = store.stats();
    let mut shared = shared.lock().unwrap_or_else(|error| error.into_inner());
    let before = shared.status(admission);
    shared.settings = store.settings().clone();
    if pause_epoch.is_some_and(|epoch| admission.epoch.load(Ordering::SeqCst) == epoch) {
        admission
            .paused
            .store(store.settings().paused, Ordering::SeqCst);
    }
    match stats {
        Ok((total, bytes)) => {
            shared.total_entries = total;
            shared.storage_bytes = bytes;
            if let Some(error) = error {
                shared.storage_error = Some(error);
            } else if changed {
                shared.storage_error = None;
            }
        }
        Err(error) => shared.storage_error = Some(error),
    }
    shared.status_invalidation |= shared.status(admission) != before || changed;
    shared.changed_invalidation |= changed;
}

fn storage_worker(
    root: PathBuf,
    sink: Arc<Mailbox>,
    shared: Arc<Mutex<SharedState>>,
    admission: Arc<Admission>,
    startup: mpsc::Sender<Result<Value>>,
) {
    let mut store = match guarded(|| Store::open(&root, unix_millis())) {
        Ok(store) => store,
        Err(error) => {
            let mut state = shared.lock().unwrap_or_else(|error| error.into_inner());
            state.ready = false;
            state.storage_error = Some(error.clone());
            state.status_invalidation = true;
            let _ = startup.send(Err(error));
            return;
        }
    };
    admission
        .paused
        .store(store.settings().paused, Ordering::SeqCst);
    refresh(&store, &shared, &admission, None, false, None);
    shared
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .ready = true;
    let _ = startup.send(Ok(json!({"ready":true})));
    let mut maintained = Instant::now();
    loop {
        match sink.next(Duration::from_millis(250)) {
            Some(Work::Capture(event)) => {
                if event.epoch != admission.epoch.load(Ordering::SeqCst)
                    || admission.paused.load(Ordering::SeqCst)
                {
                    admission.dropped.fetch_add(1, Ordering::Relaxed);
                    shared
                        .lock()
                        .unwrap_or_else(|error| error.into_inner())
                        .status_invalidation = true;
                    continue;
                }
                let result = guarded(|| store.capture(event.payload, event.timestamp));
                match result {
                    Ok(changed) => refresh(&store, &shared, &admission, None, changed, None),
                    Err(error) => refresh(&store, &shared, &admission, Some(error), false, None),
                }
            }
            Some(Work::Command(command)) => {
                if command.cancelled.load(Ordering::SeqCst) || Instant::now() > command.deadline {
                    refresh(
                        &store,
                        &shared,
                        &admission,
                        None,
                        false,
                        command.pause_epoch,
                    );
                    let _ = command.response.send(Err("commandTimeout".into()));
                    continue;
                }
                let result = if command.method == "poll_events" {
                    Ok(shared
                        .lock()
                        .unwrap_or_else(|error| error.into_inner())
                        .poll())
                } else {
                    guarded(|| store.command(&command.method, command.payload, unix_millis()))
                };
                let changed = result.is_ok()
                    && matches!(
                        command.method.as_str(),
                        "clipboard_set_pinned"
                            | "clipboard_delete"
                            | "clipboard_clear"
                            | "clipboard_update_settings"
                    );
                // Poll itself must not generate a new status invalidation.
                if command.method != "poll_events" {
                    refresh(
                        &store,
                        &shared,
                        &admission,
                        result
                            .as_ref()
                            .err()
                            .filter(|error| {
                                !matches!(
                                    error.as_str(),
                                    "notFound"
                                        | "invalidId"
                                        | "invalidPayload"
                                        | "invalidFilter"
                                        | "queryTooLarge"
                                        | "invalidSettings"
                                        | "notImage"
                                        | "unknownMethod"
                                )
                            })
                            .cloned(),
                        changed,
                        command.pause_epoch,
                    );
                }
                let _ = command.response.send(result);
            }
            Some(Work::Stop(sender)) => {
                let result = guarded(|| store.flush()).map(|_| json!({"stopped":true}));
                {
                    let mut state = shared.lock().unwrap_or_else(|error| error.into_inner());
                    state.ready = false;
                    state.status_invalidation = true;
                    if let Err(error) = &result {
                        state.storage_error = Some(error.clone());
                    }
                }
                drop(store); // Close SQLite before announcing the stop barrier.
                let _ = sender.send(result);
                return;
            }
            None => {}
        }
        if maintained.elapsed() >= MAINTENANCE_INTERVAL {
            let result = guarded(|| store.maintain(unix_millis()));
            match result {
                Ok(changed) => refresh(&store, &shared, &admission, None, changed, None),
                Err(error) => refresh(&store, &shared, &admission, Some(error), false, None),
            }
            maintained = Instant::now();
        }
    }
}

#[cfg(test)]
mod lifecycle_tests {
    use super::*;

    #[test]
    fn started_store_admission_is_atomic_with_worker_lifecycle() {
        let root = tempfile::TempDir::new().unwrap();
        let runtime = Runtime::new();
        runtime
            .ensure_store_for(
                root.path().to_str().unwrap(),
                Some(StartRequest {
                    session_id: "atomic-start".into(),
                    seq: 1,
                }),
            )
            .unwrap();
        assert!(runtime.admission.active.load(Ordering::SeqCst),"started was acknowledged by store initialization without atomically admitting generation");
        runtime.shutdown().unwrap();
        assert!(!runtime.admission.active.load(Ordering::SeqCst));
    }
}
