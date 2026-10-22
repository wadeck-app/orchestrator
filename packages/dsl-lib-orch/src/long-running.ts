/**
 * Whether a job is long-running: declared with no timeout (`timeoutSeconds: 0`, "for a process that must stay
 * up"). The dashboard offers Restart only for such a job.
 *
 * The daemon's tray decides the same thing with its own copy, `isLongRunning` in
 * orchestrator-cli/src/long-running.ts (dsl-lib-orch cannot import the CLI). test/long-running-parity.test.ts
 * fails if the two diverge; change both together. This is the only place on this side that may test
 * `timeoutSeconds` against 0 for that purpose.
 */
export function isLongRunning(job: { timeoutSeconds?: number }): boolean {
  return job.timeoutSeconds === 0;
}
