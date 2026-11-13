# Native progress — Task 3

Plan: `/Users/admin/Documents/Repos/xyito/docs/superpowers/plans/2026-11-13-otools-clipboard.md`, Task 3. Spec: `/Users/admin/Documents/Repos/xyito/docs/superpowers/specs/2026-11-13-otools-clipboard-design.md`.

Scope: `native/**`, the exact host FFI snapshot plus attribution under `vendor/host-crates/ot-plugin-ffi/**`, `plugin.json`, `logo.svg`, `scripts/**`, `.github/**`, `README.md`, `docs/**`, `.gitignore`. No host/frontend/root package edits, Git operations, PAT access, publishing, or parent ledger changes.

## Pre-flight / rulings

- Task 1 → Task 3: event envelope and domain hashes match the approved contract. Text SHA256 uses `otools:clipboard:text:v1\0` + UTF-8; image SHA256 uses `otools:clipboard:image:v1\0` + u64 little-endian width/height + decoded RGBA. Payload text and image may coexist.
- Task 2 → Task 3: ordinary invoke carries `pluginDataDir` additively. It may initialize storage for UI commands but cannot start recording; only `host.events.started` opens capture admission. No production fallback directory.
- Task 3 → Task 4: exact camelCase history/settings/status contracts, safe errors, no list PNG/text body, invalidation-only `poll_events`.
- Ruling: use dev port **6549**, replacing the initial 6548 request — parent verified 6548 occupied and 6549 free — wrong port would break development binding.
- Ruling: consume host status `{source:"clipboard",state:"ready"|"unavailable"|"busy"|"unsupported",code?,droppedEvents?}`; ordinary invoke initialization reports recording false — parent supplied the actual interface — a future protocol change requires coordinated adaptation.
- Ruling: do not run executing-plans worktree/parent-ledger/commit helpers — explicit user scope forbids these and assigns this file as the native ledger — no Git-history ledger until the user later commits.
- Ruling: host FFI source has no license declaration or first-party license file; preserve the snapshot and record this fact rather than invent a license — redistribution outside this user's source tree needs owner confirmation.

- Ruling: settings accept every positive JavaScript safe integer (1..9007199254740991), not invented smaller product limits — parent clarified the frontend contract — extremely large budgets remain the user's storage choice.
- Ruling: `sourceStatus` accepts the host's later-added `idle` state; recording is true only with started admission, healthy `ready` source, initialized storage, and unpaused settings — avoids old-host/idle false recording claims.
- Ruling: host FFI allocation capacity mismatch was identified; parent fixed and verified the host crate using boxed slices, then this task copied its current source unchanged — vendor edits remain snapshot-only — original upstream helper's generic panic text is additionally sanitized at the plugin boundary.

- Ruling: host `seq` is global across subscribers; gaps only trigger an invalidation observation, never inflate real `droppedEvents` — parent clarified lifecycle events for other plugins consume sequence values — true drop counts come from local queue/epoch drops and host status.

- Ruling: require explicit `--platform` and matching real architecture for packaging; no default incomplete multi-platform bundle — spec requires real artifacts and truthful platform claims, current fileshare/otools-publish use per-platform suffixes — callers previously expecting bare `pnpm pack` must supply platform flags.
- Ruling: CI is one build-only matrix plus web/package jobs, matching current six architecture filenames and suffixes but no release/market workflow — user explicitly excluded publishing — future release integration is separate owner-authorized work.

- Ruling: install one prior-hook-chaining panic hook, suppressing only thread-local plugin guarded scopes — catch_unwind alone still printed potentially captured panic strings to stderr — a later host hook replacement could bypass suppression; tests verify the shipped runtime behavior.
- Ruling: 32 MiB FFI envelope cap accommodates worst-case escaped 1 MiB text plus 16 MiB PNG base64, while content limits remain stricter — original 24 MiB cap could reject a valid dual representation — aggregate queue remains count/byte bounded.

- Ruling: timeout cancellation applies only to work not yet begun; an in-flight SQLite settings command may commit after caller timeout, so callers must refresh settings — Rust cannot safely cancel a running disk operation — assuming timeout implies rollback would misstate persisted pause state.

## Evidence

- Pre-flight: Rust 1.95.0; Node 22.23.1 and pnpm 11.25.0 via `/Users/admin/.nvm/versions/node/v22.23.1/bin`.
- Snapshot: host HEAD `2f4313f06ed0d14a91288ea317918b29a774f043`; FFI Cargo.toml SHA256 `3dc2fcf176ba2a058cffddf361380fe411e882a20ad5769fdb41274170aa8033`, src/lib.rs SHA256 `210763909f86a3061ac86de2a81c55937d357912a61f77c5ef9a19ec43da579a`.
- Native storage RED: `cargo test --manifest-path /Users/admin/Documents/Repos/xyito/otools/otools-clipboard/native/Cargo.toml --test storage` compiled and ran **19 failing tests**, all expected `notImplemented` (corruption assertion likewise received `notImplemented` instead of `databaseCorrupt`).
- Native storage GREEN: `rustfmt --edition 2021` only plugin Rust files; entire independent package `cargo test --manifest-path /Users/admin/Documents/Repos/xyito/otools/otools-clipboard/native/Cargo.toml` passed **19/19**, 0 failures/warnings. Real temp SQLite/WAL, text/dual-representation images, thumbnails, dedup/pins, filters, count/day/budget cleanup, pause persistence, clear/delete, restart, corruption preservation, oversized inputs, actual PNG header and path/symlink checks.
- Settings boundary RED→GREEN: positive JavaScript-safe max settings initially failed with `invalidSettings`; after contract alignment, full storage suite **20/20 GREEN**.
- Runtime RED: `cargo test --manifest-path /Users/admin/Documents/Repos/xyito/otools/otools-clipboard/native/Cargo.toml --test runtime` **10/10 failed** at `notImplemented`; additional byte-budget case also observed RED before implementation.
- Runtime GREEN: entire independent `cargo test` **31/31 passed** (11 runtime + 20 storage). Runtime covers started-only recording, same-canonical-root idempotence, root switching only after joined stop, flush/restart, paused persistence/epoch invalidation, safe status including idle, session/sequence validation, count and byte overflow under a real SQLite writer lock, concurrent shutdown, corruption ACK rejection.
- FFI snapshot refreshed unchanged after coordinating host fix; current src/lib.rs SHA256 `91e9b030b6639424e2d24f002bd85363be2c86916c1ddf534c78ff02c3a4fee2`, `cmp` matches host source. Host-only tests not copied.
- FFI RED: `cargo test --manifest-path .../native/Cargo.toml --test ffi` **5/5 expected failures** (stub returned null instead of owned JSON buffers).
- FFI GREEN: full native suite **36/36 passed** (5 FFI + 11 runtime + 20 storage), including exported started→dual capture→list→pause→stopped/reserved shutdown, invalid JSON/unknown methods without echo, null/over-limit buffers, guarded panic payload redaction, variable-sized owned reply freeing.
- Systematic-debugging regression: host global-sequence gap test observed RED `droppedEvents=7` vs expected 0; removed false drop accounting while retaining invalidation observation. Full suite then **37/37 GREEN** (12 runtime + 5 FFI + 20 storage).
- Build / package RED: first missing-module run confirmed no implementation; reran executable placeholder scripts and got **11/11 expected behavior failures** (`notImplemented`, empty ZIP reader). No artifact-test skips.
- Build / package GREEN: `node --test scripts/build.test.mjs scripts/packaging.test.mjs` **11/11 passed**, 0 skipped. Tests use actual compiled library, fake-header rejection, missing artifact/no partial pack, stripped production manifest, unique corresponding platform library, path/symlink rejection, ZIP traversal/duplicate/CRC rejection, sidecar checksum integrity and exports.
- Build-only CI and README/native contract added; six native platform/architecture matrix variants, frontend test/typecheck/build, package artifact jobs. No publishing/release/write permissions.
- Final review / native fixes (author review; no subagent tool available): read commands emitted unconditional status invalidations and cleared unresolved `storageFull`. Both observed RED; delta-only refresh and preservation fixed them; suite **39/39 GREEN**.
- Final review / storage fixes: checkpoint test observed RED (busy checkpoint incorrectly returned Ok), same-dimension PNG corruption test observed RED (returned changed PNG). Explicit PRAGMA busy-result handling and read-time decoded hash verification fixed both; suite **41/41 GREEN**.
- Final review / FFI fixes: 28 MiB bounded dual-representation JSON observed RED under the initial 24 MiB cap; stderr child-process test observed RED with panic payload printed. Cap aligned to 32 MiB, thread-scoped privacy panic hook plus safe catch fixed both. Full suite **43/43 GREEN** (7 FFI + 14 runtime + 22 storage).
- Intermediate verification failure: count-drop test asserted a tied-timestamp item appeared on the default first 50 of up to 65 rows; UUID tie ordering made that flaky. Root cause was the test's first-page assumption, not queue loss. Changed assertion to literal query `item-102` and observed full **43/43 GREEN**; no production workaround.
- Early native release to unblock parent integration: `cargo build --locked --release --manifest-path .../native/Cargo.toml` passed on **macOS arm64**. Actual artifact `/Users/admin/Documents/Repos/xyito/otools/otools-clipboard/native/target/release/libotools_clipboard_native.dylib`; `nm -gU` shows `otools_plugin_free`, `otools_plugin_invoke`, `otools_plugin_on_event`; `file` verifies Mach-O 64-bit arm64. Parent notified to use the real artifact, not a guessed lib name.
- Additional preservation RED→GREEN: existing zero-byte DB and dropped `history` table were silently rebuilt; both new tests observed RED. Existing DBs now validate header length, schema/version before any creation/settings default write; only genuinely new files receive transactional schema creation. Full suite **45/45 GREEN**.
- Lifecycle atomic-admission RED→GREEN: start request returned from store initialization without admission within the lifecycle mutex. Test observed RED; start admission now occurs while the unique worker handle lock is still held, before ACK. Full suite **46/46 GREEN**.
- Package verifier RED→GREEN: checksum-consistent archive containing non-native 256-byte payload was incorrectly accepted. Added bounded in-memory binary/platform/arch verification; script suite **12/12 GREEN**.
- Real contention characterization: shutdown timeout retains handle and blocks restart until joined; a pending settings command cancels at deadline, not executed later. An initial test incorrectly assumed an already-started pause must roll back after timeout; actual running SQLite operation is noncancellable, so it was replaced with pending `maxEntries` cancellation and the limitation is documented.
- Toolchain verification recovery: initial PATH pnpm11 auto-switch encountered signature download timeout; did not bypass checks. Used already-installed Node **22.22.2**, pnpm **10.33.3** from `/Users/admin/.nvm/versions/node/v22.22.2/bin`; real `build-web.mjs` and macOS pack/verify passed. Initial rustup clippy dispatch lacked that component; the already-installed Homebrew `/opt/homebrew/Cellar/rust/1.95.0/bin/cargo-clippy` with explicit CARGO/RUSTC passed after one equivalent `?` style refactor. No toolchain installation/configuration change.
- Parent-reported integration evidence (not locally rerun by this agent): real OTools event core + dylib test passed in isolated OTOOLS_HOME, covering text/image dual capture, dedup count, image read, paused ignore, stopped/restart/shutdown. Parent is rerunning with final staged release.
- Final verification **GREEN**, using installed Node22.22.2/pnpm10.33.3/Rust1.95.0:
  - `cargo test --locked --manifest-path /Users/admin/Documents/Repos/xyito/otools/otools-clipboard/native/Cargo.toml` **48/48** (1 lifecycle unit + 7 FFI + 16 runtime + 24 storage), 0 failures/warnings.
  - Installed Homebrew `cargo-clippy clippy --locked --manifest-path .../native/Cargo.toml --all-targets -- -D warnings` passed; no components installed. Intermediate test-module-order warning fixed by moving test-only module below production items; behavior unchanged.
  - `node --test /Users/admin/Documents/Repos/xyito/otools/otools-clipboard/scripts/build.test.mjs /Users/admin/Documents/Repos/xyito/otools/otools-clipboard/scripts/packaging.test.mjs` **12/12**, 0 skipped.
  - `node scripts/build-web.mjs` built actual frontend dist with installed pnpm10.33.3; no frontend sources or root package/lockfiles edited by this task.
  - `node scripts/build-native.mjs --arch arm64` release build plus binary/architecture/three-export validation passed; staged `lib/macOS-arm64.dylib` and `lib/macOS.dylib` match SHA256 **ed574437f9f345c2f1d6b5b78f35c129b78073d5197e6850e5ddf02f4dabb786**.
  - `node scripts/pack-plugin.mjs --platform macos --arch arm64` and `node scripts/verify-plugin.mjs dist-pack/macos` passed. Actual flat package `/Users/admin/Documents/Repos/xyito/otools/otools-clipboard/dist-pack/macos/otools-clipboard-0.1.0-macos.oplg`: **6 entries**, only native `lib/macOS.dylib`, SHA256 **6caa1e771c5fa332f5427b4903ffe12782fbf4a10ee14e2b588f145afae832c4**.
  - `git diff --check -- otools-clipboard` clean (new plugin untracked under parent); both vendored crate source files `cmp` identical to host; only assigned paths written. No branch/worktree/init/commit/push/PAT/publish operations.

## Limitations / unexecuted coverage

- Windows, Linux, macOS Intel and ARM variants other than the local macOS arm64 build were not executed here. The six-variant CI is a definition, not a passing run.
- Periodic cleanup is wired at 60 seconds through the same tested maintenance routine; tests verify direct/startup/arrival/settings cleanup, not a full wall-clock 60-second timer wait.
- No forced power-loss/disk-full fault injection. SQLite checkpoint contention, corruption preservation, and same-dimension PNG tampering are exercised with real files/DBs.
- Parent owns actual system watcher / host GUI acceptance; this native agent does not autonomously touch the system clipboard.
- Snapshot's upstream first-party license remains unspecified; provenance documents this and publication permission is not inferred.
- Author review is not a fresh independent reviewer. No deferred minor findings were intentionally left as code changes.
