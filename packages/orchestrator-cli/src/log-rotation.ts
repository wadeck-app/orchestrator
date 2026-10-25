/**
 * Size-based rotation of the log of ONE run (`logRotation` on a job, `logMaxSizeMb` / `logKeepSegments` in config.yml).
 *
 * A run used to have one log file, so a server job (`--timeout 0`) wrote one file that only grew. Now, once the current
 * segment of a run would pass `maxSizeMb`, the next line starts the next segment of the SAME run, and the oldest segments
 * beyond `keepSegments` are deleted.
 *
 * Segment naming (no rename ever: on Windows a file cannot be renamed while the other writer has it open):
 *   <id>-<stamp>.log        segment 1: the plain run file, exactly what every reader already knew
 *   <id>-<stamp>.log.<n>    segment n >= 2
 * A reader that only knows `*.log` still sees the first segment and ignores the others; the retained segments are numbered
 * upward, so the order is the numeric order of the suffix.
 *
 * Two writers append to the same run (the daemon with its markers, the supervisor with the job's output; see
 * supervisor-go/run.go, which implements the same rules). They never talk to each other: each one follows the files.
 */

import fs from 'node:fs';
import path from 'node:path';

export const LOG_ROTATION_KEYS = ['maxSizeMb', 'keepSegments'] as const;

/** The defaults when neither the job nor config.yml say otherwise: 5 segments of 50 MB, so a run keeps at most ~250 MB of log. */
export const LOG_ROTATION_DEFAULTS = { maxSizeMb: 50, keepSegments: 5 } as const;

/** The smallest and largest `maxSizeMb`. 0 is "no rotation" and is accepted on its own. */
export const MAX_SIZE_MB_MIN = 0.001;
export const MAX_SIZE_MB_MAX = 10240;
export const KEEP_SEGMENTS_MAX = 1000;

const BYTES_PER_MB = 1048576;

/** The `logRotation` setting of a job. Every key is optional; a missing one is the daemon-wide value. */
export interface LogRotation {
  /** A segment is closed when the next line would take it over this many MB (decimals allowed, min 0.001). 0 = never rotate. Default 50. */
  maxSizeMb?: number;
  /** How many segments of a run are kept, the newest ones, whole number 1-1000. Default 5. */
  keepSegments?: number;
}

/** What the writers use: bytes, with 0 meaning "no rotation". */
export interface ResolvedLogRotation {
  maxBytes: number;
  keepSegments: number;
}

function show(value: unknown): string {
  return typeof value === 'number' ? String(value) : (JSON.stringify(value) ?? String(value));
}

/**
 * Why `value` is not a valid `logRotation`, in a sentence that says what to do, or null when it is valid (absent and null
 * are valid: the daemon-wide values apply). Each message names the key as `logRotation.<key>`, which is how the CLI finds
 * the flag to point at.
 */
export function logRotationError(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    return `logRotation must be an object of options (got: ${show(value)}), e.g. {"maxSizeMb": 20, "keepSegments": 3}; `
      + 'back to the daemon-wide values: orch edit <id> --unset logRotation';
  }
  const options: Record<string, unknown> = Object.fromEntries(Object.entries(value));
  const given = Object.keys(options);
  if (given.length === 0) {
    return `logRotation is empty. Give at least one option (${LOG_ROTATION_KEYS.join(', ')}); `
      + 'to use the daemon-wide values: orch edit <id> --unset logRotation';
  }
  const unknown = given.find(k => !(LOG_ROTATION_KEYS as readonly string[]).includes(k));
  if (unknown !== undefined) {
    return `logRotation has an unknown key "${unknown}". Keys: ${LOG_ROTATION_KEYS.join(', ')}`;
  }
  const size = options['maxSizeMb'];
  if (size !== undefined) {
    if (typeof size !== 'number' || !Number.isFinite(size)) {
      return `logRotation.maxSizeMb must be a number of megabytes (got: ${show(size)}); 0 turns the rotation off`;
    }
    if (size < 0) {
      return `logRotation.maxSizeMb must not be negative (got: ${show(size)}); 0 turns the rotation off for this job`;
    }
    if (size > 0 && size < MAX_SIZE_MB_MIN) {
      return `logRotation.maxSizeMb must be at least ${MAX_SIZE_MB_MIN} (about 1 KB; got: ${show(size)}), or 0 to turn the rotation off`;
    }
    if (size > MAX_SIZE_MB_MAX) {
      return `logRotation.maxSizeMb must be at most ${MAX_SIZE_MB_MAX} (10 GB; got: ${show(size)}); 0 turns the rotation off`;
    }
  }
  const keep = options['keepSegments'];
  if (keep !== undefined && !(typeof keep === 'number' && Number.isInteger(keep) && keep >= 1 && keep <= KEEP_SEGMENTS_MAX)) {
    return `logRotation.keepSegments must be a whole number from 1 to ${KEEP_SEGMENTS_MAX} (got: ${show(keep)})`;
  }
  return null;
}

/** The limits a run is written with: the job's keys over the daemon-wide values. `maxSizeMb: 0` means no rotation. */
export function resolveLogRotation(setting: LogRotation | undefined | null, daemon: ResolvedLogRotation): ResolvedLogRotation {
  return {
    maxBytes: setting?.maxSizeMb !== undefined ? Math.round(setting.maxSizeMb * BYTES_PER_MB) : daemon.maxBytes,
    keepSegments: setting?.keepSegments ?? daemon.keepSegments,
  };
}

/** The daemon-wide values from config.yml (`logMaxSizeMb`, `logKeepSegments`). */
export function daemonLogRotation(config: { logMaxSizeMb: number; logKeepSegments: number }): ResolvedLogRotation {
  return { maxBytes: Math.round(config.logMaxSizeMb * BYTES_PER_MB), keepSegments: config.logKeepSegments };
}

/** A size limit as the drop marker and the help say it. The Go supervisor writes the same words. */
export function formatLimit(maxBytes: number): string {
  return maxBytes % BYTES_PER_MB === 0 ? `${maxBytes / BYTES_PER_MB} MB` : `${maxBytes} bytes`;
}

/** The path of segment `n` of the run whose first segment is `firstSegment` (a `<id>-<stamp>.log` path). */
export function segmentPath(firstSegment: string, n: number): string {
  return n <= 1 ? firstSegment : `${firstSegment}.${n}`;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** `{stamp, n}` for a file name of a run of `jobId` (segment 1 or a later one); null for anything else, legacy daily files included. */
export function parseSegmentName(jobId: string, fileName: string): { stamp: string; n: number } | null {
  const m = new RegExp(`^${escapeRegExp(jobId)}-(\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2})\\.log(?:\\.([2-9]|[1-9]\\d+))?$`).exec(fileName);
  return m ? { stamp: m[1]!, n: m[2] === undefined ? 1 : Number(m[2]) } : null;
}

export interface RunSegment {
  n: number;
  file: string;
  size: number;
}

/** The retained segments of every run in `logDir`, by run stamp (oldest first) and in segment order. A missing folder has none. */
export function listRunSegments(logDir: string, jobId: string): Map<string, RunSegment[]> {
  let names: string[];
  try {
    names = fs.readdirSync(logDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return new Map();
    }
    throw err;
  }
  const byStamp = new Map<string, RunSegment[]>();
  for (const name of names) {
    const parsed = parseSegmentName(jobId, name);
    if (parsed === null) {
      continue;
    }
    const file = path.join(logDir, name);
    let size = 0;
    try { size = fs.statSync(file).size; } catch { /* pruned between the listing and the stat */ continue; }
    const list = byStamp.get(parsed.stamp) ?? [];
    list.push({ n: parsed.n, file, size });
    byStamp.set(parsed.stamp, list);
  }
  const sorted = new Map<string, RunSegment[]>();
  for (const stamp of [...byStamp.keys()].sort()) {
    sorted.set(stamp, byStamp.get(stamp)!.sort((a, b) => a.n - b.n));
  }
  return sorted;
}

/** The marker line (without its time stamp) that opens a segment after older ones were dropped. The supervisor writes the same words. */
export function dropMarkerText(dropped: number, keepSegments: number, maxBytes: number): string {
  return `[orch] log rotation: ${dropped} earlier segment${dropped === 1 ? '' : 's'} of this run ${dropped === 1 ? 'was' : 'were'} dropped `
    + `(only the last ${keepSegments} segment${keepSegments === 1 ? ' is' : 's are'} kept, each at most ${formatLimit(maxBytes)}; `
    + 'see logRotation in docs/daemon-config.md)';
}

/**
 * The segments that exist of the run whose first segment is `first` (a `<id>-<stamp>.log` path), in order. Unlike
 * listRunSegments it needs no job id: readers that already hold a run's path use it. Empty when the run has no file.
 */
export function listSegmentFiles(first: string): RunSegment[] {
  const dir = path.dirname(first);
  const baseName = path.basename(first);
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw err;
  }
  const pattern = new RegExp(`^${escapeRegExp(baseName)}(?:\.([2-9]|[1-9]\d+))?$`);
  const found: RunSegment[] = [];
  for (const name of names) {
    const m = pattern.exec(name);
    if (m === null) {
      continue;
    }
    const file = path.join(dir, name);
    try {
      found.push({ n: m[1] === undefined ? 1 : Number(m[1]), file, size: fs.statSync(file).size });
    } catch { /* pruned between the listing and the stat */ }
  }
  return found.sort((a, b) => a.n - b.n);
}
