import { describe, it, expect } from 'vitest';
import { isRunActive, isRunCancelled, isRunFailed, isRunSkipped, runEndReason, type RuntimeEntry } from './types.js';

function run(over: Partial<RuntimeEntry>): RuntimeEntry {
  return { startedAt: '2026-09-02T10:00:00Z', finishedAt: '2026-09-02T10:00:01Z', exitCode: 0, pid: 1, ...over };
}

// The whole point of the flag: the daemon decided the run was a non-event, so none of the
// alarm-raising classifications may claim it, whatever the exit code says.
describe('isRunSkipped', () => {
  it('is true only when the daemon marked the run skipped', () => {
    expect(isRunSkipped(run({ skipped: true, exitCode: 2 }))).toBe(true);
    expect(isRunSkipped(run({ exitCode: 2 }))).toBe(false);
    expect(isRunSkipped(null)).toBe(false);
  });

  it('holds when the daemon never spawned anything, so there is no exit code', () => {
    expect(isRunSkipped(run({ skipped: true, exitCode: null }))).toBe(true);
  });
});

describe('skipped runs are neither failed nor cancelled', () => {
  // A scraper exiting 2 because a sibling holds its lock used to render red.
  it('does not count a skipped non-zero exit as a failure', () => {
    expect(isRunFailed(run({ skipped: true, exitCode: 2 }))).toBe(false);
    expect(isRunFailed(run({ exitCode: 2 }))).toBe(true);
  });

  // exitCode null normally means "killed by signal", which is what produced the bogus
  // "Cancelled" label on runs the daemon simply declined to start.
  it('does not count a skipped run without an exit code as cancelled', () => {
    expect(isRunCancelled(run({ skipped: true, exitCode: null }))).toBe(false);
    expect(isRunCancelled(run({ exitCode: null }))).toBe(true);
  });

  // Contradictory input, and skipped is the authoritative marker, so it wins.
  it('lets skipped win over cancelledByUser', () => {
    expect(isRunCancelled(run({ skipped: true, cancelledByUser: true, exitCode: null }))).toBe(false);
  });

  it('is not active: a skipped run has finished', () => {
    expect(isRunActive(run({ skipped: true, exitCode: null }))).toBe(false);
  });
});

describe('runEndReason', () => {
  const finished = (extra: Partial<RuntimeEntry>): RuntimeEntry => ({ startedAt: '2026-09-02T10:00:00Z', finishedAt: '2026-09-02T10:01:00Z', exitCode: 1, pid: 1, ...extra });

  it('returns the recorded reason', () => {
    expect(runEndReason(finished({ endReason: 'timeout' }))).toBe('timeout');
  });

  it('reads a legacy cancelledByUser entry as a manual kill', () => {
    expect(runEndReason(finished({ exitCode: null, cancelledByUser: true }))).toBe('manual-kill');
  });

  it('never invents a reason for a legacy null exit code', () => {
    expect(runEndReason(finished({ exitCode: null }))).toBeUndefined();
  });

  it('has none for a skipped, an active or a missing run', () => {
    expect(runEndReason(finished({ skipped: true, endReason: 'timeout' }))).toBeUndefined();
    expect(runEndReason({ startedAt: '2026-09-02T10:00:00Z', exitCode: null, pid: 1, endReason: 'timeout' })).toBeUndefined();
    expect(runEndReason(null)).toBeUndefined();
  });
});
