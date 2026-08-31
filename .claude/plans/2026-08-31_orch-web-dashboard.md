# Implementation Plan: Orch Web Dashboard

**Spec:** .claude/specs/2026-08-31_orch-web-dashboard/
**Created:** 2026-08-31

---

## Phase 1: Monorepo Restructure

### 1.1 -- Create workspace root package.json
**File:** `package.json` (repo root, replaces current CLI package.json at root)
- Set `"name": "orchestrator-workspace"`, `"private": true`
- Set `"workspaces": ["packages/*"]`
- Move devDependencies that are workspace-wide (TypeScript, Vitest, ESLint) to root
- Add `"scripts": { "build": "npm run build --workspaces --if-present", "test": "npm run test --workspaces --if-present" }`

### 1.2 -- Create packages/orchestrator-cli/ and move all existing source
**Action:** Move these paths from repo root into `packages/orchestrator-cli/`:
- `src/` -> `packages/orchestrator-cli/src/`
- `bin/` -> `packages/orchestrator-cli/bin/`
- `tray-go/` -> `packages/orchestrator-cli/tray-go/`
- `launcher-go/` -> `packages/orchestrator-cli/launcher-go/`
- `scripts/` -> `packages/orchestrator-cli/scripts/`
- `ci/` -> `packages/orchestrator-cli/ci/`
- `test/` -> `packages/orchestrator-cli/test/`
- `tsconfig.json` -> `packages/orchestrator-cli/tsconfig.json`
- `tsconfig.test.json` -> `packages/orchestrator-cli/tsconfig.test.json` (if exists)
- `vitest.config.ts` -> `packages/orchestrator-cli/vitest.config.ts`
- Current root `package.json` -> `packages/orchestrator-cli/package.json` (keep name `@wadeck-app/orchestrator-cli`)

**File: `packages/orchestrator-cli/package.json`**
- Keep `"name": "@wadeck-app/orchestrator-cli"` and all existing fields
- Keep `"bin"`, `"main"`, `"optionalDependencies"` unchanged
- Update any relative path references if needed (bin/orch.js stays as `"bin": { "orch": "bin/orch.js" }` -- still correct relative to package root)

### 1.3 -- Create root tsconfig.json
**File:** `tsconfig.json` (repo root)
```json
{
  "files": [],
  "references": [
    { "path": "packages/orchestrator-cli" },
    { "path": "packages/orch-server" },
    { "path": "packages/orch-ui" },
    { "path": "packages/orch-app" }
  ]
}
```

### 1.4 -- Add root .npmrc
**File:** `.npmrc` (repo root)
```
@wadeck-app:registry=https://npm.pkg.github.com
```

### 1.5 -- Update CI workflow paths
**File:** `.github/workflows/publish-orchestrator.yml`
- Change all `npm run build` -> still works (workspace root delegates)
- Change `npm run build-launcher` and `npm run build-tray` -> add `--workspace=packages/orchestrator-cli`
- Change `npm run bundle-updater` -> add `--workspace=packages/orchestrator-cli`
- Change `npm run test` -> still works (workspace root delegates)
- In "Generate platform package directories": `packages/orchestrator-cli-*` paths reference `packages/` -- verify `ci/scripts/generate-platform-packages.sh` uses paths relative to orchestrator-cli
- In "Set version in platform packages": change `(cd "packages/$pkg" && ...)` -- these are siblings of orchestrator-cli in packages/, still correct
- In "Publish" step: change `npm publish` -> `npm publish --workspace=packages/orchestrator-cli`

### 1.6 -- Verify Phase 1
- Run `npm install` from repo root
- Run `npm run build --workspace=packages/orchestrator-cli`
- Run `npm test --workspace=packages/orchestrator-cli`
- Run `node packages/orchestrator-cli/bin/orch.js --version`

---

## Phase 2: orch-server Package

### 2.1 -- Scaffold package
**File:** `packages/orch-server/package.json`
```json
{
  "name": "@wadeck-app/orch-server",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "scripts": {
    "build": "tsc --build tsconfig.json",
    "dev": "tsx watch src/index.ts",
    "test": "vitest run"
  },
  "dependencies": {
    "fastify": "^5.x",
    "@fastify/static": "^8.x",
    "@fastify/cors": "^10.x",
    "@wadeck-app/singleton-daemon-kit": "*"
  },
  "devDependencies": {
    "typescript": "*",
    "tsx": "*",
    "vitest": "*"
  }
}
```

**File:** `packages/orch-server/tsconfig.json`
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src/**/*"],
  "exclude": ["**/*.test.ts", "dist"]
}
```

### 2.2 -- Port discovery
**File:** `packages/orch-server/src/port.ts`
- Export `async function findFreePort(base: number): Promise<number>` -- tries `base` through `base + 10`, catches `EADDRINUSE`, returns first available
- Export `function writeDashboardPort(configDir: string, port: number, pid: number): void` -- writes `<configDir>/config.dashboard` as JSON `{ port, pid, startedAt: new Date().toISOString() }`
- Export `function deleteDashboardPort(configDir: string): void` -- deletes `<configDir>/config.dashboard` (no-throw)

### 2.3 -- Daemon RPC proxy
**File:** `packages/orch-server/src/daemon-proxy.ts`
- Export `function readDaemonPort(configDir: string): number | null` -- reads `<configDir>/config.port`, checks mtime <= 60s, returns port or null
- Export `class DaemonProxy` -- constructor takes `configDir`; has `send(command, payload)` that calls `createDaemonClient` from `@wadeck-app/singleton-daemon-kit`; throws `DaemonUnavailableError` if config.port is absent or stale

### 2.4 -- Idle timer
**File:** `packages/orch-server/src/idle-timer.ts`
- Export `class IdleTimer` -- constructor takes `timeoutMs: number, onIdle: () => void`
- Methods: `reset()` (clears and restarts timer), `addSseConnection()` / `removeSseConnection()` (tracks count; while count > 0, timer is paused; when count drops to 0, timer starts)
- Internal: `_sseCount: number`, `_timer: NodeJS.Timeout | null`

### 2.5 -- REST API routes
**File:** `packages/orch-server/src/routes/jobs.ts`
- Register Fastify plugin with routes:
  - `GET /api/jobs` -- calls `daemonProxy.send('list-jobs')` + `daemonProxy.send('list-state')`, merges, returns array of `{ job, lastRun }`
  - `GET /api/jobs/:id` -- calls `get-job` + checks state, returns `{ job, lastRun }`
  - `POST /api/jobs` -- calls `add-job` with body
  - `PUT /api/jobs/:id` -- calls `edit-job` with id + body
  - `DELETE /api/jobs/:id` -- calls `remove-job` with id
  - `POST /api/jobs/:id/trigger` -- calls `trigger-job` with id
  - `POST /api/jobs/:id/enable` -- calls `enable-job` with id
  - `POST /api/jobs/:id/disable` -- calls `disable-job` with id
- Each route calls `idleTimer.reset()`
- On `DaemonUnavailableError`: reply with `503 { error: 'daemon-not-running' }`

**File:** `packages/orch-server/src/routes/logs.ts`
- `GET /api/logs/:jobId/stream` -- validates `:jobId` against `/^[a-z0-9-]+$/i` (400 if invalid); builds path `path.join(configDir, 'logs', jobId + '.log')`; streams with SSE (`Content-Type: text/event-stream`); sends existing lines via `readline`, then watches with `fs.watch`; calls `idleTimer.addSseConnection()` on open, `idleTimer.removeSseConnection()` on close

**File:** `packages/orch-server/src/routes/heartbeat.ts`
- `POST /api/heartbeat` -- calls `idleTimer.reset()`, returns 204

### 2.6 -- Main server entry
**File:** `packages/orch-server/src/index.ts`
- Parse CLI args: `--config-dir`, `--daemon-port`, `--base-port` (default 47950)
- Create `IdleTimer` with timeout from `ORCH_DASHBOARD_IDLE_TIMEOUT_MS` env (default 600000)
- Create `DaemonProxy` with configDir
- Create Fastify instance, register `@fastify/cors` with `origin: ['http://localhost:<port>']`, register `@fastify/static` with root pointing to orch-app dist (path resolved relative to this package's dist/)
- Register all route plugins
- Call `findFreePort(basePort)`, bind to `127.0.0.1:<port>`
- Call `writeDashboardPort(configDir, port, process.pid)`
- On `idleTimer` idle callback: emit `{ type: 'idle-exit' }` to stdout (JSON line), call `deleteDashboardPort`, call `server.close()`, `process.exit(0)`
- On `SIGTERM`/`SIGINT`: `deleteDashboardPort`, `server.close()`, `process.exit(0)`

### 2.7 -- Tests
**File:** `packages/orch-server/src/idle-timer.test.ts` -- unit test IdleTimer (reset, SSE count pausing)
**File:** `packages/orch-server/src/port.test.ts` -- unit test findFreePort (mock net.createServer)

---

## Phase 3: orchestrator-cli Dashboard Manager

### 3.1 -- DashboardManager class
**File:** `packages/orchestrator-cli/src/dashboard-manager.ts`
- Mirrors `tray-process.ts` pattern
- Constructor: `(configDir: string, orchServerPath: string)`
- `start()` -- spawns `node orchServerPath --config-dir configDir --base-port 47950` as child process with piped stdio; sets up readline on stdout; handles `{ type: 'idle-exit' }` to update internal state; handles `close` event to mark server as stopped
- `stop()` -- sends SIGTERM to child, waits up to 3s, then SIGKILL
- `isRunning(): boolean`
- `getPort(): number | null` -- reads `<configDir>/config.dashboard`, returns port or null
- `openBrowser()` -- reads config.dashboard for port, spawns `explorer.exe http://localhost:<port>` on Windows or `open http://localhost:<port>` on macOS
- Emits `'stopped'` event when child exits unexpectedly (daemon can decide to restart or not)

### 3.2 -- Wire into daemon entry point
**File:** `packages/orchestrator-cli/src/index.ts`
- After `createDaemon()` resolves, instantiate `DashboardManager(configDir, orchServerBinaryPath)`
- `orchServerBinaryPath` = resolve `../../orch-server/dist/index.js` relative to this package (or via a platform package resolution similar to tray binary resolution)
- Add to `onShutdown` hook: `dashboardManager.stop()`
- Export `dashboardManager` for use by tray-manager

### 3.3 -- Resolve orch-server binary path
**File:** `packages/orchestrator-cli/src/dashboard-binary.ts`
- Export `function findOrchServerBinary(): string` -- resolves `packages/orch-server/dist/index.js` by walking up from `__dirname` to workspace root (similar to `_findBinary()` in tray-manager.ts)

### 3.4 -- Systray "Open Dashboard" item
**File:** `packages/orchestrator-cli/src/tray-manager.ts`
- In `_buildMenu()`: add new item after `sep1` / `status` items, before `sep3`:
  ```
  { id: 'open-dashboard', type: 'normal', title: 'Open Dashboard', enabled: true }
  ```
- In `_handleClick(id)`: add case `'open-dashboard'`:
  ```
  dashboardManager.isRunning()
    ? dashboardManager.openBrowser()
    : (await dashboardManager.start(), setTimeout(() => dashboardManager.openBrowser(), 800))
  ```

---

## Phase 4: orch-ui Package

### 4.1 -- Scaffold
**File:** `packages/orch-ui/package.json`
```json
{
  "name": "@wadeck-app/orch-ui",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "scripts": {
    "build": "tsc --build tsconfig.json",
    "test": "vitest run"
  },
  "dependencies": {
    "@wadeck-app/dsl-ui": "edge",
    "@wadeck-app/dsl-renderer": "edge",
    "lucide-react": "*"
  },
  "peerDependencies": { "react": "^19.0.0", "react-dom": "^19.0.0" }
}
```

**File:** `packages/orch-ui/tsconfig.json`
- Extends root tsconfig.base.json, outDir: dist, include: src/**/*

**File:** `packages/orch-ui/tailwind.config.ts`
- Content: `["./src/**/*.{ts,tsx}"]`, extend theme as needed

### 4.2 -- Types re-export
**File:** `packages/orch-ui/src/types.ts`
- Re-export `Job`, `RuntimeEntry` types from orchestrator-cli (or duplicate the interface -- avoid circular dep)

### 4.3 -- Components
Create one file per component in `packages/orch-ui/src/components/`:

**JobStatusBadge.tsx** -- props: `{ exitCode: number | null, running: boolean }`; renders a colored pill: green (exitCode === 0), red (exitCode !== null && !== 0), yellow (running), grey (null)

**NextFireCountdown.tsx** -- props: `{ job: Job }`; for cron: parse `job.schedule` with a cron-parser lib, compute next fire, render "fires in Xm Ys" updated via `setInterval`; for startup: render "on startup"; for once: render "once"

**TriggerButton.tsx** -- props: `{ jobId: string, onTrigger: (id: string) => Promise<void> }`; button "Run now" with loading spinner on click

**EnableToggle.tsx** -- props: `{ job: Job, onToggle: (id: string, enabled: boolean) => Promise<void> }`; toggle switch

**RunHistory.tsx** -- props: `{ lastRun: RuntimeEntry | null }`; single row table showing startedAt + exitCode (v1: one entry only)

**JobCard.tsx** -- props: `{ job: Job, lastRun: RuntimeEntry | null, onTrigger, onToggle }`; card layout using dsl-ui's `Section` or `HorizontalStack`; renders JobStatusBadge, NextFireCountdown, TriggerButton, EnableToggle

**JobForm.tsx** -- props: `{ initial?: Partial<Job>, onSubmit: (job: Partial<Job>) => Promise<void>, onCancel: () => void }`; uses dsl-ui Form, FieldText, FieldSelect, FieldNumber; shows schedule field only when type === 'cron', delaySeconds only when type === 'startup'; no extra fields for type === 'once'

**LogViewer.tsx** -- props: `{ jobId: string, apiBase: string }`; connects to `GET /api/logs/:jobId/stream` via EventSource; renders lines in a pre/code block; auto-scrolls to bottom unless user has scrolled up; disconnects EventSource on unmount

### 4.4 -- Index
**File:** `packages/orch-ui/src/index.ts`
- Export all 8 components and `types.ts`

---

## Phase 5: orch-app Package

### 5.1 -- Scaffold
**File:** `packages/orch-app/package.json`
```json
{
  "name": "@wadeck-app/orch-app",
  "version": "0.0.1",
  "private": true,
  "scripts": {
    "dev": "vite",
    "build": "tsc --noEmit && vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "@wadeck-app/orch-ui": "*",
    "@wadeck-app/dsl-ui": "edge",
    "@wadeck-app/dsl-renderer": "edge",
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "react-router-dom": "^7.0.0"
  }
}
```

**File:** `packages/orch-app/vite.config.ts`
- Plugin: `@vitejs/plugin-react`
- Build: `outDir: 'dist'`, `emptyOutDir: true`
- Base: `'/'`

**File:** `packages/orch-app/tailwind.config.ts`
- Content includes orch-ui src too: `["./src/**/*.{ts,tsx}", "../orch-ui/src/**/*.{ts,tsx}"]`

**File:** `packages/orch-app/index.html` -- minimal HTML shell with `<div id="root">` and `<script type="module" src="/src/main.tsx">`

### 5.2 -- API fetcher
**File:** `packages/orch-app/src/api.ts`
- Export typed fetch wrappers:
  - `listJobs(): Promise<{ job: Job, lastRun: RuntimeEntry | null }[]>`
  - `getJob(id: string): Promise<{ job: Job, lastRun: RuntimeEntry | null }>`
  - `addJob(data: Partial<Job>): Promise<Job>`
  - `editJob(id: string, data: Partial<Job>): Promise<Job>`
  - `deleteJob(id: string): Promise<void>`
  - `triggerJob(id: string): Promise<void>`
  - `enableJob(id: string): Promise<void>`
  - `disableJob(id: string): Promise<void>`
- All use `fetch('/api/...')` (same-origin)

### 5.3 -- Heartbeat hook
**File:** `packages/orch-app/src/hooks/useHeartbeat.ts`
- Uses `document.visibilityState` + `visibilitychange` event
- `setInterval` every 30s calling `fetch('/api/heartbeat', { method: 'POST' })`
- Clears interval on hidden or unmount

### 5.4 -- App root
**File:** `packages/orch-app/src/main.tsx` -- `ReactDOM.createRoot(document.getElementById('root')!).render(<App />)`

**File:** `packages/orch-app/src/App.tsx`
- Calls `useHeartbeat()` at root
- Wraps with `BrowserRouter` from react-router-dom
- Uses dsl-ui `RouterProvider` + `ThemeContext`

### 5.5 -- Pages
**File:** `packages/orch-app/src/pages/JobListPage.tsx`
- `useEffect` to fetch `listJobs()` on mount
- Renders search input (filter by label/command), filter chips (All / Cron / Startup / Once / Failed)
- Renders `<JobCard>` grid
- "Add job" button -> navigate to `/jobs/new`

**File:** `packages/orch-app/src/pages/JobDetailPage.tsx`
- Reads `:id` from `useParams()`
- Fetches `getJob(id)`
- Renders: label, type badge, EnableToggle, TriggerButton; readonly config fields; Edit link; "View logs" link; RunHistory; Delete button with `ConfirmDialog` from dsl-ui

**File:** `packages/orch-app/src/pages/LogViewerPage.tsx`
- Reads `:id` from `useParams()`
- Renders full-height `<LogViewer jobId={id} apiBase="" />`
- "Back to job" link

**File:** `packages/orch-app/src/pages/JobFormPage.tsx`
- Used for both `/jobs/new` and `/jobs/:id/edit`
- If `:id` present: fetches job, pre-fills `JobForm`
- On submit: calls `addJob` or `editJob`, then navigates to `/jobs/:id`

### 5.6 -- Router
**File:** `packages/orch-app/src/routes.tsx`
```tsx
<Routes>
  <Route path="/" element={<JobListPage />} />
  <Route path="/jobs/new" element={<JobFormPage />} />
  <Route path="/jobs/:id" element={<JobDetailPage />} />
  <Route path="/jobs/:id/edit" element={<JobFormPage />} />
  <Route path="/jobs/:id/logs" element={<LogViewerPage />} />
</Routes>
```

---

## Phase 6: Wire orch-app dist into orch-server

### 6.1 -- Build-time copy
**File:** `packages/orch-server/package.json` scripts
- Add `"prebuild": "npm run build --workspace=../orch-app && cp -r ../orch-app/dist ./public"` OR
- Add a `scripts/copy-app.ts` that copies `orch-app/dist` -> `orch-server/public` at build time

**Decision:** use CLI arg `--app-dir` pointing at the dist path. Default: path.resolve(__dirname, '../public'). This allows orch-server to be tested independently without orch-app built.

**File:** `packages/orch-server/src/index.ts` -- update @fastify/static root to `opts.appDir` (from `--app-dir` CLI arg or default)

### 6.2 -- SPA fallback
**File:** `packages/orch-server/src/index.ts`
- After registering @fastify/static, add `setNotFoundHandler`:
  ```ts
  fastify.setNotFoundHandler((req, reply) => {
    if (!req.url.startsWith('/api/')) {
      reply.sendFile('index.html')
    } else {
      reply.code(404).send({ error: 'not-found' })
    }
  })
  ```

---

## Phase 7: CI Update

### 7.1 -- Update publish-orchestrator.yml
**File:** `.github/workflows/publish-orchestrator.yml`
- After "Install dependencies" step, add before "Build TypeScript":
  ```yaml
  - name: Build orch-ui
    run: npm run build --workspace=packages/orch-ui

  - name: Build orch-app
    run: npm run build --workspace=packages/orch-app

  - name: Copy orch-app dist to orch-server
    run: cp -r packages/orch-app/dist packages/orch-server/public

  - name: Build orch-server
    run: npm run build --workspace=packages/orch-server
  ```
- "Build TypeScript" step -> change to `npm run build --workspace=packages/orchestrator-cli`

---

## Execution order

1. Phase 1 (monorepo) -- must complete and verify before any other phase
2. Phase 2 + Phase 4 -- can be done in parallel (no dependency between orch-server and orch-ui)
3. Phase 3 -- depends on Phase 2 complete (dashboard-manager needs orch-server to exist)
4. Phase 5 -- depends on Phase 4 (imports orch-ui components)
5. Phase 6 -- depends on Phase 2 + Phase 5
6. Phase 7 -- depends on all phases complete

## Files created/modified summary

| Phase | Files |
|---|---|
| 1 | package.json (root), tsconfig.json (root), .npmrc, packages/orchestrator-cli/* (moved), .github/workflows/publish-orchestrator.yml |
| 2 | packages/orch-server/package.json, tsconfig.json, src/index.ts, src/port.ts, src/daemon-proxy.ts, src/idle-timer.ts, src/routes/jobs.ts, src/routes/logs.ts, src/routes/heartbeat.ts, src/idle-timer.test.ts, src/port.test.ts |
| 3 | packages/orchestrator-cli/src/dashboard-manager.ts, dashboard-binary.ts, src/index.ts (modified), src/tray-manager.ts (modified) |
| 4 | packages/orch-ui/package.json, tsconfig.json, tailwind.config.ts, src/types.ts, src/components/*.tsx (8 files), src/index.ts |
| 5 | packages/orch-app/package.json, vite.config.ts, tailwind.config.ts, index.html, src/main.tsx, src/App.tsx, src/api.ts, src/hooks/useHeartbeat.ts, src/routes.tsx, src/pages/*.tsx (4 files) |
| 6 | packages/orch-server/src/index.ts (modified), packages/orch-server/package.json (modified) |
| 7 | .github/workflows/publish-orchestrator.yml (modified) |
