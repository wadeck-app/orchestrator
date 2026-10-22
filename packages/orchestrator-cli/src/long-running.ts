/**
 * Whether a job is long-running: declared with no timeout (`timeoutSeconds: 0`, "for a process that must stay
 * up"). The tray shows such a job as running for a few seconds only.
 *
 * The dashboard decides the same thing (Restart is offered only for it) with its own copy, `isLongRunning` in
 * packages/dsl-lib-orch/src/long-running.ts (the CLI cannot import dsl-lib-orch).
 * dsl-lib-orch/test/long-running-parity.test.ts fails if the two diverge; change both together. This is the only
 * place in the CLI that may test `timeoutSeconds` against 0 for that purpose.
 */
export function isLongRunning(job: { timeoutSeconds?: number }): boolean {
  return job.timeoutSeconds === 0;
}
