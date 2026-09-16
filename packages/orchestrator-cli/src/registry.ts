import fs   from 'node:fs';
import type { Job, RegistryData } from './types.js';
import { JOB_TYPES, TRIGGER_MODES, MISSED_FIRINGS, LIVENESS_STRATEGIES } from './types.js';
import { atomicWriteJson, readJsonFile } from './fsUtil.js';

const CRON_RE = /^(\*|[0-9,\-*/]+)\s+(\*|[0-9,\-*/]+)\s+(\*|[0-9,\-*/]+)\s+(\*|[0-9,\-*/]+)\s+(\*|[0-9,\-*/]+)$/;

// Use Sets from enums for validation (single source of truth)
const VALID_TYPES         = new Set(JOB_TYPES);
const VALID_TRIGGER_MODES = new Set(TRIGGER_MODES);
const VALID_MISSED_FIRING = new Set(MISSED_FIRINGS);
const VALID_LIVENESS      = new Set(LIVENESS_STRATEGIES);

function validateJob(job: Partial<Job>): void {
  if (!job.id || typeof job.id !== 'string')           throw new Error('Job id must be a non-empty string');
  if (job.id.length > 128)                             throw new Error('Job id must be 128 chars or fewer');
  if (job.id.includes('\x00'))                         throw new Error('Job id must not contain null bytes');
  if (!job.type || !VALID_TYPES.has(job.type))         throw new Error(`Job type must be "cron", "startup", or "once" (got: ${job.type})`);
  if (!job.command || typeof job.command !== 'string') throw new Error('Job command must be a non-empty string');
  if (job.command.length > 4096)                       throw new Error('Job command must be 4096 chars or fewer');
  if (job.command.includes('\x00'))                    throw new Error('Job command must not contain null bytes');

  if (job.type === 'cron') {
    if (!job.schedule) throw new Error('Cron job requires a schedule field');
    if (!CRON_RE.test(job.schedule.trim())) throw new Error(`Invalid cron schedule: "${job.schedule}"`);
  }

  if (job.type === 'startup') {
    const delay = job.delaySeconds ?? 0;
    if (!Number.isInteger(delay) || delay < 0) throw new Error(`delaySeconds must be a non-negative integer (got: ${delay})`);
  }

  if (job.type === 'once') {
    if (job.delayMs === undefined) throw new Error('Once job requires a delayMs field');
    if (!Number.isInteger(job.delayMs) || job.delayMs <= 0) throw new Error(`delayMs must be a positive integer (got: ${job.delayMs})`);
  }

  if (job.triggerMode !== undefined && !VALID_TRIGGER_MODES.has(job.triggerMode)) {
    throw new Error(`triggerMode must be "fire-and-forget" or "wait" (got: ${job.triggerMode})`);
  }

  if (job.missedFiring !== undefined && !VALID_MISSED_FIRING.has(job.missedFiring)) {
    throw new Error(`missedFiring must be "catch-up" or "skip" (got: ${job.missedFiring})`);
  }

  if (job.retryOnExitCodes !== undefined) {
    if (!Array.isArray(job.retryOnExitCodes) || job.retryOnExitCodes.some(c => typeof c !== 'number')) {
      throw new Error('retryOnExitCodes must be an array of numbers');
    }
  }
  if (job.retryDelays !== undefined) {
    if (!Array.isArray(job.retryDelays) || job.retryDelays.some(d => typeof d !== 'number' || d <= 0)) {
      throw new Error('retryDelays must be an array of positive numbers');
    }
  }

  if (job.liveness != null) {
    const s = job.liveness.strategy;
    if (!VALID_LIVENESS.has(s)) throw new Error(`Unknown liveness strategy: "${s}". Valid: ${[...VALID_LIVENESS].join(', ')}`);
    if (s === 'portFile' && !job.liveness.portFile) throw new Error('liveness.portFile is required for portFile strategy');
    if (s === 'command'  && !job.liveness.command)  throw new Error('liveness.command is required for command strategy');
  }
}

function applyDefaults(job: Partial<Job>): Job {
  return {
    id:          job.id!,
    type:        job.type!,
    command:     job.command!,
    label:       job.label       ?? job.id ?? '',
    enabled:     job.enabled     ?? true,
    triggerMode: job.triggerMode ?? 'fire-and-forget',
    liveness:    job.liveness    ?? null,
    cwd:         job.cwd         ?? null,
    ...(job.onExitCode       ? { onExitCode: job.onExitCode }             : {}),
    ...(job.retryOnExitCodes ? { retryOnExitCodes: job.retryOnExitCodes } : {}),
    ...(job.retryDelays      ? { retryDelays: job.retryDelays }           : {}),
    ...(job.type === 'cron'    ? { schedule: job.schedule, missedFiring: job.missedFiring ?? 'skip' } : {}),
    ...(job.type === 'startup' ? { delaySeconds: job.delaySeconds ?? 0 }                                  : {}),
    ...(job.type === 'once'    ? { delayMs: job.delayMs!, scheduledAt: job.scheduledAt! }                 : {}),
  } as Job;
}

const SUPPORTED_VERSION = 1;

/**
 * Written into registry.json on every save, for whoever opens the file meaning to edit it.
 *
 * Hand-editing does not half-work, it loses data. The daemon reads this file once, on first access,
 * and serves every later request from memory: an external edit is invisible until a restart, and the
 * next write driven by the CLI or the dashboard rewrites the whole file from that stale memory,
 * silently discarding the edit. So the failure is not "my change did not apply", it is "my change
 * disappeared", which is much harder to notice.
 *
 * It lives here rather than being pasted into the file because _write() emits the whole object: a
 * manually added key would be dropped by the very next `orch add`.
 */
export const REGISTRY_NOTICE =
  'Do not edit this file by hand. The daemon caches it at startup, so edits are ignored until a '
  + 'restart AND are overwritten by the next change made through the CLI or the dashboard. '
  + 'Use `orch add` / `orch edit` / `orch remove` / `orch enable` / `orch disable`, or the web UI. '
  + 'Run `orch --help` for the full list.';

export class Registry {
  private readonly _file: string;
  private _jobs: Job[] | null = null;

  constructor(filePath: string) {
    this._file = filePath;
  }

  private _read(): RegistryData {
    if (!fs.existsSync(this._file)) return { version: SUPPORTED_VERSION, jobs: [] };
    const raw = readJsonFile<RegistryData>(this._file);
    if (!raw) throw new Error('registry.json is malformed');
    if (typeof raw.version === 'number' && raw.version > SUPPORTED_VERSION) {
      throw new Error(
        `registry.json version ${raw.version} is not supported by this daemon (max: ${SUPPORTED_VERSION}). ` +
        `Upgrade the orchestrator.`
      );
    }
    return raw;
  }

  /**
   * The single choke point for writing the file, so the notice cannot be forgotten by a caller.
   * First key on purpose: it is the first thing visible when the file is opened.
   */
  private _write(data: RegistryData): void {
    atomicWriteJson(this._file, { _README: REGISTRY_NOTICE, ...data });
  }

  private _ensure(): void {
    if (this._jobs === null) this.load();
  }

  load(): RegistryData {
    const data = this._read();
    this._jobs = data.jobs ?? [];
    // Also rewrites when the notice is absent or stale, so it reaches registries that already exist
    // instead of waiting for someone to add a job. Self-limiting: once written, the comparison
    // matches and nothing happens on later loads.
    if (!fs.existsSync(this._file) || data._README !== REGISTRY_NOTICE) {
      this._write({ version: SUPPORTED_VERSION, jobs: this._jobs });
    }
    return { version: SUPPORTED_VERSION, jobs: [...this._jobs] };
  }

  list(): Job[] {
    this._ensure();
    return [...this._jobs!];
  }

  get(id: string): Job | null {
    this._ensure();
    return this._jobs!.find((j) => j.id === id) ?? null;
  }

  add(job: Partial<Job>): void {
    this._ensure();
    if (this._jobs!.some((j) => j.id === job.id)) {
      throw new Error(`Duplicate job id: "${job.id}"`);
    }
    validateJob(job);
    this._jobs!.push(applyDefaults({ ...job }));
    this._write({ version: SUPPORTED_VERSION, jobs: this._jobs! });
  }

  remove(id: string): void {
    this._ensure();
    const idx = this._jobs!.findIndex((j) => j.id === id);
    if (idx === -1) throw new Error(`Job not found: "${id}"`);
    this._jobs!.splice(idx, 1);
    this._write({ version: SUPPORTED_VERSION, jobs: this._jobs! });
  }

  enable(id: string): void  { this._patch(id, { enabled: true }); }
  disable(id: string): void { this._patch(id, { enabled: false }); }

  edit(id: string, updates: Partial<Job>): void {
    this._ensure();
    const idx = this._jobs!.findIndex((j) => j.id === id);
    if (idx === -1) throw new Error(`Job not found: "${id}"`);
    const merged = { ...this._jobs![idx], ...updates };
    validateJob(merged);
    this._jobs![idx] = merged as Job;
    this._write({ version: SUPPORTED_VERSION, jobs: this._jobs! });
  }

  private _patch(id: string, updates: Partial<Job>): void {
    this._ensure();
    const idx = this._jobs!.findIndex((j) => j.id === id);
    if (idx === -1) throw new Error(`Job not found: "${id}"`);
    this._jobs![idx] = { ...this._jobs![idx], ...updates };
    this._write({ version: SUPPORTED_VERSION, jobs: this._jobs! });
  }
}
