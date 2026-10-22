import fs from 'node:fs';
import path from 'node:path';
import { getErrorMessage } from './fsUtil.js';
import type { TreeProcess } from './scheduler.js';

/** Same rule as the logs route: an id is a file name here, so it cannot carry a path. */
const JOB_ID_RE = /^[a-z0-9-]+$/i;

/** Rotate past this. A two-second sampler on a long job writes a few hundred KB an hour. */
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;

/** Enough to name the culprit of a spike without turning every line into a process listing. */
const MAX_PROCESSES_PER_SAMPLE = 5;

export function telemetryDir(configDir: string): string {
  return path.join(configDir, 'telemetry');
}

export function telemetryPath(configDir: string, jobId: string): string {
  if (!JOB_ID_RE.test(jobId)) {
    throw new Error(`telemetry: "${jobId}" is not a valid job id (letters, digits and "-" only), refusing to build a file name from it.`);
  }
  return path.join(telemetryDir(configDir), `${jobId}.ndjson`);
}

export function rotatedPath(configDir: string, jobId: string): string {
  return path.join(telemetryDir(configDir), `${jobId}.1.ndjson`);
}

/** One reading of a running job, as the monitor measured it. */
export interface TelemetrySample {
  cpuPct: number;
  ramMb: number;
  /** Processes the tree walk offered, against `counted`: how many were refused as not the job's. */
  walked?: number;
  counted?: number;
  processes?: TreeProcess[];
}

/**
 * One line of the file. `kind` is `sample`, or the moment an event marks (`start`, `resource-kill`,
 * `end`); each kind adds its own fields, which is why the rest is open.
 */
export interface TelemetryLine {
  t: string;
  kind: string;
  run: string;
  pid?: number | null;
  [field: string]: unknown;
}

export interface TelemetryOptions {
  maxBytes?: number;
  /** Told once, the first time writing fails; the job is never told. */
  onWarn?: (message: string) => void;
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

/**
 * What the resource monitor sees of one run, appended as newline-delimited JSON to
 * `<configDir>/telemetry/<jobId>.ndjson`, next to the job's logs but apart from them.
 *
 * Apart, because the log viewer lists a job's runs by file name and a data file among them would show
 * up as a run. One file per job rather than per run: a UI draws a job's history, and the lines carry
 * the run they belong to.
 *
 * Telemetry is a record, never a duty: every failure to write is swallowed after being reported once,
 * because a job must not slow down, fail or be killed over its own bookkeeping.
 */
export class JobTelemetry {
  private readonly _file: string;
  private readonly _older: string;
  private readonly _maxBytes: number;
  private readonly _onWarn: (message: string) => void;
  private _warned = false;
  private _size: number | null = null;

  constructor(
    private readonly _configDir: string,
    private readonly _jobId: string,
    private readonly _run: string,
    private readonly _pid: number | null | undefined,
    options: TelemetryOptions = {},
  ) {
    this._file = telemetryPath(_configDir, _jobId);
    this._older = rotatedPath(_configDir, _jobId);
    this._maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this._onWarn = options.onWarn ?? (() => {});
  }

  /** A moment worth marking: the run's thresholds at its start, the kill at its end. */
  event(kind: string, details: Record<string, unknown> = {}): void {
    this._append({ t: new Date().toISOString(), kind, run: this._run, pid: this._pid, ...details });
  }

  sample(sample: TelemetrySample): void {
    const processes = sample.processes?.slice(0, MAX_PROCESSES_PER_SAMPLE).map(p => ({
      pid: p.pid, ppid: p.ppid, ramMb: Math.round(p.ramMb), cpuPct: round1(p.cpuPct),
    }));
    this._append({
      t: new Date().toISOString(),
      kind: 'sample',
      run: this._run,
      pid: this._pid,
      cpuPct: round1(sample.cpuPct),
      ramMb: round1(sample.ramMb),
      ...(sample.walked !== undefined ? { walked: sample.walked } : {}),
      ...(sample.counted !== undefined ? { counted: sample.counted } : {}),
      ...(processes !== undefined && processes.length > 0 ? { processes } : {}),
    });
  }

  private _append(line: Record<string, unknown>): void {
    try {
      const text = JSON.stringify(line) + '\n';
      fs.mkdirSync(telemetryDir(this._configDir), { recursive: true });
      if (this._size === null) {
        this._size = fs.existsSync(this._file) ? fs.statSync(this._file).size : 0;
      }
      if (this._size > 0 && this._size + text.length > this._maxBytes) {
        // One older file only: the live one is for now, the older one for the run before, and
        // anything beyond that is a bounded cost nobody asked to keep.
        fs.renameSync(this._file, this._older);
        this._size = 0;
      }
      fs.appendFileSync(this._file, text);
      this._size += text.length;
    } catch (err) {
      if (!this._warned) {
        this._warned = true;
        this._onWarn(`telemetry for job "${this._jobId}" could not be written (${getErrorMessage(err)}); the job runs on and the monitor keeps working, only this record is lost`);
      }
    }
  }
}

