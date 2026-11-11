# Isolated stability and optimization regression checks

Run from the repository root with Node.js 24 (only built-in Node modules are used):

```powershell
npm test
```

This directory adds 181 isolated regressions to the existing `test/` suite. The
stabilization candidate was verified with 243 compatibility tests from pinned public
0.7.4 source and these regressions (424 passed); the release repository retains its
larger existing suite. The inventory here does not imply a packaged-app E2E pass.

The eleven regression files cover:

- `cards-stability.test.js`, `poller-stability.test.js`, `sp-client-validation.test.js`:
  13 earlier renderer-recreation, retry and malformed-list checks.
- `client-write-order.test.js`: 61 checks for FIFO ordering before token lookup,
  conditional stop, failure release without replay, and uncertain write outcomes.
- `main-tracking-order.test.js`: 4 checks executing the actual main-process
  `applyPomo`/`runEffect` code with the real client and in-memory fetch. Mixed
  pomodoro/manual intents use one queue; notification does not block it.
- `create-recovery.test.js`: 17 checks executing the actual card script with an
  in-memory DOM/IPC, plus actual main action/effect boundaries. Unknown creates
  preserve a locked draft through repaint and date/time-slot changes; definite
  rejections, explicit closing and unrelated later drafts remain usable.
- `snap-display.test.js`: 6 geometry checks for upper/lower displays, negative
  coordinates, intersecting displays and existing same-display stacking.
- `cards-display-recovery.test.js`: 4 checks that cancel stale drag/resize state
  before rescuing cards after display removal or display-metrics changes.
- `main-write-feedback.test.js`: 14 checks executing actual main menu/action
  boundaries and the real client with in-memory responses. Known rejection and
  unknown write outcomes have distinct feedback and do not trigger replay.
- `main-board-write-sync.test.js`: 32 checks for fresh task/tag/project reads,
  unrelated-label preservation, per-task FIFO ordering, captured presets,
  no-op moves, unsupported backlog/child moves and malformed-read rejection.
- `board-official-contract.test.js`: 30 checks against retained official SP 20
  default-board rules, canonical tag IDs, renderer guidance and the official
  completion cleanup. Pre-PATCH comparisons verify requested changes; separate
  checks execute the official reducer helper to verify that completion removes
  the progress tag while preserving ordinary tags, and undo returns to TODO.

The official harness retains eight complete, unmodified `sourcesContent` files
from the installed SP 20.0.0 archive. The fixture manifest pins the archive hash
and each full-file SHA256; missing files or hash drift fail the suite. The harness
executes the actual default configs, panel matching and change calculation. For
completion it extracts the actual `removeInProgressTagOnCompletion` function from
the hash-verified full reducer, requiring unique declaration and end boundaries.
It does not emulate the entire SP root store. Custom board configs, manual panel
ordering and date/priority custom-view rules are outside this default-board
contract; unsupported date/priority dependencies throw rather than silently pass.

The fixture is distributed under the upstream MIT license retained in
`support/official-sp20/LICENSE`. Its bytes are exempt from Git line-ending
conversion so a Windows checkout preserves the manifest hashes.

To run the original 13 source-selectable checks against a separately retained
baseline, set `SPW_TEST_SOURCE_ROOT` to its extracted source directory:

```powershell
$env:SPW_TEST_SOURCE_ROOT = (Resolve-Path ..\baseline-0.9.2).Path
node --test tests/cards-stability.test.js tests/poller-stability.test.js tests/sp-client-validation.test.js
Remove-Item Env:SPW_TEST_SOURCE_ROOT
```

`SPW_TEST_SOURCE_ROOT` selects module source for the import helper. The renderer
and main integration harnesses read this repository directly; do not use
that variable to claim a baseline run of every test. No regression test reads
production settings or tokens, starts Electron, or contacts an HTTP server.
Responses, BrowserWindow, display information, and timers are injected in memory.

Coverage includes renderer crashes with delayed recreation, preserved global hiding and saved layout, intentional closure, quit, clean exits, stale renderer events, throwing data/error callbacks, malformed-list rejection, last-good-snapshot retention, automatic recovery, and stopping with pending work or retries.

The untouched 0.9.2 baseline is expected to fail the original new recovery assertions.
These tests
demonstrate behavior under injected events; actual Electron renderer termination
and Windows native-window behavior require separate isolated Electron checks.

The accepted stabilization candidate also underwent separate Electron and SP 20
integration checks with temporary userData, synthetic tasks and an isolated
non-default loopback port. Those local audit tools are not part of this repository.
Run `npm run smoke` with `SPW_EXE` pointing to a packaged application to exercise
the repository's fake-SP startup and screenshot checks. Passing in-memory tests
or fake-SP checks does not establish actual SP synchronization. FIFO guarantees
apply only within this client; the server does not provide an atomic conditional
stop across clients.
