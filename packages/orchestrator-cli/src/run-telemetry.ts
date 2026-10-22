import fs from 'node:fs';
import readline from 'node:readline';
import { getErrorMessage } from './fsUtil.js';
import { rotatedPath, telemetryPath, type TelemetryLine } from './job-telemetry.js';

/** The most points one answer carries, whatever the length of the run: a UI cannot draw more than that legibly. */
export const MAX_TELEMETRY_POINTS = 600;

/** A side is null when nothing defines it: an absolute ceiling for the other resource only, and no baseline yet. */
export interface TelemetryThreshold {
  cpuPct: number | null;
  ramMb: number | null;
}

export interface RunTelemetryPoint {
  t: string;
  cpuPct: number;
  ramMb: number;
}

/** What `get-run-telemetry` answers: one run, ready to draw. */
export interface RunTelemetry {
  /** The run's startedAt; null only when the job has no telemetry at all and none was asked for. */
  run: string | null;
  available: boolean;
  /** Why there is nothing to draw. Present exactly when `available` is false. */
  reason?: string;
  samples: RunTelemetryPoint[];
  /** The thresholds the run was held to (the last `start`/`adopt` line), or null before there was a baseline. */
  soft: TelemetryThreshold | null;
  hard: TelemetryThreshold | null;
  kill?: { t: string; cpuPct: number; ramMb: number; consecutiveSamples: number };
  end?: { t: string; exitCode: number | null; durationMs: number | null; reason: string | null };
  /** True when the beginning of the run was rotated away: the chart starts late. */
  truncated: boolean;
  /**
   * Width of one bucket when the run had more than MAX_TELEMETRY_POINTS samples (each point is then the MAX
   * of its bucket); null when every point is a raw sample.
   */
  bucketSeconds: number | null;
  /** Samples the file holds for the run, before any bucketing. */
  rawSamples: number;
}

interface RawPoint {
  ms: number;
  t: string;
  cpuPct: number;
  ramMb: number;
}

const RUN_FIELD = '"run":';
const QUOTE = 34;

/** The run a line belongs to, read off its text without parsing it; null when the field is not there. */
function runOfRawLine(raw: string): string | null {
  const at = raw.indexOf(RUN_FIELD);
  if (at < 0 || raw.charCodeAt(at + RUN_FIELD.length) !== QUOTE) {
    return null;
  }
  const from = at + RUN_FIELD.length + 1;
  const to = raw.indexOf('"', from);
  return to < 0 ? null : raw.slice(from, to);
}

async function fileExists(file: string): Promise<boolean> {
  try {
    return (await fs.promises.stat(file)).isFile();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw new Error(`telemetry: cannot read ${file} (${getErrorMessage(err)}). Check that the file is readable by the user running the daemon.`);
  }
}

/**
 * Streams a file line by line, so the answer for one run never needs the whole file in memory. A torn last
 * line (the daemon is appending) is handed over like any other and rejected by the caller's JSON.parse.
 */
async function eachLine(file: string, onLine: (raw: string) => void): Promise<void> {
  if (!(await fileExists(file))) {
    return;
  }
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const raw of rl) {
    if (raw.length > 0) {
      onLine(raw);
    }
  }
}

function unavailable(run: string | null, reason: string, extra: Partial<RunTelemetry> = {}): RunTelemetry {
  return { run, available: false, reason, samples: [], soft: null, hard: null, truncated: false, bucketSeconds: null, rawSamples: 0, ...extra };
}

function asThreshold(v: unknown): TelemetryThreshold | null {
  if (typeof v !== 'object' || v === null) {
    return null;
  }
  const { cpuPct, ramMb } = v as { cpuPct?: unknown; ramMb?: unknown };
  const cpu = typeof cpuPct === 'number' ? cpuPct : null;
  const ram = typeof ramMb === 'number' ? ramMb : null;
  return cpu === null && ram === null ? null : { cpuPct: cpu, ramMb: ram };
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/**
 * Takes the maximum of cpu and of ram per time bucket, so a spike that lasted one sample is still the
 * height of its point instead of being averaged into its neighbours. Buckets are sized so that there
 * are at most MAX_TELEMETRY_POINTS of them; empty ones (a paused monitor) produce no point.
 */
function downsample(points: RawPoint[]): { samples: RunTelemetryPoint[]; bucketSeconds: number | null } {
  if (points.length <= MAX_TELEMETRY_POINTS) {
    return { samples: points.map(({ t, cpuPct, ramMb }) => ({ t, cpuPct, ramMb })), bucketSeconds: null };
  }
  const first = points[0]!.ms;
  const span = points[points.length - 1]!.ms - first;
  // `span + 1`: with the exact span the last sample could land in bucket number MAX (the 601st).
  const bucketSeconds = Math.max(1, Math.ceil((span + 1) / MAX_TELEMETRY_POINTS / 1000));
  const bucketMs = bucketSeconds * 1000;
  const buckets = new Map<number, RunTelemetryPoint>();
  for (const p of points) {
    const index = Math.floor((p.ms - first) / bucketMs);
    const held = buckets.get(index);
    if (held === undefined) {
      buckets.set(index, { t: p.t, cpuPct: p.cpuPct, ramMb: p.ramMb });
    } else {
      held.t = p.t;
      held.cpuPct = Math.max(held.cpuPct, p.cpuPct);
      held.ramMb = Math.max(held.ramMb, p.ramMb);
    }
  }
  return { samples: [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([, p]) => p), bucketSeconds };
}

/**
 * One run of a job, drawn from `<jobId>.1.ndjson` then `<jobId>.ndjson`. `run` is the run's startedAt;
 * without it, the newest run found.
 *
 * Cost: both files are read once, front to back, as a stream (at most about 4 MiB, 2 MiB each). Only the
 * lines of the wanted run are parsed, the others are skipped after a substring check; memory is the run's
 * own samples, bounded by the file size. The file is not indexed, so a run at the start of a 2 MiB file
 * costs as much to find as one at the end.
 *
 * Rotation can move the live file under a read in flight; a read that straddles it may miss the lines
 * that moved. The next call reads the settled files, which is why the UI polls a running job anyway.
 */
export async function readRunTelemetry(configDir: string, jobId: string, run?: string): Promise<RunTelemetry> {
  const live = telemetryPath(configDir, jobId);
  const older = rotatedPath(configDir, jobId);
  if (!(await fileExists(live)) && !(await fileExists(older))) {
    return unavailable(run ?? null, `No telemetry has been recorded for job "${jobId}" yet: the monitor writes it while a run is going, so a job that has not run since telemetry existed has none.`);
  }

  // Without a run asked for, the newest one wins: ISO timestamps sort as text, and a run newer than
  // the one being collected replaces it (runs of one job can overlap, so a line of an older run may
  // still arrive after a newer run has begun).
  let wanted: string | null = run ?? null;
  let sawAnyRun = false;
  let sawLine = false;
  let sawStart = false;
  const points: RawPoint[] = [];
  let soft: TelemetryThreshold | null = null;
  let hard: TelemetryThreshold | null = null;
  let kill: RunTelemetry['kill'];
  let end: RunTelemetry['end'];

  const onLine = (raw: string): void => {
    const lineRun = runOfRawLine(raw);
    if (lineRun === null) {
      return;
    }
    sawAnyRun = true;
    if (run === undefined && (wanted === null || lineRun > wanted)) {
      wanted = lineRun;
      points.length = 0;
      soft = null;
      hard = null;
      kill = undefined;
      end = undefined;
      sawStart = false;
      sawLine = false;
    }
    if (lineRun !== wanted) {
      return;
    }
    let line: TelemetryLine;
    try {
      line = JSON.parse(raw) as TelemetryLine;
    } catch {
      // The line being appended while we read, or one cut by a crash. The rest is still good.
      return;
    }
    sawLine = true;
    switch (line.kind) {
      case 'start':
      case 'adopt':
        sawStart = true;
        soft = asThreshold(line.soft);
        hard = asThreshold(line.hard);
        break;
      case 'sample': {
        const ms = Date.parse(line.t);
        if (Number.isFinite(ms)) {
          points.push({ ms, t: line.t, cpuPct: num(line.cpuPct), ramMb: num(line.ramMb) });
        }
        break;
      }
      case 'resource-kill':
        kill = { t: line.t, cpuPct: num(line.cpuPct), ramMb: num(line.ramMb), consecutiveSamples: num(line.consecutiveSamples) };
        break;
      case 'end':
        end = {
          t: line.t,
          exitCode: typeof line.exitCode === 'number' ? line.exitCode : null,
          durationMs: typeof line.durationMs === 'number' ? line.durationMs : null,
          reason: typeof line.reason === 'string' ? line.reason : null,
        };
        break;
      // Any other kind is not part of the picture.
    }
  };

  await eachLine(older, onLine);
  await eachLine(live, onLine);

  if (wanted === null || !sawLine) {
    const reason = run === undefined
      ? `The telemetry file of job "${jobId}" holds no readable run.`
      : `Telemetry for the run started at ${run} is no longer in the file: only the most recent samples of each job are kept (about 4 MiB, two files) and that run has been rotated away${sawAnyRun ? '' : ', or the files hold nothing readable'}. It may also never have been sampled.`;
    return unavailable(wanted, reason);
  }
  points.sort((a, b) => a.ms - b.ms);
  const { samples, bucketSeconds } = downsample(points);
  const moments = { ...(kill !== undefined ? { kill } : {}), ...(end !== undefined ? { end } : {}) };
  if (samples.length === 0) {
    return unavailable(wanted, 'No sample was taken for this run (samples come every 2 seconds, so a run that has just begun or was very short has none), so there is nothing to draw.', {
      soft, hard, truncated: !sawStart, ...moments,
    });
  }
  return {
    run: wanted,
    available: true,
    samples,
    soft,
    hard,
    truncated: !sawStart,
    bucketSeconds,
    rawSamples: points.length,
    ...moments,
  };
}
