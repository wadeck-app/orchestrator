import fs   from 'node:fs';
import type { Job, RegistryData } from './types.js';
import { JOB_TYPES, TRIGGER_MODES, MISSED_FIRINGS, LIVENESS_STRATEGIES,
         UNSETTABLE_FIELDS, unsettableFieldError } from './types.js';
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
  if (job.skipExitCodes !== undefined) {
    if (!Array.isArray(job.skipExitCodes) || job.skipExitCodes.some(c => typeof c !== 'number')) {
      throw new Error('skipExitCodes must be an array of numbers, e.g. [2]');
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

/** null, undefined, "" and empty collections all mean "not configured". 0 and false do not. */
function isEmptyValue(value: unknown): boolean {
  if (value === null || value === undefined || value === '') return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return Object.keys(value).length === 0;
  return false;
}

/**
 * Drops every field that holds nothing, so "never configured", "cleared with `--unset`" and "set to
 * an empty value" are a single shape on disk -- see UNSETTABLE_FIELDS for what each field clears to.
 *
 * Two things this fixes rather than merely tidies: every job used to carry `"cwd": null` and
 * `"liveness": null` whether or not it had either, and `orch edit j --cwd ""` stored an empty string
 * that the scheduler handed to spawn() as a working directory.
 *
 * Idempotent, and applied on every write, so a job written by an older daemon is reshaped as soon as
 * anything at all is saved -- no migration step, and no file where two shapes coexist.
 */
function normalizeJob(job: Job): Job {
  const out = { ...job } as Job & Record<string, unknown>;
  for (const [field, rule] of Object.entries(UNSETTABLE_FIELDS)) {
    if (!isEmptyValue(out[field])) continue;
    if (rule === 'delete') delete out[field];
    else out[field] = rule(out);
  }
  return out;
}

/**
 * Fills in what a new job needs, and keeps everything else the caller sent.
 *
 * `...job` first is load-bearing: this used to build a fresh object from a fixed list of keys, so
 * any field not on that list -- timeoutSeconds, env, tags, secrets, dependsOn -- was silently
 * dropped at creation. `orch add --timeout` and the dashboard's own fields went nowhere, and
 * `orch edit --unset timeoutSeconds` offered to clear a field `orch add` could not even store.
 */
function applyDefaults(job: Partial<Job>): Job {
  return normalizeJob({
    ...job,
    id:          job.id!,
    type:        job.type!,
    command:     job.command!,
    label:       job.label       ?? job.id ?? '',
    enabled:     job.enabled     ?? true,
    triggerMode: job.triggerMode ?? 'fire-and-forget',
    ...(job.type === 'cron'    ? { missedFiring: job.missedFiring ?? 'skip' } : {}),
    ...(job.type === 'startup' ? { delaySeconds: job.delaySeconds ?? 0 }      : {}),
  } as Job);
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
   *
   * Also where empty fields are dropped -- here rather than in each mutator, so no path can write a
   * `"cwd": null` back, including jobs loaded from a file an older daemon wrote. The in-memory copy
   * is replaced by the normalized one: the daemon serves every read from memory, so leaving it
   * un-normalized would make `orch show` disagree with the file until the next restart.
   */
  private _write(data: RegistryData): void {
    const jobs = data.jobs.map(normalizeJob);
    if (this._jobs !== null) this._jobs = jobs;
    atomicWriteJson(this._file, { _README: REGISTRY_NOTICE, ...data, jobs });
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

  /**
   * Patches a job: fields in `updates` are overwritten, fields named in `unset` are cleared, and
   * everything else is left alone. Clearing is separate from updating because a patch has no way to
   * say "remove this" through a value -- see UNSETTABLE_FIELDS for what each field clears to.
   */
  edit(id: string, updates: Partial<Job>, unset: readonly string[] = []): void {
    this._ensure();
    const idx = this._jobs!.findIndex((j) => j.id === id);
    if (idx === -1) throw new Error(`Job not found: "${id}"`);
    // Indexable, because unsetting reaches fields by name -- still a Job for validation.
    const merged = { ...this._jobs![idx], ...updates } as Job & Record<string, unknown>;

    for (const field of unset) {
      const problem = unsettableFieldError(field);
      if (problem) throw new Error(problem);
      if (Object.prototype.hasOwnProperty.call(updates, field)) {
        // Applying both in some order would quietly discard half of what the caller asked for.
        throw new Error(`Cannot set and unset "${field}" in the same edit -- pick one.`);
      }
      const rule = UNSETTABLE_FIELDS[field]!;
      if (rule === 'delete') delete merged[field];
      else merged[field] = rule(merged);
    }

    // Normalized before validation, not just on write: `--trigger-mode ""` should mean "back to the
    // default", not fail validation on an empty string the caller never meant as a value.
    const normalized = normalizeJob(merged);
    validateJob(normalized);
    this._jobs![idx] = normalized;
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
