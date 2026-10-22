import fs from 'node:fs';
import path from 'node:path';
import type { ResourceEnforce } from './types.js';
import type { ResourceThreshold } from './resource-limits.js';

/** Runs kept per job. A line is about 300 bytes, so a full file is about 150 KB. */
export const RESOURCE_HISTORY_RETENTION = 500;
export const RESOURCE_HISTORY_DEFAULT_LIMIT = 100;

/** Same rule as the logs route and the telemetry files: an id is a file name here, so it cannot carry a path. */
const JOB_ID_RE = /^[a-z0-9-]+$/i;

/** What one closed run consumed, kept long after its telemetry has been rotated away. */
export interface ResourceHistoryRecord {
  startedAt:   string;
  finishedAt:  string;
  durationMs:  number;
  /** Null for a run the user cancelled. */
  exitCode:    number | null;
  /** Why the run was ended by force; absent for a run that ended on its own. */
  endReason?:  'timeout' | 'manual-kill' | 'resource-limit';
  peakCpuPct:  number;
  peakRamMb:   number;
  /** Mean of the samples this daemon took of the run; null when it took none. */
  avgCpuPct:   number | null;
  avgRamMb:    number | null;
  samples:     number;
  /** The budgets the run was held to; null when none existed (no baseline yet, nothing absolute set). */
  soft:        { cpuPct: number; ramMb: number } | null;
  hard:        ResourceThreshold | null;
  enforce:     ResourceEnforce;
}

/** What `get-resource-history` answers. */
export interface ResourceHistory {
  /** Newest first. */
  runs:      ResourceHistoryRecord[];
  /** Runs stored for the job, whatever the limit asked. */
  total:     number;
  retention: number;
}

export function resourceHistoryDir(configDir: string): string {
  return path.join(configDir, 'resource-history');
}

export function resourceHistoryPath(configDir: string, jobId: string): string {
  if (!JOB_ID_RE.test(jobId)) {
    throw new Error(`resource history: "${jobId}" is not a valid job id (letters, digits and "-" only), refusing to build a file name from it.`);
  }
  return path.join(resourceHistoryDir(configDir), `${jobId}.ndjson`);
}

function readLines(file: string): string[] {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw err;
  }
  return text.split('\n').filter(l => l !== '');
}

/**
 * Appends one run. Throws on failure: the caller reports it once in the run's log and carries on, since
 * the history is a record, never a duty.
 *
 * Over RESOURCE_HISTORY_RETENTION lines the file is rewritten whole through a temp file and a rename, so
 * a crash leaves either the old file or the trimmed one, never half of each.
 */
export function appendResourceHistory(configDir: string, jobId: string, record: ResourceHistoryRecord): void {
  const file = resourceHistoryPath(configDir, jobId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const line = JSON.stringify(record);
  const existing = readLines(file);
  if (existing.length < RESOURCE_HISTORY_RETENTION) {
    fs.appendFileSync(file, line + '\n');
    return;
  }
  const kept = [...existing, line].slice(-RESOURCE_HISTORY_RETENTION);
  const tmp = `${file}.tmp`;
  try {
    fs.writeFileSync(tmp, kept.join('\n') + '\n', { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* not written */ }
    throw err;
  }
}

/** The newest `limit` runs of a job. A line that does not parse (cut by a crash) is skipped and not counted. */
export function readResourceHistory(configDir: string, jobId: string, limit = RESOURCE_HISTORY_DEFAULT_LIMIT): ResourceHistory {
  const runs: ResourceHistoryRecord[] = [];
  for (const raw of readLines(resourceHistoryPath(configDir, jobId))) {
    try {
      const parsed = JSON.parse(raw) as ResourceHistoryRecord;
      if (typeof parsed === 'object' && parsed !== null && typeof parsed.startedAt === 'string') {
        runs.push(parsed);
      }
    } catch {
      // A torn line: the rest of the file is still good.
    }
  }
  return { runs: runs.slice(-limit).reverse(), total: runs.length, retention: RESOURCE_HISTORY_RETENTION };
}
