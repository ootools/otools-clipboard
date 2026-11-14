# Native contract

## FFI and lifecycle

`otools_plugin_invoke` and optional `otools_plugin_on_event` both use
`extern "C" fn(*const u8, usize, *mut usize) -> *mut u8`.
`otools_plugin_free(*mut u8, usize)` releases the reply; the host must supply the exact returned length and free exactly once.
Standard replies are `{ok:true,data}` or `{ok:false,error}`. Parser, storage, source and panic errors are safe codes, never captured text/base64 or an original dependency error message. The FFI envelope is bounded to 32 MiB (including JSON escapes); content-specific limits below remain stricter. A thread-local guarded-scope panic hook suppresses potentially private panic messages without suppressing other threads' prior diagnostics.

Event envelope fields are camelCase `{schemaVersion:1,topic,sessionId,seq,timestamp,pluginDir,pluginDataDir,payload}`. Timestamps are Unix milliseconds.

- `host.events.started` opens the canonical data root, initializes SQLite/settings/maintenance, then ACKs `{accepted:true}` and enables admission. Same-root/same-session repeats are idempotent and do not reset sequence or spawn a worker. Root changes are refused until a joined stop.
- Ordinary invoke may initialize the same storage for UI history commands but never enables recording. Missing `pluginDataDir` reports `ready:false`, `recording:false`, `sourceStatus:"unavailable"`; no hidden fallback directory exists.
- `clipboard.changed` may include both `text:{text,hash}` and `image:{pngBase64,width,height,hash}`. ACK means enqueue admission, not durable capture; queued invalid/paused/stale/over-capacity content may be ignored or rejected by storage with status updated.
- `host.events.status` consumes `{source:"clipboard",state:"ready"|"busy"|"unavailable"|"unsupported"|"idle",code?,skippedItems?,droppedEvents?}`. State maps to `sourceStatus`; optional arbitrary `code` is not echoed. Recording requires initialized store, started admission, unpaused settings, healthy `ready` source and no storage error.
- Global host sequence gaps are only observations, not real drop counts. `droppedEvents` combines local count/byte/epoch drops and host-provided actual source drops.
- `host.events.stopped` and reserved invoke `__otools_shutdown__` stop admission, drain queued work, checkpoint/close SQLite, join the sole worker, then ACK. A timeout retains the old handle and blocks replacement; no duplicate writer is started.

One worker owns the SQLite connection. Event callbacks only parse/admit bounded work (64 content items / 32 MiB; oldest content evicted, commands/lifecycle preserved). UI commands are serialized, count-bounded (32 pending) and payload-bounded (64 KiB), with 1700 ms response timeout/cancellation of work not yet begun. A timed-out command already executing may still commit; refresh settings/history to observe its final persisted outcome. Started/stopped use the same bounded deadline; a running disk operation cannot safely be forcibly cancelled. Pausing/resuming immediately changes an admission epoch; queued older epochs cannot be recorded after resume. Resume also establishes an observed-time cutoff, so host-queued copies from before/during pause cannot be backfilled after callback delivery. Events in the resume millisecond are conservatively skipped. A capture already executing before pause is allowed to finish, while queued pre-pause work is discarded. Invalid request/not-found errors are returned to their caller without changing the recorder's storage-health status.

## UI methods

- `clipboard_list({query?,kind?:"all"|"text"|"image",pinnedOnly?,offset?,limit?,from?,until?})` → `{items,total,offset,limit}`. Default limit 50, maximum 100. Query is a literal text substring (SQLite ASCII case-folding); `%` / `_` are not wildcards. `from`/`until` are an optional half-open `[from, until)` window in Unix ms over `last_copied_at`; both bounds must be sent together with `from <= until <= 2^53-1`, otherwise `invalidFilter`. Ordering: pinned first, then most recent. No PNG or full text bodies in list.
- `HistoryItem` → `{id,kind,hash,preview,byteSize,width?,height?,createdAt,lastCopiedAt,copyCount,pinned}`. IDs are canonical UUID strings, hashes lower-case 64 hex. Preview is at most 256 Unicode scalars; image preview is dimensions.
- `clipboard_get({id})` → `HistoryItem & {text?:string}`.
- `clipboard_get_image({id,thumbnail?:boolean})` → `{dataUrl,width,height}`. Thumbnail dimensions fit within 256×256 and describe the returned PNG, not the original.
- `clipboard_set_pinned({id,pinned})` → `{removed:0}`; `clipboard_delete({id})` → `{removed:number}`; `clipboard_clear({includePinned?:boolean})` → `{removed:number}` (default excludes pins).
- `clipboard_get_settings` / `clipboard_update_settings({maxEntries?,retentionDays?,maxBytes?,paused?})` → `{maxEntries,retentionDays,maxBytes,paused}`. Defaults 500/30/268435456/false. Numeric fields are positive JavaScript safe integers; zero, fractional, negative and unsafe values are rejected.
- `clipboard_status` → `{ready,recording,paused,totalEntries,storageBytes,droppedEvents,lastError:string|null,sourceStatus}`. StorageBytes counts managed text/PNG content, including pins; not SQLite page/WAL overhead.
- `poll_events` → `{events:[{topic:"clipboard:changed"|"clipboard:status",payload:{}}]}`. Coalesced invalidations only, never content.

## Persistence and validation

Data root is `<pluginDataDir>/clipboard/`; WAL DB `history.sqlite3`; immutable content-addressed PNGs `images/<hash>.png`.

Text: SHA256 of `b"otools:clipboard:text:v1\0" + UTF8`, at most 1 MiB. Empty text is ignored.
Image: SHA256 of `b"otools:clipboard:image:v1\0" + width(u64 LE) + height(u64 LE) + RGBA`, dimensions ≤16384, ≤32,000,000 pixels, PNG ≤16 MiB. Payload size/dimensions and actual PNG IHDR are checked before pixel allocation; decoded dimensions and RGBA hash are verified, not trusted.

Dedup is kind/hash; copies update lastCopiedAt/count and preserve createdAt/pin. Pins are excluded from day/count cleanup but counted in bytes. Cleanup runs on startup, arrivals, settings changes, and 60-second periodic maintenance. Only oldest unpinned data can be evicted. Pins preventing new content from fitting return `storageFull`; existing history is not destructively evicted for that rejected arrival.

PNG is written to a unique owned temporary file, synced, atomically renamed and (Unix) directory-synced before metadata commit. Startup/maintenance remove only recognized owned orphan PNG/temp filenames, never unrelated files or symlinks. Image reads accept IDs, never arbitrary paths. Symlinked managed directories/DB/image files are refused. SQLite corruption is reported and original bytes preserved; no truncation or silent reset.

This is trusted native plugin code, not an OS-level sandbox; protection targets accidental path escape and malformed cooperative host input. Same-user concurrent filesystem attacks and abrupt hardware failures cannot be fully prevented by portable pathname APIs. No encryption or content classification promises.
