# CI speed and test discipline

Only what is still open. The SPA cache, the stale `config.dashboard` and the tracked `bash.exe.stackdump` are done.

## Decisions

- **No caches in private repos.** Free mode is to be preserved there. The caching in this workflow is acceptable only because this repo is public. Never carry the pattern into a private repo.
- **Never mention private repos, their names or their billing in this repo.** It is public.
- **No branches** unless explicitly asked. Commit straight to `main`.
- **No real time in tests.** Everything must be controlled.
- **Test scope rule: all platforms by default, ubuntu-only on an explicit decision.** A new test file runs on all three runners until someone deliberately marks it otherwise. Never the reverse.
- After every push whose outcome matters: `queue wait ci <sha>`, no manual `sleep` loops.

## Open

### 1. Test categorisation

`npm test` in `orchestrator-cli` is one flat glob (`node --test --require tsx/cjs test/**/*.test.js`) and nothing is categorised. The Windows and macOS legs run the full suite.

Mechanism to build, respecting the scope rule:
- An in-file marker, e.g. `// @test-scope ubuntu-only -- <reason>`, so the decision sits next to the test and no marker means "runs everywhere".
- A small runner (`scripts/run-tests.mjs`) that collects files and drops the marked ones when asked. `npm test` with no flag keeps running everything.
- Windows and macOS legs pass the flag; ubuntu runs everything.

The premise is weak: `packages/orchestrator-cli/scripts/time-tests.mjs` (header comment) found 2 files taking 47 s of a 72 s total, the other ~52 at 0.1-0.9 s each. Re-measure before categorising, and classify file by file: marking a file ubuntu-only removes its Windows coverage, the exact failure the 3-OS matrix was added to prevent.

### 2. Remove real time from the tests

`FakeTime` exists (`src/time-service.ts`). Still on real time: `job-peaks` (allows itself 20 s), several scheduler tests and the resource-monitor tests (`resource-limits-monitor`). The resource monitor itself uses raw `Date.now()` for `samplingSince` and `peakFlushedAt` while its timer goes through `this._time.every()`: inject both before extending `FakeTime` into it.

Two tests keep the real clock on purpose: `systemTime is the real clock` in `time-service.test.js` verifies the adapter itself, and waits for a condition rather than a wall-clock window.

### 3. `publish` reuses the matrix output

`publish` restores the SPA from the cache but still rebuilds orch-server, the module and the Go binaries (~40 s). Needs `upload-artifact` with `retention-days: 1` and minimal contents (dist dirs and binaries, never `node_modules`); take the binaries from ubuntu so their provenance does not change.

### 4. Cross-host binary determinism is unproven

Three builds on one host matched byte for byte, including one with a cold `GOCACHE`; the only cross-host comparison differed because the Go toolchains differed (read with `go version <exe>`). It matters only if per-OS binary builds are adopted; the Go patch is pinned, which is the prerequisite.

### 5. `orch trigger --wait` printing `exit ?`

No `exit ?` string is left in `src/`; the CLI message when the daemon answers `{pid}` was not re-checked. Verify, then close.
