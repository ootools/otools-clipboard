# Task 4 implementation — 2026-11-13

Plan: `/Users/admin/Documents/Repos/xyito/docs/superpowers/plans/2026-11-13-otools-clipboard.md` (Task 4 only).
Spec: `/Users/admin/Documents/Repos/xyito/docs/superpowers/specs/2026-11-13-otools-clipboard-design.md`.

## Scope and pre-flight

- Assigned ownership: `web/**`, root package/workspace/lock files, copied `vendor/otools-plugin-sdk/**` plus its license/provenance. Native/scripts/manifest/docs/host are other agents' work; untouched.
- No branches/worktrees, Git initialization, commits, push, PAT or publishing.
- Native contracts consumed exactly as supplied; millisecond timestamps, list metadata only, on-demand selected full image and bounded thumbnails.
- SDK Vite aliases use official `@tauri-apps/api/core` / `event` syntax. Existing host `nativeBridge.ts` unwraps `{ok,data}`; central API must also accept a raw single FFI envelope and validate its result.
- Snapshot copied from current host SDK (including unrelated local file-chooser fixes) without altering upstream. License retained.

## Rulings

- Ruling: use dev port **6549**, not planned 6548 — coordinator verified 6548 occupied and 6549 free, and is coordinating native manifest — cost if wrong: strictPort refuses start rather than silently selecting another port.
- Ruling: use assigned `web/IMPLEMENTATION.md` as the Task 4 evidence ledger and no parent skill workspace/commits — explicit scoped parallel-work instructions override generic executor setup — cost if wrong: parent must aggregate final evidence separately.
- Ruling: browser preview remains explicit synthetic data with no clipboard-reading fallback; copy requires `window.otools` — coordinator requested accurate host-required feedback instead of a browser write fallback — cost if wrong: preview copy cannot be demonstrated without host.
- Ruling: synchronous host copy success is labeled “Copy requested”, not confirmed OS clipboard write — existing host `copyText/copyImage` returns boolean while discarding downstream asynchronous errors — cost if wrong: no end-to-end confirmation available until host facade changes.

## TDD evidence

- API boundary: 15 tests observed RED (missing central adapter), then GREEN **15/15**. Exact methods/flat payloads, raw vs unwrapped replies, reply validation, list blob stripping, PNG-only data URLs, settings validation, listen cleanup, and real SDK identity routing verified.
- Copy/preview: 8 tests observed RED (missing implementations), then full suite GREEN **23/23**. Full text/full PNG choose existing host APIs; false/rejection is an error; absent host never accesses browser clipboard or loads content; preview is explicit and only synthetic, pins/clear/filter/pause settings work.
- Dependency setup failure diagnosed: fresh SDK semver resolution selected uncached versions; pnpm11 policy metadata-full was not cached. Reused/pruned existing host lock resolutions, then existing pnpm **10.33.3** completed frozen install with 47 public-package downloads. No security settings changed; pnpm's blocked dependency build scripts remain blocked. Root packageManager pins the tested existing version.

- History controller: 18 tests observed RED (missing controller), then full suite GREEN **41/41**. Pagination/filter reset, immediate debounce invalidation, stale successes/errors/details/images/settings, three-concurrent/twelve-thumbnail cap, scope disposal/listen cleanup, destructive confirmations and failed/duplicate mutations, acknowledged pause, truthful missing-started state and coalesced events verified.

- Appearance/keyboard: 8 tests observed RED, then GREEN **8/8**. Chinese fallback, pre-injected host appearance, real DOM theme/locale events, attribute observation, message-source guard, edit/button/dialog keyboard exclusions and disposal tested.
- Real components: 10 tests observed RED against an empty panel, then full suite GREEN **59/59**. Literal malicious HTML list/detail rendering, explicit preview/protocol guidance, real filter/selection/delete/clear/settings/pause/copy/search interactions and absent-listener rendering tested using real Vue + Element Plus, not component mocks.
- Debugging: the first component run had 1 test fixture selector failure: Element Plus forwards `data-testid` to the actual input (not its wrapper). Traced its real `inheritAttrs:false` behavior and corrected the query; focus behavior was verified afterward. Initial vue-tsc failures were missing SDK global declaration import and Vite 6 vs SDK Vite 7 type identity; loaded SDK globals and narrowed only the characterized alias-plugin compatibility boundary. No upstream SDK edits.
- Review regression: 6 further tests observed RED: clear disabled by a no-results filter, valid tiny native byte budgets rejected in exponent-form MiB, row focus not following arrow selection, local recording rules only in tooltip, pause-status update waiting for settings, and completed native mutations waiting on a separate read. Fixes in progress; source writes paused during parent GUI checks to prevent HMR-reset false findings.
- Review: failed native content lookup was incorrectly relabeled as host copy rejection; regression observed RED. A status/settings cross-reply race could undo a newer pause; regression observed RED. These are part of the same final fix pass.
- Cross-agent finding (read-only native inspection): native read commands were unconditionally producing a `clipboard:status` invalidation through `refresh()`, which can loop with status-triggered `get_settings`. Reported exact locations to parent/native owner; not edited by web agent.
- Final review is an implementer self-review; parent is arranging independent/read-only and GUI acceptance separately. No fresh reviewer is claimed by this subagent.

- Final review fix pass: all **8** added regression tests were observed RED, then the full root suite GREEN **67/67** (5 files). Fixed filter-independent clear availability, exponent-form tiny byte budget round-trip, roving row focus, visible local recording policy, immediate/versioned pause consistency across status/settings replies, completed native mutations independent of slow refresh, and preservation of native lookup error attribution. No deferred actionable UI defects from this self-review.
- Cross-agent native read-invalidation loop finding was fixed by the native owner; parent reported its regression suite **39/39**. This subagent did not run/claim those native tests.
- Final SDK snapshot refreshed read-only from host HEAD `d8f4537d022495671bdde411b7eac2bfcbd64a65`, preserving unrelated existing file-chooser fixes and copying the parent's source-only optional `getHostEventStatus` declaration. Original `dist` declarations lack that additive type at snapshot time; UI has no dependency on it. Byte hashes and license are in vendored provenance.

## Verification / handoff

Final fresh verification after the last source edit and SDK refresh (09:42–09:43 local):

- Root `pnpm test` → **67/67 tests passed**, 5 files, 0 failures or unhandled errors.
- Root `pnpm typecheck` → `vue-tsc --noEmit --pretty false`, exit **0**.
- Root `pnpm build:web` → native owner's `scripts/build-web.mjs` → Vite **6.4.1**, exit **0**, `dist/index.html` exists.
- Production assets: JS **242.62 kB** (gzip **87.92 kB**), CSS **62.47 kB** (gzip **11.00 kB**). Relative asset base; manifest/dev port **6549** agree.
- Locked installation repeated: existing pnpm **10.33.3**, frozen offline install exit **0**, no build-script policy changes.
- Node is available at `/Users/admin/.nvm/versions/node/v22.23.1/bin/node`; the pinned pnpm binary is `/Users/admin/.nvm/versions/node/v22.22.2/bin/pnpm`. Put that pnpm bin ahead of the pnpm11 directory for nested root scripts. When pnpm11 was first on PATH, a nested pnpm version auto-selection stalled; corrected PATH verified the actual scripts without changing any global settings.

Running GUI handoff server: `http://127.0.0.1:6549/?preview=1`, task `exec_c2392787-94ae-4dac-8bcd-4ed6589e2db0`. Bare URL uses the real native adapter, not synthetic fallback. Parent owns actual browser/host acceptance; no browser automation performed by this implementer. Parent reported usable layout screenshots and stable synthetic `greeting` search; that is parent evidence, not this implementer's live-host pass. Source was frozen during that check, then final fixes announced before static-product recheck.

## Known limits

- Browser and live-host/OS integration are parent acceptance work and are not claimed here.
- Existing host copy APIs acknowledge dispatch only; UI says “Copy requested” and accurately rejects absent/false/thrown capability, but cannot confirm downstream OS write success.
- Browser preview uses artificial samples exclusively and requires `window.otools` to copy; no browser clipboard read/write fallback.
- Thumbnail loads are bounded to **12 per page / 3 concurrent**; one selected full image is loaded on demand. OTools invoke has no cancellation primitive, so request epochs discard late responses and disposal cancels queued work/listeners rather than claiming to abort already-running native calls.
- SDK optional host status remains source-only as supplied; initial UI depends only on native contract, not an unshipped host API.
