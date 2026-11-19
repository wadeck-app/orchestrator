import type { ModuleContext } from '@wadeck-app/app-core-sdk';
import { DaemonUnavailableError, type DaemonProxy } from '@wadeck-app/orch-core/daemon-proxy';

/** One line of the answer app-core-cli reads: what was tested, whether it held, and why not. */
export interface HealthCheck {
  name: string;
  ok: boolean;
  detail?: string;
}

/**
 * `GET /api/modules/orchestrator/health`: what app-core-cli asks before it switches to a new version (module-authoring.md, "Update
 * test of app-core-cli"). The format is fixed by that reader; nothing else may be served here.
 *
 * What it tests: the orchestrator daemon answers. That is the one thing every page of this module depends on. Read-only and fast
 * (the daemon answers `get-daemon-info` from memory). A stopped daemon is a failed check, and it only refuses an update when the
 * running server answers ok here, so a machine whose daemon has been stopped on purpose is warned, not blocked.
 */
export function registerHealthRoute(ctx: Pick<ModuleContext, 'registerRoute'>, proxy: Pick<DaemonProxy, 'send'>): void {
  ctx.registerRoute('GET', '/health', async (_req, reply) => {
    const checks: HealthCheck[] = [await daemonCheck(proxy)];
    return reply.send({ ok: checks.every((c) => c.ok), checks });
  });
}

async function daemonCheck(proxy: Pick<DaemonProxy, 'send'>): Promise<HealthCheck> {
  try {
    const info = await proxy.send('get-daemon-info') as { version?: unknown } | undefined;
    const version = typeof info?.version === 'string' ? ` (version ${info.version})` : '';
    return { name: 'daemon', ok: true, detail: `answers${version}` };
  } catch (e) {
    if (e instanceof DaemonUnavailableError) {
      return { name: 'daemon', ok: false, detail: 'the orchestrator daemon does not answer: start it with `orch start`, and see `orch logs` if it does not stay up' };
    }
    return { name: 'daemon', ok: false, detail: `the orchestrator daemon failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}
