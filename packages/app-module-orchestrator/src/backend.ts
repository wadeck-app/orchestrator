import type { ModuleContext } from '@wadeck-app/app-core-sdk';
import { DaemonProxy } from '@wadeck-app/orch-server/daemon-proxy';
import { jobsRoutes } from '@wadeck-app/orch-server/routes/jobs';
import { logsRoutes } from '@wadeck-app/orch-server/routes/logs';
import { createRouteAdapter } from './adapter.js';
import { getOrchConfigDir } from './configDir.js';
import { ALLOWED_ROUTES } from './routes.js';

export interface BackendDeps {
  configDir: string;
  proxy: Pick<DaemonProxy, 'send'>;
}

/**
 * app-core has no idle exit to postpone: the dashboard server shuts itself down when nobody looks at
 * it, app-core keeps running. The route files only need something to call.
 */
const NO_IDLE_TIMER = { reset: () => undefined, addSseConnection: () => undefined, removeSseConnection: () => undefined };

/**
 * Runs orch-server's own route files inside the module, so the dashboard server and the module
 * answer identically and there is one implementation to keep right, not two.
 */
export function createBackend({ configDir, proxy }: BackendDeps): (ctx: ModuleContext) => Promise<void> {
  return async (ctx) => {
    const { app, assertAllRegistered } = createRouteAdapter(ctx, ALLOWED_ROUTES);
    await jobsRoutes(app, { proxy, idleTimer: NO_IDLE_TIMER });
    await logsRoutes(app, { configDir, idleTimer: NO_IDLE_TIMER });
    assertAllRegistered();
  };
}

/**
 * backendEntryPath target declared in manifest.json. app-core calls this once at module load with
 * the module's context; the routes land under /api/modules/orchestrator/.
 */
export default async function (ctx: ModuleContext): Promise<void> {
  const configDir = getOrchConfigDir();
  await createBackend({ configDir, proxy: new DaemonProxy(configDir) })(ctx);
}
