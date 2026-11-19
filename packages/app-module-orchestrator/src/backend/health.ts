import type { ModuleContext } from '@wadeck-app/app-core-sdk';
import { DaemonUnavailableError, type DaemonProxy } from '@wadeck-app/orch-core/daemon-proxy';

/** One line of the answer app-core-cli reads: what was tested, whether it held, and why not. */
export interface HealthCheck {
  name: string;
  ok: boolean;
  detail?: string;
}

type Proxy = Pick<DaemonProxy, 'send'>;

/** The daemon answers these from memory (the audit from the end of one file); three seconds is already a failure. */
const TIMEOUT_MS = 3000;

/**
 * `GET /api/modules/orchestrator/health`: what app-core-cli asks before it switches to a new version (module-authoring.md, "Update
 * test of app-core-cli"). The format is fixed by that reader; nothing else may be served here.
 *
 * Once a module answers here, app-core stops testing its pages, so this tests what they read: the daemon, then one daemon command
 * per page (jobs, schedule, audit, failures), the same ones the module's routes send. Read-only, all in parallel, so the whole
 * answer takes as long as the slowest command (3 s at most).
 *
 * A daemon that does not answer is one check, not five that say the same: nothing else can be tested without it. It only refuses
 * an update when the running app-core answers ok here, so a daemon stopped on purpose is a warning, not a block.
 */
export function registerHealthRoute(ctx: Pick<ModuleContext, 'registerRoute'>, proxy: Proxy): void {
  ctx.registerRoute('GET', '/health', async (_req, reply) => {
    const daemon = await check('daemon', async () => {
      const info = await ask(proxy, 'get-daemon-info') as { version?: unknown } | undefined;
      return `answers${typeof info?.version === 'string' ? ` (version ${info.version})` : ''}`;
    });
    const checks = daemon.ok ? [daemon, ...await pageChecks(proxy)] : [daemon];
    return reply.send({ ok: checks.every((c) => c.ok), checks });
  });
}

function pageChecks(proxy: Proxy): Promise<HealthCheck[]> {
  return Promise.all([
    check('jobs', async () => {
      const [jobs, state] = await Promise.all([ask(proxy, 'list-jobs'), ask(proxy, 'list-state')]);
      requireList(jobs, 'list-jobs');
      requireObject(state, 'list-state');
      return `${jobs.length} job${jobs.length === 1 ? '' : 's'}`;
    }),
    check('schedule', async () => {
      requireList(await ask(proxy, 'get-schedule'), 'get-schedule');
      return 'answers';
    }),
    check('audit', async () => {
      requireList(await ask(proxy, 'list-audit', { limit: 1 }), 'list-audit');
      return 'answers';
    }),
    check('failures', async () => {
      requireList(await ask(proxy, 'list-failures'), 'list-failures');
      return 'answers';
    }),
  ]);
}

function ask(proxy: Proxy, command: string, payload?: unknown): Promise<unknown> {
  return proxy.send(command, payload, { timeoutMs: TIMEOUT_MS });
}

function requireList(value: unknown, command: string): asserts value is unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${command} did not answer a list (got ${value === null ? 'null' : typeof value})`);
  }
}

function requireObject(value: unknown, command: string): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${command} did not answer an object (got ${Array.isArray(value) ? 'a list' : value === null ? 'null' : typeof value})`);
  }
}

/** Never throws: a failure is the check's own answer, with the daemon's reason or the command to run. */
async function check(name: string, run: () => Promise<string>): Promise<HealthCheck> {
  try {
    return { name, ok: true, detail: await run() };
  } catch (e) {
    if (e instanceof DaemonUnavailableError) {
      return { name, ok: false, detail: 'the orchestrator daemon does not answer: start it with `orch start`, and see `orch logs` if it does not stay up' };
    }
    return { name, ok: false, detail: `${name === 'daemon' ? 'the orchestrator daemon failed' : 'the daemon could not answer this page'}: ${e instanceof Error ? e.message : String(e)}` };
  }
}
