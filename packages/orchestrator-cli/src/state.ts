import fs from 'node:fs';
import type { RuntimeEntry, StateData } from './types.js';
import { atomicWriteJson, readJsonFile } from './fsUtil.js';

const MAX_HISTORY = 20;

/**
 * Whether a finished run counts against the job's health.
 *
 * One definition for every reader, because the answer used to be spelled out at each call site and a
 * skipped run then had to be excluded in each of them separately -- miss one and the job still shows
 * up red there. A null exitCode is a cancelled or orphaned run, which is not a fault of the job.
 */
export function isFailure(entry: RuntimeEntry): boolean {
  return !entry.skipped && entry.exitCode !== null && entry.exitCode !== 0;
}

export class State {
  private readonly _file: string;
  private _cache: Record<string, RuntimeEntry[]> | null = null;
  private _flushTimer: ReturnType<typeof setTimeout> | null = null;
  private _flushPending = false;
  private readonly _flushIntervalMs = 500; // batch writes every 500ms

  constructor(filePath: string) {
    this._file = filePath;
  }

  private _ensure(): void {
    if (this._cache !== null) return;
    try {
      if (fs.existsSync(this._file)) {
        const raw = readJsonFile<StateData>(this._file) ?? { jobs: {} };
        // Migrate legacy single-entry format: { jobs: { id: RuntimeEntry } } -> arrays
        const migrated: Record<string, RuntimeEntry[]> = {};
        for (const [id, value] of Object.entries(raw.jobs)) {
          if (Array.isArray(value)) {
            migrated[id] = value as RuntimeEntry[];
          } else if (value && typeof value === 'object') {
            migrated[id] = [value as RuntimeEntry];
          }
        }
        // Deduplicate entries that share the same startedAt (artifact of the old
        // record() bug that prepended the in-flight null-exitCode entry AND the final entry).
        // Keep only the entry with the non-null exitCode; fall back to the first if all are null.
        for (const id of Object.keys(migrated)) {
          const seen = new Map<string, RuntimeEntry>();
          for (const entry of migrated[id]!) {
            const prev = seen.get(entry.startedAt);
            if (!prev || (prev.exitCode === null && entry.exitCode !== null)) {
              seen.set(entry.startedAt, entry);
            }
          }
          // Preserve original order (most-recent first)
          migrated[id] = migrated[id]!.filter((e, i, arr) =>
            arr.findIndex(x => x.startedAt === e.startedAt) === i
              ? seen.get(e.startedAt) === e
              : false
          );
        }
        this._cache = migrated;
      } else {
        this._cache = {};
        this._doFlush();
      }
    } catch (e) {
      // On load failure, start with empty cache
      this._cache = {};
      const err = e instanceof Error ? e.message : String(e);
      try { process.stderr.write(`[State] Failed to load state: ${err}, starting with empty cache\n`); } catch { /* EPIPE */ }
    }
  }

  private _doFlush(): void {
    try {
      atomicWriteJson(this._file, { jobs: this._cache });
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      try { process.stderr.write(`[State] Failed to flush: ${err}\n`); } catch { /* EPIPE */ }
      throw e;
    }
  }

  private _scheduledFlush(): void {
    if (this._flushTimer !== null) return; // already scheduled
    this._flushPending = true;
    this._flushTimer = setTimeout(() => {
      this._flushTimer = null;
      if (this._flushPending) {
        this._flushPending = false;
        this._doFlush();
      }
    }, this._flushIntervalMs);
  }

  /**
   * Closes runs left open by a daemon that is no longer alive, and returns how many.
   *
   * Called once at startup. A run with no finishedAt was in flight when its daemon stopped, and no
   * later event can ever close it: the child is gone with the process that spawned it. Left alone
   * they accumulate and count as active forever, which is what made GET /health report running jobs
   * on an idle machine and made the updater defer every attempt.
   *
   * exitCode stays null so the run reads as interrupted rather than as a clean exit or a failure,
   * and `orphaned` records why finishedAt appeared without anyone observing the process end.
   */
  closeOrphanedRuns(now: Date = new Date()): number {
    this._ensure();
    let closed = 0;
    for (const [id, entries] of Object.entries(this._cache!)) {
      const next = entries.map(e => {
        if (e.finishedAt != null) return e;
        closed++;
        return { ...e, finishedAt: now.toISOString(), orphaned: true };
      });
      if (closed > 0) this._cache![id] = next;
    }
    if (closed > 0) this._scheduledFlush();
    return closed;
  }

  record(id: string, entry: RuntimeEntry): void {
    this._ensure();
    const normalized: RuntimeEntry = {
      startedAt: entry.startedAt,
      exitCode: entry.exitCode ?? null,
      pid: entry.pid ?? null,
      ...(entry.triggeredBy  !== undefined && { triggeredBy:  entry.triggeredBy  }),
      ...(entry.finishedAt   !== undefined && { finishedAt:   entry.finishedAt   }),
      ...(entry.acknowledgedAt !== undefined && { acknowledgedAt: entry.acknowledgedAt }),
      ...(entry.peakCpuPct      !== undefined && { peakCpuPct:      entry.peakCpuPct      }),
      ...(entry.peakRamMb       !== undefined && { peakRamMb:       entry.peakRamMb       }),
      ...(entry.cancelledByUser !== undefined && { cancelledByUser: entry.cancelledByUser }),
      ...(entry.orphaned        !== undefined && { orphaned:        entry.orphaned        }),
      ...(entry.skipped         !== undefined && { skipped:         entry.skipped         }),
    };
    const existing = this._cache![id] ?? [];
    // Update the matching entry in-place rather than prepending a duplicate. This covers
    // the start->finish pair the scheduler records: first call has exitCode=null
    // (in-flight), second has the actual exit code. Scanning the whole array (not just
    // the head) matters when runs overlap: otherwise the older run's completion is
    // prepended, leaving a finished entry at index 0 while a run is still in flight and
    // stranding the original in-flight entry as a permanent exitCode:null orphan.
    const idx = existing.findIndex(e => e.startedAt === normalized.startedAt);
    if (idx !== -1) {
      const next = [...existing];
      next[idx] = normalized;
      this._cache![id] = next;
    } else {
      this._cache![id] = [normalized, ...existing].slice(0, MAX_HISTORY);
    }
    this._scheduledFlush();
  }

  // State written before the overlapping-runs fix can be out of order, so the newest
  // entry is resolved by startedAt rather than by position. Returns the live object
  // (not a copy) so callers can mutate it in place.
  private _latest(entries: RuntimeEntry[]): RuntimeEntry | undefined {
    let newest: RuntimeEntry | undefined;
    for (const e of entries) {
      if (newest === undefined || e.startedAt > newest.startedAt) newest = e;
    }
    return newest;
  }

  get(id: string): RuntimeEntry | null {
    this._ensure();
    const arr = this._cache![id];
    if (!arr || arr.length === 0) return null;
    const latest = this._latest(arr);
    return latest === undefined ? null : { ...latest };
  }

  getAll(): Record<string, RuntimeEntry[]> {
    this._ensure();
    if (!fs.existsSync(this._file)) this._doFlush();
    const copy: Record<string, RuntimeEntry[]> = {};
    for (const [k, arr] of Object.entries(this._cache!)) {
      copy[k] = arr.map(e => ({ ...e }));
    }
    return copy;
  }

  getUnacknowledgedFailures(): Array<{ jobId: string; entry: RuntimeEntry }> {
    this._ensure();
    const result: Array<{ jobId: string; entry: RuntimeEntry }> = [];
    for (const [jobId, entries] of Object.entries(this._cache!)) {
      if (!entries || entries.length === 0) continue;
      const latest = this._latest(entries)!;
      if (isFailure(latest) && !latest.acknowledgedAt) {
        result.push({ jobId, entry: { ...latest } });
      }
    }
    return result;
  }

  acknowledgeAll(): void {
    this._ensure();
    const now = new Date().toISOString();
    let changed = false;
    for (const entries of Object.values(this._cache!)) {
      if (!entries || entries.length === 0) continue;
      const latest = this._latest(entries)!;
      if (isFailure(latest) && !latest.acknowledgedAt) {
        latest.acknowledgedAt = now;
        changed = true;
      }
    }
    if (changed) this._scheduledFlush();
  }

  getRollingAvgDurationMs(id: string, n = 10): number | null {
    this._ensure();
    const entries = this._cache![id] ?? [];
    const completed = entries
      .filter(e => e.exitCode !== null && e.finishedAt)
      .slice(0, n);
    if (completed.length < 3) return null;
    const total = completed.reduce((sum, e) => {
      return sum + (new Date(e.finishedAt!).getTime() - new Date(e.startedAt).getTime());
    }, 0);
    return total / completed.length;
  }

  getUptimePercent(id: string, windowDays = 30): number | null {
    this._ensure();
    const cutoff = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();
    // Skipped runs leave the sample entirely: counting them as downtime punishes a job for correctly
    // declining to run, and counting them as uptime would invent availability nothing demonstrated.
    const entries = (this._cache![id] ?? [])
      .filter(e => e.startedAt >= cutoff && e.exitCode !== null && !e.skipped);
    if (entries.length < 3) return null;
    const successes = entries.filter(e => e.exitCode === 0).length;
    return (successes / entries.length) * 100;
  }

  getResourceBaseline(id: string, n = 10): { cpuPct: number; ramMb: number } | null {
    this._ensure();
    // Only use successful runs - failed/killed runs have abnormal resource usage that would bias the baseline
    const entries = (this._cache![id] ?? [])
      .filter(e => e.exitCode === 0 && e.peakCpuPct != null && e.peakRamMb != null)
      .slice(0, n);
    if (entries.length < 3) return null;
    const cpuPct = entries.reduce((s, e) => s + (e.peakCpuPct ?? 0), 0) / entries.length;
    const ramMb  = entries.reduce((s, e) => s + (e.peakRamMb  ?? 0), 0) / entries.length;
    return { cpuPct, ramMb };
  }

  getConsecutiveFailures(id: string): number {
    this._ensure();
    const entries = this._cache![id] ?? [];
    let count = 0;
    for (const e of entries) {
      // Transparent, not neutral: a skip must not add to the streak, and must not end it either.
      // Ending it would let a job alternating "fail, skip, fail" escape the consecutive-failure alert.
      if (e.skipped) continue;
      if (isFailure(e)) count++;
      else break;
    }
    return count;
  }

  clear(id: string): void {
    this._ensure();
    if (this._cache![id] !== undefined) {
      delete this._cache![id];
      this._scheduledFlush();
    }
  }

  shutdown(): void {
    if (this._flushTimer !== null) {
      clearTimeout(this._flushTimer);
      this._flushTimer = null;
    }
    if (this._flushPending) {
      this._flushPending = false;
      this._doFlush();
    }
  }
}
