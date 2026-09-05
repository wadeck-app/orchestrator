import fs from 'node:fs';
import type { RuntimeEntry, StateData } from './types.js';
import { atomicWriteJson, readJsonFile } from './fsUtil.js';

const MAX_HISTORY = 20;

export class State {
  private readonly _file: string;
  private _cache: Record<string, RuntimeEntry[]> | null = null;

  constructor(filePath: string) {
    this._file = filePath;
  }

  private _ensure(): void {
    if (this._cache !== null) return;
    if (fs.existsSync(this._file)) {
      const raw = readJsonFile<StateData>(this._file) ?? { jobs: {} };
      // Migrate legacy single-entry format: { jobs: { id: RuntimeEntry } } → arrays
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
      this._flush();
    }
  }

  private _flush(): void {
    atomicWriteJson(this._file, { jobs: this._cache });
  }

  record(id: string, entry: RuntimeEntry): void {
    this._ensure();
    const normalized: RuntimeEntry = {
      startedAt: entry.startedAt,
      exitCode: entry.exitCode ?? null,
      pid: entry.pid ?? null,
      ...(entry.triggeredBy !== undefined && { triggeredBy: entry.triggeredBy }),
    };
    const existing = this._cache![id] ?? [];
    // If the most-recent entry has the same startedAt, update it in-place rather than
    // prepending a duplicate. This covers the start→finish pair the scheduler records:
    // first call has exitCode=null (in-flight), second has the actual exit code.
    const head = existing[0];
    if (head && head.startedAt === normalized.startedAt) {
      this._cache![id] = [normalized, ...existing.slice(1)];
    } else {
      this._cache![id] = [normalized, ...existing].slice(0, MAX_HISTORY);
    }
    this._flush();
  }

  get(id: string): RuntimeEntry | null {
    this._ensure();
    const arr = this._cache![id];
    if (!arr || arr.length === 0) return null;
    return { ...arr[0] };
  }

  getAll(): Record<string, RuntimeEntry[]> {
    this._ensure();
    if (!fs.existsSync(this._file)) this._flush();
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
      const latest = entries[0]!;
      if (latest.exitCode !== null && latest.exitCode !== 0 && !latest.acknowledgedAt) {
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
      const latest = entries[0]!;
      if (latest.exitCode !== null && latest.exitCode !== 0 && !latest.acknowledgedAt) {
        latest.acknowledgedAt = now;
        changed = true;
      }
    }
    if (changed) this._flush();
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
    const entries = (this._cache![id] ?? []).filter(e => e.startedAt >= cutoff && e.exitCode !== null);
    if (entries.length < 3) return null;
    const successes = entries.filter(e => e.exitCode === 0).length;
    return (successes / entries.length) * 100;
  }

  getConsecutiveFailures(id: string): number {
    this._ensure();
    const entries = this._cache![id] ?? [];
    let count = 0;
    for (const e of entries) {
      if (e.exitCode !== null && e.exitCode !== 0) count++;
      else break;
    }
    return count;
  }

  clear(id: string): void {
    this._ensure();
    if (this._cache![id] !== undefined) {
      delete this._cache![id];
      this._flush();
    }
  }
}
