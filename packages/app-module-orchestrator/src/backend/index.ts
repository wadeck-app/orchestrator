import type { ModuleContext } from '@wadeck-app/app-core-sdk';
import { DaemonProxy } from '@wadeck-app/orch-server/daemon-proxy';
import { jobsRoutes } from '@wadeck-app/orch-server/routes/jobs';
import { logsRoutes, type LogsTimers } from '@wadeck-app/orch-server/routes/logs';
import { openRoute } from '@wadeck-app/orch-server/routes/open';
import { createRouteAdapter } from './adapter.js';
import { getOrchConfigDir } from './configDir.js';
import { ALLOWED_ROUTES } from './routes.js';

export interface BackendDeps {
  configDir: string;
  proxy: Pick<DaemonProxy, 'send'>;
}

/** What the backend uses of the module context beyond the routes: timers, so app-core can clear them on unload. */
export type BackendContext = Pick<ModuleContext, 'registerRoute' | 'setInterval' | 'clearInterval'>;

/**
 * app-core has no idle exit to postpone: the dashboard server shuts itself down when nobody looks at
 * it, app-core keeps running. The route files only need something to call.
 */
const NO_IDLE_TIMER = { reset: () => undefined, addSseConnection: () => undefined, removeSseConnection: () => undefined };

/**
 * The route files' timers, taken from the context. A raw setInterval would survive the module being
 * unloaded or swapped; the context's are cleared by app-core, and each stream also releases its own
 * when the reader leaves.
 */
function contextTimers(ctx: BackendContext): LogsTimers {
  return {
    setInterval: (fn, ms) => ctx.setInterval(fn, ms),
    clearInterval: (handle) => { ctx.clearInterval(handle as ReturnType<BackendContext['setInterval']>); },
  };
}

/**
 * Runs orch-server's own route files inside the module, so the dashboard server and the module
 * answer identically and there is one implementation to keep right, not two.
 */
export function createBackend({ configDir, proxy }: BackendDeps): (ctx: BackendContext) => Promise<void> {
  return async (ctx) => {
    const { app, assertAllRegistered } = createRouteAdapter(ctx, ALLOWED_ROUTES);
    await jobsRoutes(app, { proxy, idleTimer: NO_IDLE_TIMER });
    await logsRoutes(app, { configDir, idleTimer: NO_IDLE_TIMER, timers: contextTimers(ctx) });
    await openRoute(app, { idleTimer: NO_IDLE_TIMER });
    assertAllRegistered();
  };
}

/**
 * The backend entry (fixed path src/backend/index.ts). app-core calls this once at module load with
 * the module's context; the routes land under /api/modules/orchestrator/.
 */
export default async function (ctx: ModuleContext): Promise<void> {
  const configDir = getOrchConfigDir();
  await createBackend({ configDir, proxy: new DaemonProxy(configDir) })(ctx);
}
