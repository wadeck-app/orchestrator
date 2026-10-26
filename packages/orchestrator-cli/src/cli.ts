import fs   from 'node:fs';
import os   from 'node:os';
import path from 'node:path';
import type { CliDeps, DaemonInfo, LivenessConfig, RuntimeEntry } from './types.js';
import type { ProgressEstimate } from './progress/types.js';
import { UNSETTABLE_FIELDS, unsettableFieldError, type ResourceLimits, type JobProgressSetting } from './types.js';
import { PROGRESS_MODES, PROGRESS_STRATEGY_IDS, progressSettingError } from './progress/setting.js';
import { RESOURCE_LIMIT_KEYS, resourceLimitsError } from './resource-limits.js';
import { restartConflictError, restartOnExitError, type RestartOnExit } from './restart-policy.js';
import { logRotationError, parseSegmentName, type LogRotation } from './log-rotation.js';
import { WindowsTask } from './windows/WindowsTask.js';
import { getErrorMessage } from './fsUtil.js';
import { readCrashMarker, type CrashMarker } from './crash-guard.js';
import { classifyDashboard } from './dashboard-pidfile.js';
import { parseActiveFor } from './active-window.js';
import { onceScheduleDisplay, describeMoment, describeAgo } from './once-schedule.js';
import { parseJobLogsArgs, runJobLogs } from './job-logs.js';
import { PROGRESS_REPLAY_USAGE, parseReplayArgs, runProgressReplay } from './progress/replay-report.js';
import { HELP_TEXT, JOB_HELP, JOB_LOGS_HELP } from './help-text.js';
import { stripAnsi } from './ansi.js';
import { systemTime } from './time-service.js';
import { isReleaseVersion, devBuildRefusalMessage } from '@wadeck-app/shared-cli/ReleaseVersion';
import { updateNotice } from './update-notice.js';
import { unsupervisedWarning } from './unsupervised-warning.js';

/** Error codes that mean "the connection to the daemon failed", whatever Node's message happens to say. */
const CONNECTION_FAILURE_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE']);

/**
 * Whether an error from talking to the daemon means the daemon is not there (as opposed to a daemon that is there
 * and failed). Checked on `err.code` as well as the message: a connection reset mid-response is a
 * `socket hang up` whose message never contains the code.
 */
export function isDaemonDownError(e: unknown): boolean {
  const msg = getErrorMessage(e);
  const code = (e as NodeJS.ErrnoException | undefined)?.code;
  return msg.includes('not running') || msg.includes('ECONNREFUSED') || msg.includes('ENOENT')
    || (!!code && CONNECTION_FAILURE_CODES.has(code));
}

/** Ids of the jobs with a run still going, and which of them a supervisor owns (they outlive the daemon). */
function runningJobs(state: Record<string, RuntimeEntry[]>): { all: string[]; supervised: string[] } {
  const all: string[] = [];
  const supervised: string[] = [];
  for (const [id, entries] of Object.entries(state)) {
    const open = entries.filter(e => e.finishedAt == null && e.exitCode == null);
    if (open.length > 0) {
      all.push(id);
      if (open.some(e => e.supervised === true)) {
        supervised.push(id);
      }
    }
  }
  return { all, supervised };
}

/**
 * The lines `orch status` adds under pid/port/uptime. The supervisor line is explicit in its three states: an
 * unavailable supervisor (asked for, not found) is the one that silently changes behaviour, since jobs then die
 * with the daemon, so it carries the daemon's own sentence, which names the fix.
 */
function describeDaemonInfo(info: DaemonInfo): string[] {
  const { supervisor, runs, scheduler } = info;
  const lines = [
    `version   : ${info.version}  (started ${info.startedAt})`,
    `runs      : ${runs.running} running (${runs.supervised} supervised)`,
  ];
  if (!supervisor.requested) {
    lines.push('supervisor: off (supervisedJobs is false in config.yml; jobs stop with the daemon)');
  } else if (supervisor.active) {
    lines.push('supervisor: on (jobs outlive a daemon restart)');
  } else {
    lines.push(`supervisor: requested but UNAVAILABLE - jobs run unsupervised and stop with the daemon. ${supervisor.note ?? 'No reason was reported; check: orch logs'}`);
  }
  lines.push(`timers    : ${scheduler.armed} armed of ${scheduler.desired} desired`);
  if (scheduler.problems.length > 0) {
    lines.push(`${scheduler.problems.length} timer problem(s), see: orch timers`);
    for (const p of scheduler.problems) {
      lines.push(`  ${p.jobId}: ${p.problem}`);
    }
  }
  return lines;
}

/**
 * The lines `orch status` prints for running jobs: "42% ~14:32" (the ~ marks a time that is an estimate), the
 * overdue sentence, or the reason there is no estimate. Local time, like the rest of the CLI output.
 */
export function describeProgress(progress: Record<string, ProgressEstimate>): string[] {
  return Object.entries(progress).map(([id, e]) => {
    if (e.progress === null) {
      return `  ${id}: no estimate - ${e.reason}`;
    }
    const pct = `${Math.round(e.progress * 100)}%`;
    if (e.etaAt === null) {
      return `  ${id}: ${pct} ${e.reason}`;
    }
    const eta = new Date(e.etaAt);
    const hhmm = `${String(eta.getHours()).padStart(2, '0')}:${String(eta.getMinutes()).padStart(2, '0')}`;
    return `  ${id}: ${pct} ~${hhmm}${e.confidence === 'low' ? ' (low confidence)' : ''}`;
  });
}

/** Contents of the dashboard pid file, or null when it does not exist. */
function readDashboardFile(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { logCliInvocation } = require('@wadeck-app/shared-cli/CliLogger') as typeof import('@wadeck-app/shared-cli/CliLogger');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { parseDuration } = require('@wadeck-app/shared-cli/Duration') as typeof import('@wadeck-app/shared-cli/Duration');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { cliVersionCommand, cliUpdateCommand, cliLogsCommand, warnUnknownArgs } = require('@wadeck-app/shared-cli/CliMetaCommands') as typeof import('@wadeck-app/shared-cli/CliMetaCommands');

const DEFAULT_CONFIG_DIR =
  // violations-suppress: shared/no-out-of-repo-path ~/.config/orchestrator IS this product's config dir, and ORCH_CONFIG_DIR is already the env override the rule asks for
  process.env['ORCH_CONFIG_DIR'] ?? path.join(os.homedir(), '.config', 'orchestrator');

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { version } = require('../package.json') as { version: string };

// ---------------------------------------------------------------------------
// Arg parsing helpers
// ---------------------------------------------------------------------------

function flag(argv: string[], name: string): string | undefined {
  const idx = argv.indexOf(name);
  return idx !== -1 ? argv[idx + 1] : undefined;
}

function has(argv: string[], name: string): boolean {
  return argv.includes(name);
}

/**
 * Every job field settable by a plain flag, in one place.
 *
 * `add` and `edit` both read this, because the two lists used to be maintained by hand and drifted:
 * nine fields of Job -- timeoutSeconds, env, tags, onExitCode, alertAfterFailures, dependsOn,
 * slaWindowMinutes, secrets, dryRunSupported -- had no flag at all, so `orch edit j --timeout 600`
 * reported success and changed nothing. It also feeds the unknown-flag check, so adding a field here
 * is the single edit needed to make it settable, documented as accepted, and spelled correctly.
 *
 * The composite flags stay out: `--liveness-*` build one nested object, and `--active-*` cross-check
 * each other. `--delay` too, since it means delaySeconds on a startup job and delayMs on a once job.
 */
export interface FieldFlag {
  flag:  string;
  field: string;
  /**
   * 'resource' flags build the nested resourceLimits object (resourceLimitFlags), 'restart' flags the object form of
   * restartOnExit and 'restart-switch' (--restart-on-exit) turns it on (restartFlags).
   */
  kind:  'string' | 'int' | 'stringList' | 'numberList' | 'map' | 'presence' | 'resource' | 'restart' | 'restart-switch' | 'log-rotation';
}

export const JOB_FIELD_FLAGS: FieldFlag[] = [
  { flag: '--command',              field: 'command',            kind: 'string'      },
  { flag: '--label',                field: 'label',              kind: 'string'      },
  { flag: '--description',          field: 'description',        kind: 'string'      },
  { flag: '--cwd',                  field: 'cwd',                kind: 'string'      },
  { flag: '--schedule',             field: 'schedule',           kind: 'string'      },
  { flag: '--trigger-mode',         field: 'triggerMode',        kind: 'string'      },
  { flag: '--missed-firing',        field: 'missedFiring',       kind: 'string'      },
  { flag: '--depends-on',           field: 'dependsOn',          kind: 'string'      },
  { flag: '--timeout',              field: 'timeoutSeconds',     kind: 'int'         },
  { flag: '--max-concurrency',      field: 'maxConcurrency',     kind: 'int'         },
  { flag: '--alert-after-failures', field: 'alertAfterFailures', kind: 'int'         },
  { flag: '--sla-window',           field: 'slaWindowMinutes',   kind: 'int'         },
  { flag: '--tags',                 field: 'tags',               kind: 'stringList'  },
  { flag: '--secrets',              field: 'secrets',            kind: 'stringList'  },
  { flag: '--retry-on-exit-codes',  field: 'retryOnExitCodes',   kind: 'numberList'  },
  { flag: '--retry-delays',         field: 'retryDelays',        kind: 'numberList'  },
  { flag: '--skip-exit-codes',      field: 'skipExitCodes',      kind: 'numberList'  },
  { flag: '--env',                  field: 'env',                kind: 'map'         },
  { flag: '--on-exit-code',         field: 'onExitCode',         kind: 'map'         },
  { flag: '--dry-run-supported',    field: 'dryRunSupported',    kind: 'presence'    },
  { flag: '--restart-on-exit',      field: 'restartOnExit',      kind: 'restart-switch' },
  { flag: '--restart-strategy',     field: 'strategy',           kind: 'restart'     },
  { flag: '--restart-delay',        field: 'initialDelaySeconds', kind: 'restart'    },
  { flag: '--restart-factor',       field: 'factor',             kind: 'restart'     },
  { flag: '--restart-step',         field: 'stepSeconds',        kind: 'restart'     },
  { flag: '--restart-max-delay',    field: 'maxDelaySeconds',    kind: 'restart'     },
  { flag: '--restart-max',          field: 'maxRestarts',        kind: 'restart'     },
  { flag: '--restart-window',       field: 'windowSeconds',      kind: 'restart'     },
  { flag: '--restart-stable-after', field: 'stableAfterSeconds', kind: 'restart'     },
  { flag: '--log-max-size',        field: 'maxSizeMb',          kind: 'log-rotation' },
  { flag: '--log-keep',            field: 'keepSegments',       kind: 'log-rotation' },
  { flag: '--resource-enforce',     field: 'enforce',            kind: 'resource'    },
  { flag: '--hard-factor',          field: 'hardFactor',         kind: 'resource'    },
  { flag: '--soft-factor',          field: 'softFactor',         kind: 'resource'    },
  { flag: '--sustain',              field: 'sustainSeconds',     kind: 'resource'    },
  { flag: '--max-cpu',              field: 'maxCpuPct',          kind: 'resource'    },
  { flag: '--max-ram',              field: 'maxRamMb',           kind: 'resource'    },
];

/** Flags accepted alongside the field flags, so the unknown-flag check does not reject them. */
export const EXTRA_ADD_FLAGS  = ['--once', '--disabled', '--delay', '--json', '--progress', '--progress-options',
                          '--liveness-strategy', '--liveness-port-file', '--liveness-command', '--liveness-timeout',
                          '--active-from', '--active-until', '--active-for'];
export const EXTRA_EDIT_FLAGS = ['--unset', '--delay', '--json', '--progress', '--progress-options',
                          '--liveness-strategy', '--liveness-port-file', '--liveness-command', '--liveness-timeout',
                          '--active-from', '--active-until', '--active-for'];

/** Flags that consume the next argument; the rest are presence-only. */
function takesValue(flagName: string): boolean {
  const known = JOB_FIELD_FLAGS.find(f => f.flag === flagName);
  if (known) {
    return known.kind !== 'presence' && known.kind !== 'restart-switch';
  }
  return !['--once', '--disabled', '--json'].includes(flagName);
}

/** All occurrences of a repeatable flag, values untouched -- no splitting on ',' or anything else. */
function rawOccurrences(argv: string[], name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== name) {
      continue;
    }
    const raw = argv[i + 1];
    if (raw === undefined) {
      throw new Error(`${name} needs a value, but was followed by nothing.`);
    }
    out.push(raw);
    i++;
  }
  return out;
}

/**
 * KEY=VALUE pairs for --env and --on-exit-code.
 *
 * Splits on the FIRST '=' only and never on commas: a token, a URL or a message routinely contains
 * both, and splitting them would corrupt the value rather than fail.
 */
function mapFlag(argv: string[], name: string): Record<string, string> | undefined {
  const raws = rawOccurrences(argv, name);
  if (raws.length === 0) {
    return undefined;
  }
  const out: Record<string, string> = {};
  for (const raw of raws) {
    const eq = raw.indexOf('=');
    if (eq <= 0) {
      throw new Error(`${name} expects KEY=VALUE, but got "${raw}".\n\n`
        + `Example: orch edit my-job ${name} ${name === '--env' ? 'TOKEN=abc' : '2=already running'}`);
    }
    out[raw.slice(0, eq)] = raw.slice(eq + 1);
  }
  return out;
}

/**
 * Reads every field flag present in argv into a payload.
 *
 * Throws on a malformed value, so the caller can report it as a validation error before the daemon is
 * contacted. An absent flag writes nothing, which is what makes `edit` a patch.
 */
function collectFieldFlags(argv: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const { flag: name, field, kind } of JOB_FIELD_FLAGS) {
    // Several flags, one nested field: read by resourceLimitFlags and restartFlags.
    if (kind === 'resource' || kind === 'restart' || kind === 'restart-switch' || kind === 'log-rotation') {
      continue;
    }
    if (kind === 'presence') {
      if (has(argv, name)) {
        out[field] = true;
      }
      continue;
    }
    if (kind === 'map') {
      const map = mapFlag(argv, name);
      if (map !== undefined) {
        out[field] = map;
      }
      continue;
    }
    if (kind === 'numberList') {
      const list = numberListFlag(argv, name);
      if (list !== undefined) {
        out[field] = list;
      }
      continue;
    }
    const raw = flag(argv, name);
    if (raw === undefined) {
      // Named, not skipped: a trailing `--description` used to be dropped and the command still
      // reported success.
      if (has(argv, name)) {
        throw new Error(`${name} needs a value, but was followed by nothing.`);
      }
      continue;
    }
    if (kind === 'string') {
      out[field] = raw;
    } else if (kind === 'int') {
      const n = Number(raw);
      if (!Number.isInteger(n)) {
        const unit = name === '--sla-window' ? 'minutes' : name === '--max-concurrency' ? 'runs' : 'seconds';
        throw new Error(`${name} expects a whole number of ${unit}, but got "${raw}".`);
      }
      out[field] = n;
    } else {
      const items = raw.split(',').map(v => v.trim()).filter(v => v !== '');
      if (items.length > 0) {
        out[field] = items;
      }
    }
  }
  return out;
}

const RESOURCE_FLAGS = JOB_FIELD_FLAGS.filter(f => f.kind === 'resource');

/** The flag that sets a resourceLimits key, for an error that names what to type. */
function resourceFlagOf(key: string): string | undefined {
  return RESOURCE_FLAGS.find(f => f.field === key)?.flag;
}

/**
 * The resourceLimits keys given as flags; undefined when none is. A flag with no value, or a number that
 * is not one, is an error here; ranges are checked by resourceLimitsError on the whole object.
 */
function resourceLimitFlags(argv: string[]): ResourceLimits | undefined {
  const out: Record<string, unknown> = {};
  for (const { flag: name, field } of RESOURCE_FLAGS) {
    if (!has(argv, name)) {
      continue;
    }
    const raw = flag(argv, name);
    if (raw === undefined) {
      throw new Error(`${name} needs a value, but was followed by nothing.`);
    }
    if (field === 'enforce') {
      out[field] = raw;
      continue;
    }
    const n = raw.trim() === '' ? NaN : Number(raw);
    if (!Number.isFinite(n)) {
      throw new Error(`${name} expects a number, but got "${raw}".`);
    }
    out[field] = n;
  }
  return Object.keys(out).length === 0 ? undefined : out as ResourceLimits;
}

const RESTART_FLAGS = JOB_FIELD_FLAGS.filter(f => f.kind === 'restart');

/** What --restart-on-exit and the --restart-* options say. */
interface RestartFlags {
  /** --restart-on-exit was given. */
  switched: boolean;
  /** The options given as flags, by their key in restartOnExit. */
  options: Record<string, unknown>;
  /** The first option flag given, to name it in an error. */
  firstOption?: string;
}

/** The restart flags of a command; undefined when none is given. Throws on a flag without a value or a number that is not one. */
function restartFlags(argv: string[]): RestartFlags | undefined {
  const switched = has(argv, '--restart-on-exit');
  const options: Record<string, unknown> = {};
  let firstOption: string | undefined;
  for (const { flag: name, field } of RESTART_FLAGS) {
    if (!has(argv, name)) {
      continue;
    }
    const raw = flag(argv, name);
    if (raw === undefined) {
      throw new Error(`${name} needs a value, but was followed by nothing.`);
    }
    firstOption ??= name;
    if (field === 'strategy') {
      options[field] = raw;
      continue;
    }
    const n = raw.trim() === '' ? NaN : Number(raw);
    if (Number.isNaN(n)) {
      throw new Error(`${name} expects a number, but got "${raw}".`);
    }
    options[field] = n;
  }
  if (!switched && firstOption === undefined) {
    return undefined;
  }
  return { switched, options, ...(firstOption === undefined ? {} : { firstOption }) };
}

/** The restartOnExit value the flags ask for, merged over `current` and validated; throws a sentence naming the flag to change. */
function restartSettingOf(
  flags: RestartFlags, current: boolean | RestartOnExit | undefined, job: { id: string; retryOnExitCodes?: unknown; retryDelays?: unknown },
): boolean | RestartOnExit {
  const base: RestartOnExit = typeof current === 'object' && current !== null ? current : {};
  const merged = { ...base, ...flags.options } as RestartOnExit;
  const setting: boolean | RestartOnExit = Object.keys(merged).length === 0 ? true : merged;
  const problem = restartOnExitError(setting) ?? restartConflictError({ ...job, restartOnExit: setting });
  if (problem !== null) {
    const key = /restartOnExit\.(\w+)/.exec(problem)?.[1];
    const flagName = key === undefined ? undefined : RESTART_FLAGS.find(f => f.field === key)?.flag;
    const startOver = current !== undefined && current !== false && Object.keys(flags.options).length > 0
      ? ' (to start over from the defaults: orch edit <id> --unset restartOnExit, then set the options again)'
      : '';
    throw new Error(`${problem}${flagName === undefined ? '' : ` (flag: ${flagName})`}${startOver}`.replace(/<id>/g, job.id));
  }
  return setting;
}

const LOG_ROTATION_FLAGS = JOB_FIELD_FLAGS.filter(f => f.kind === 'log-rotation');

/**
 * The logRotation keys given as flags (--log-max-size, --log-keep); undefined when none is. A flag with no value or a number
 * that is not one is an error here; ranges are checked by checkLogRotation on the whole object.
 */
function logRotationFlags(argv: string[]): LogRotation | undefined {
  const out: Record<string, number> = {};
  for (const { flag: name, field } of LOG_ROTATION_FLAGS) {
    if (!has(argv, name)) {
      continue;
    }
    const raw = flag(argv, name);
    if (raw === undefined) {
      throw new Error(`${name} needs a value, but was followed by nothing.`);
    }
    const n = raw.trim() === '' ? NaN : Number(raw);
    if (!Number.isFinite(n)) {
      throw new Error(`${name} expects ${field === 'maxSizeMb' ? 'a number of megabytes (0 turns the rotation off)' : 'a whole number of segments'}, but got "${raw}".`);
    }
    out[field] = n;
  }
  return Object.keys(out).length === 0 ? undefined : out as LogRotation;
}

/** Throws the validation sentence for `setting`, with the flag to change appended; no-op when valid. */
function checkLogRotation(setting: LogRotation, jobId: string): void {
  const problem = logRotationError(setting);
  if (problem === null) {
    return;
  }
  const key = /logRotation\.(\w+)/.exec(problem)?.[1];
  const flagName = key === undefined ? undefined : LOG_ROTATION_FLAGS.find(f => f.field === key)?.flag;
  throw new Error(`${problem}${flagName === undefined ? '' : ` (flag: ${flagName})`}`.replace(/<id>/g, jobId));
}

/** Throws the validation sentence for `limits`, with the flag to change appended; no-op when valid. */
function checkResourceLimits(limits: ResourceLimits): void {
  const problem = resourceLimitsError(limits);
  if (problem === null) {
    return;
  }
  const key = /resourceLimits\.(\w+)/.exec(problem)?.[1];
  const flagName = key === undefined ? undefined : resourceFlagOf(key);
  throw new Error(flagName === undefined ? problem : `${problem} (flag: ${flagName})`);
}

/**
 * `--progress <mode>` and `--progress-options <json|@file>` into the job's `progress` setting; undefined when
 * neither is given. Validated here with the daemon's own rule, so a typo costs no round-trip and the error
 * lists the registered strategies. The setting is replaced as a whole: options without a mode are refused,
 * because there is no old mode to attach them to that the user could see.
 */
function progressFlags(argv: string[]): JobProgressSetting | undefined {
  const mode = flag(argv, '--progress');
  const optionsRaw = flag(argv, '--progress-options');
  if (mode === undefined && has(argv, '--progress')) {
    throw new Error(`--progress needs a value, but was followed by nothing. Accepted: ${PROGRESS_MODES.join(', ')}, ${PROGRESS_STRATEGY_IDS.join(', ')}.`);
  }
  if (optionsRaw === undefined && has(argv, '--progress-options')) {
    throw new Error('--progress-options needs a value (a JSON object, or @path/to/file.json), but was followed by nothing.');
  }
  if (mode === undefined) {
    if (optionsRaw !== undefined) {
      throw new Error('--progress-options needs --progress <strategy>: the options belong to a strategy, and the setting is replaced as a whole.\n\n'
        + 'Example: orch edit my-job --progress ratio --progress-options \'{"pattern":"(\\\\d+)/(\\\\d+)"}\'');
    }
    return undefined;
  }
  let setting: JobProgressSetting = mode;
  if (optionsRaw !== undefined) {
    let text = optionsRaw;
    if (optionsRaw.startsWith('@')) {
      const file = optionsRaw.slice(1);
      try {
        text = fs.readFileSync(file, 'utf8');
      } catch (e) {
        throw new Error(`--progress-options: cannot read "${file}": ${getErrorMessage(e)}`);
      }
      if (text.trim() === '') {
        throw new Error(`--progress-options: "${file}" is empty; expected a JSON object.`);
      }
    }
    let options: unknown;
    try {
      options = JSON.parse(text);
    } catch (e) {
      throw new Error(`--progress-options is not valid JSON (${getErrorMessage(e)}). Pass a JSON object, or @file.json (@ followed by a path) to read it from a file.`);
    }
    setting = { strategy: mode, options };
  }
  const problem = progressSettingError(setting);
  if (problem !== null) {
    throw new Error(`${problem} (flag: --progress${optionsRaw !== undefined ? ' / --progress-options' : ''})`);
  }
  return setting;
}

/**
 * Refuses a flag nobody reads, instead of ignoring it.
 *
 * The whole reason `--timeout` appeared to do nothing: an unrecognised flag was dropped without a
 * word, and the command still reported success. shared-cli's warnUnknownArgs cannot be used here --
 * it only warns and continues, so a typo'd flag on `add`/`edit` would again be silently accepted
 * (same class of bug) instead of failing the command. It also always needs a hardcoded value-flags
 * list; this function derives which flags take a value from JOB_FIELD_FLAGS, which `add` and `edit`
 * already maintain, so new fields stay correct here for free.
 */
function rejectUnknownFlags(argv: string[], extra: string[], cmdName: string): void {
  const known = new Set([...JOB_FIELD_FLAGS.map(f => f.flag), ...extra]);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith('--')) {
      continue;
    }
    if (known.has(arg)) {
      // Skip the value, which may itself start with -- (`--command "--version"`).
      if (takesValue(arg)) {
        i++;
      }
      continue;
    }
    errorExit(`${cmdName}: unknown flag "${arg}".\n\nAccepted flags: `
      + `${[...known].sort().join(', ')}`, 4);
  }
}

/**
 * Reads `--active-from`, `--active-until` and `--active-for` into the job's window fields.
 *
 * `--active-for` is the form the feature is actually wanted in - "active for three weeks" - and is
 * measured from `--active-from` when one is given, so a window can be both future and bounded:
 * `--active-from 2026-03-01 --active-for 3w`.
 *
 * Giving both `--active-for` and `--active-until` is refused rather than silently preferring one.
 * They are two ways of saying the same thing, and picking a winner would mean the job ends at a time
 * the user did not ask for.
 */
function activeWindowFlags(argv: string[]): Record<string, string> {
  const from  = flag(argv, '--active-from');
  const until = flag(argv, '--active-until');
  const forStr = flag(argv, '--active-for');

  if (forStr !== undefined && until !== undefined) {
    throw new Error('Use either --active-for or --active-until, not both: they set the same field.');
  }

  const out: Record<string, string> = {};
  let fromMs = Date.now();
  if (from !== undefined) {
    fromMs = new Date(from).getTime();
    if (!Number.isFinite(fromMs)) {
      throw new Error(`Invalid --active-from: "${from}". Expected a date, e.g. 2026-03-01 or 2026-03-01T09:00:00Z`);
    }
    out['activeFrom'] = new Date(fromMs).toISOString();
  }
  if (until !== undefined) {
    const untilMs = new Date(until).getTime();
    if (!Number.isFinite(untilMs)) {
      throw new Error(`Invalid --active-until: "${until}". Expected a date, e.g. 2026-03-22 or 2026-03-22T18:00:00Z`);
    }
    out['activeUntil'] = new Date(untilMs).toISOString();
  }
  if (forStr !== undefined) {
    out['activeUntil'] = new Date(fromMs + parseActiveFor(forStr)).toISOString();
  }
  return out;
}

/**
 * Every value given to a repeatable flag, splitting comma-separated lists, so `--unset a,b` and
 * `--unset a --unset b` mean the same thing.
 *
 * Throws when a value is missing or is the next flag: `flag()` reads argv[idx + 1] blindly, so
 * `orch edit j --unset --label x` would otherwise clear a field named "--label".
 */
function multiFlag(argv: string[], name: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== name) {
      continue;
    }
    const raw = argv[i + 1];
    if (raw === undefined || raw.startsWith('--')) {
      throw new Error(`${name} needs a value, but was followed by ${raw === undefined ? 'nothing' : `"${raw}"`}.`);
    }
    values.push(...raw.split(',').map(v => v.trim()).filter(v => v !== ''));
    i++;
  }
  return values;
}


/** The seconds given to --liveness-timeout, or undefined when absent. Throws on a flag with no value or a non-integer. */
export function livenessTimeoutFlag(argv: string[]): number | undefined {
  const raw = flag(argv, '--liveness-timeout');
  if (raw === undefined) {
    if (has(argv, '--liveness-timeout')) {
      throw new Error('--liveness-timeout needs a value, but was followed by nothing.');
    }
    return undefined;
  }
  const n = Number(raw);
  if (!Number.isInteger(n)) {
    throw new Error(`--liveness-timeout expects a whole number of seconds, but got "${raw}".`);
  }
  return n;
}

export function buildLiveness(argv: string[]): LivenessConfig | null {
  const strategy = flag(argv, '--liveness-strategy');
  // These are only ever read through a strategy, so on their own they would be accepted and then
  // do nothing -- which is how `--liveness-port-file` used to write a junk `livenessPortFile` field.
  if (!strategy) {
    for (const orphan of ['--liveness-port-file', '--liveness-command', '--liveness-timeout']) {
      if (has(argv, orphan)) {
        errorExit(`${orphan} needs --liveness-strategy, otherwise there is no check to attach it to.`
          + `\n\nExample: orch edit my-job --liveness-strategy `
          + `${orphan === '--liveness-port-file' ? 'portFile --liveness-port-file <path>' : 'command --liveness-command "<cmd>"' + (orphan === '--liveness-timeout' ? ' --liveness-timeout 60' : '')}`
          + `\n\nStrategies: none, portFile, pidFile, command`, 4);
      }
    }
  }
  if (!strategy || strategy === 'none') {
    return null;
  }
  const liveness: LivenessConfig = { strategy: strategy as LivenessConfig['strategy'] };
  if (strategy === 'portFile') {
    liveness.portFile = flag(argv, '--liveness-port-file');
  }
  if (strategy === 'command')  {
    liveness.command  = flag(argv, '--liveness-command');
  }
  try {
    const timeout = livenessTimeoutFlag(argv);
    // Set whatever the strategy: the registry refuses it with anything but `command`, and says why, rather than dropping it here.
    if (timeout !== undefined) {
      liveness.timeoutSeconds = timeout;
    }
  } catch (e) {
    errorExit(getErrorMessage(e), 4);
  }
  return liveness;
}

/**
 * A comma-separated list of numbers, or undefined when the flag is absent.
 *
 * Throws on anything non-numeric: `.split(',').map(Number)` turns a typo into [NaN], which reaches
 * the registry as a valid array of numbers and then silently matches no exit code at all.
 */
function numberListFlag(argv: string[], name: string): number[] | undefined {
  const raw = flag(argv, name);
  if (raw === undefined || raw === '') {
    return undefined;
  }
  const parts = raw.split(',').map(v => v.trim()).filter(v => v !== '');
  const values = parts.map((part) => {
    const n = Number(part);
    if (!Number.isFinite(n)) {
      throw new Error(`${name} expects numbers separated by commas, but got "${part}" in "${raw}".`);
    }
    return n;
  });
  return values.length > 0 ? values : undefined;
}

function errorExit(message: string, exitCode: number = 1): never {
  console.error(`\nError: ${message}\n`);
  process.exit(exitCode);
}

// ---------------------------------------------------------------------------
// Output: context-aware (TTY -> human, no-TTY or --json -> JSON)
// ---------------------------------------------------------------------------

function output(data: unknown, forceJson: boolean): void {
  if (!forceJson && process.stdout.isTTY) {
    if (typeof data === 'string') { console.log(data); return; }
    console.log(JSON.stringify(data, null, 2));
  } else {
    console.log(JSON.stringify(data));
  }
}

const CLI_GROUP_HELP = `
orch cli -- internal management commands

Usage: orch cli <subcommand>

Subcommands:
  self-check         Validate bundle integrity (exit 0=ok, 1=fail)
  logs [--follow]    Read today's orchestrator log file; --follow tails it
  update             Run a foreground update check

Environment variables:
  ORCH_CONFIG_DIR         Config directory (default: ~/.config/orchestrator)
  ORCH_UPDATE_INTERVAL    Background update check interval (e.g. 4h, 30m, 1d)
  CLI_SELF_CHECK_QUIET=1  Suppress self-check output
`.trim();

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function runCli(argv: string[], deps: Partial<CliDeps> = {}): Promise<void> {
  const send        = deps.send        ?? (() => { throw new Error('no send'); });
  const startDaemon = deps.startDaemon ?? (() => {});
  const configDir   = deps.configDir   ?? DEFAULT_CONFIG_DIR;

  /**
   * Before a command that ends the daemon: says which running jobs die with it when no supervisor guards them
   * (the supervisor is off, or was asked for and is missing). Never asks and never blocks: the command goes ahead.
   * A daemon that is down has nothing to lose; any other failure to find out is said, not swallowed.
   */
  const warnJobsDie = async (action: string, knownState?: Record<string, RuntimeEntry[]>): Promise<void> => {
    try {
      const info = await send('get-daemon-info', undefined, { autoStart: false }) as DaemonInfo;
      if (typeof info !== 'object' || info === null || !info.supervisor) {
        throw new Error('the answer has no supervisor section');
      }
      if (info.supervisor.active) {
        return;
      }
      const state = knownState ?? await send('list-state', undefined, { autoStart: false }) as Record<string, RuntimeEntry[]>;
      const warning = unsupervisedWarning(action, info.supervisor, state);
      if (warning !== null) {
        console.error(warning);
      }
    } catch (e) {
      if (isDaemonDownError(e)) {
        return;
      }
      console.error(`warning: could not check whether the running jobs survive ${action} (${getErrorMessage(e)}). If the daemon is older than this CLI, jobs without a supervisor die with it; see: orch status`);
    }
  };
  const forceJson   = has(argv, '--json');

  // Log every CLI invocation to configDir/logs/YYYY-MM-DD.ndjson
  const cleanCmd = argv.filter(a => a !== '--json');
  if (cleanCmd[0] !== 'logs' && cleanCmd[1] !== 'logs') {
    try { logCliInvocation(configDir, 'orch', argv); } catch { /* never block */ }
  }

  // --- Global flags that don't require a running daemon ---

  if (has(argv, '--version')) {
    console.log(version);
    return;
  }

  // `orch job --help`, `orch job <jobId> logs -h`: the help of that command, not the whole reference.
  if (argv[0] === 'job' && (has(argv, '--help') || has(argv, '-h'))) {
    console.log(argv.includes('logs') && argv.indexOf('logs') >= 2 ? JOB_LOGS_HELP : JOB_HELP);
    return;
  }

  if (has(argv, '--help') || argv[0] === 'help') {
    console.log(HELP_TEXT);
    return;
  }

  if (has(argv, '--pid')) {
    const fs = require('node:fs') as typeof import('node:fs');
    const portFile = path.join(configDir, 'config.port');
    if (!fs.existsSync(portFile)) {
      console.log('not running');
      return;
    }
    try {
      const { pid, port } = JSON.parse(fs.readFileSync(portFile, 'utf8')) as { pid: number; port: number };
      try { process.kill(pid, 0); console.log(`pid=${pid}  port=${port}`); }
      catch { console.log('not running (stale port file)'); }
    } catch { console.log('not running'); }
    return;
  }

  // Strip global flags before command dispatch
  const cleanArgv = argv.filter(a => a !== '--json');
  const [cmd, ...rest] = cleanArgv;

  switch (cmd) {

    case 'status': {
      // 'version' is special: resolved via client.version() in the entry point send wrapper.
      // Without auto-start: asking whether the daemon runs must not be the thing that starts it.
      let data: { pid: number; port: number; uptime?: number };
      try {
        data = await send('version', undefined, { autoStart: false }) as { pid: number; port: number; uptime?: number };
      } catch (e) {
        if (!isDaemonDownError(e)) {
          console.error(`Orchestrator did not answer properly: ${getErrorMessage(e)}\nCheck: orch logs`);
        } else {
          // A daemon that died of an uncaught error left crashed.json: "not running" alone hid a 47-minute outage.
          let crashed: CrashMarker | null = null;
          try {
            crashed = readCrashMarker(configDir);
          } catch (markerError) {
            console.error(`warning: ${getErrorMessage(markerError)}`);
          }
          if (forceJson || !process.stdout.isTTY) {
            console.log(JSON.stringify(crashed === null ? { running: false } : { running: false, crashed }));
          } else if (crashed === null) {
            console.log('Orchestrator is not running. Start it with: orch start');
          } else {
            console.log(
              `Orchestrator is stopped: crashed at ${crashed.time} (${crashed.kind}: ${crashed.error}), version ${crashed.version}.
`
              + `See ${path.join(configDir, 'logs', 'app')} (daemon-*.log, "daemon crash" lines). Start it again with: orch start`,
            );
          }
        }
        process.exitCode = 1;
        break;
      }
      // The daemon's own details (supervisor, run counts, timer health). Same rule as above: no auto-start. A daemon
      // that answers `version` but not this (an older one, or a wiring fault) still gets its pid/port/uptime
      // reported, with the failure said in words rather than the details silently missing.
      let info: DaemonInfo | undefined;
      let infoError: string | undefined;
      try {
        info = await send('get-daemon-info', undefined, { autoStart: false }) as DaemonInfo;
        if (typeof info !== 'object' || info === null || !info.supervisor || !info.scheduler || !info.runs) {
          throw new Error('the answer has no supervisor, runs or scheduler section');
        }
      } catch (e) {
        info = undefined;
        infoError = getErrorMessage(e);
      }
      // Progress of the running jobs. Advisory: a daemon that cannot answer it (an older one) still gets its status
      // printed, with the failure said in words.
      let progress: Record<string, ProgressEstimate> | undefined;
      let progressError: string | undefined;
      try {
        progress = await send('get-progress', undefined, { autoStart: false }) as Record<string, ProgressEstimate>;
      } catch (e) {
        progressError = getErrorMessage(e);
      }
      if (forceJson || !process.stdout.isTTY) {
        console.log(JSON.stringify({
          ...data, ...(info ? { info } : {}), ...(infoError !== undefined ? { infoError } : {}),
          ...(progress ? { progress } : {}), ...(progressError !== undefined ? { progressError } : {}),
        }));
      } else {
        console.log(`pid=${data.pid}  port=${data.port}  uptime=${data.uptime ?? '?'}s`);
        if (info) {
          for (const line of describeDaemonInfo(info)) {
            console.log(line);
          }
        }
        if (progress && Object.keys(progress).length > 0) {
          console.log('progress  :');
          for (const line of describeProgress(progress)) {
            console.log(line);
          }
        }
      }
      if (progressError !== undefined && !(forceJson || !process.stdout.isTTY)) {
        console.error(`warning: could not read the progress of the running jobs (${progressError}). If the daemon is older than this CLI, run: orch cli update`);
      }
      if (infoError !== undefined && !(forceJson || !process.stdout.isTTY)) {
        console.error(`warning: could not read the daemon details (${infoError}). The supervisor state and the timer health are unknown; if the daemon is older than this CLI, run: orch restart (or orch cli update).`);
      }
      break;
    }

    case 'start': {
      startDaemon();

      // Readiness is confirmed on BOTH paths. Exiting 0 straight after spawning reported
      // success to scripts even when the launcher failed to bring the daemon up, so
      // `orch start --no-follow && orch trigger job` raced against startup.
      if (!await waitForDaemonAlive(configDir, 5000)) {
        console.error('Daemon did not start within 5s. Check: orch logs');
        process.exit(2);
      }

      // In an interactive TTY, default to following logs so a manual `orch start` shows
      // startup output. --no-follow opts out of that; --follow/-f forces it when piped.
      const follow = has(rest, '--no-follow')
        ? false
        : has(rest, '--follow') || has(rest, '-f') || process.stdout.isTTY;
      if (follow) {
        console.log('Daemon started. Following logs (Ctrl+C to stop)...');
        await cliLogsCommand(configDir, { follow: true });
      } else {
        console.log('Daemon started.');
      }
      process.exit(0);
    }

    case 'stop': {
      const fs = require('node:fs') as typeof import('node:fs');
      if (!fs.existsSync(path.join(configDir, 'config.port'))) {
        console.log('Orchestrator is not running.');
        break;
      }
      // Jobs run under their own supervisor outlive the daemon, so stopping it is no longer how they end. Say which
      // ones keep running, or end them first with --kill-jobs.
      const killJobs = has(rest, '--kill-jobs');
      let keepRunning: string[] = [];
      let ended = 0;
      try {
        const state = await send('list-state') as Record<string, RuntimeEntry[]>;
        const running = runningJobs(state);
        if (killJobs) {
          for (const id of running.all) {
            try {
              await send('kill-job', { id });
              ended++;
            } catch (e) {
              console.error(`Could not end job "${id}": ${getErrorMessage(e)}`);
            }
          }
        } else {
          keepRunning = running.supervised;
          await warnJobsDie('orch stop', state);
        }
      } catch (e) {
        console.error(`Stopping anyway, but could not list the running jobs (${getErrorMessage(e)}): supervised jobs keep running, see: orch list --verbose`);
      }
      await send('quit');
      if (killJobs && ended > 0) {
        console.log(`${ended} job(s) ended.`);
      }
      console.log('Orchestrator stopped.');
      if (keepRunning.length > 0) {
        console.log(`${keepRunning.length} job(s) keep running without the daemon and will be followed again at the next start: ${keepRunning.join(', ')}.\nEnd them with: orch stop --kill-jobs (or orch kill <id> after the next start).`);
      }
      break;
    }

    case 'restart': {
      // `orch restart my-job` used to restart the whole daemon and ignore the id: every job that keeps
      // running under the daemon's care would have been affected by a typo for restart-job.
      const jobArg = rest.find(a => !a.startsWith('-'));
      if (jobArg !== undefined) {
        console.error(`orch restart restarts the daemon and takes no job id (got "${jobArg}"); nothing was restarted.
To restart the job, run: orch restart-job ${jobArg}`);
        process.exit(1);
      }
      await warnJobsDie('orch restart');
      await send('restart');
      console.log('Orchestrator restarted.');
      break;
    }

    case 'install': {
      const { enableStartup } = await import('./startup.js');
      const result = enableStartup(configDir);
      if (result.ok) {
        console.log(`Orchestrator registered for startup. (${result.detail})`);
        for (const w of result.warnings ?? []) {
          console.error(`Warning: ${w}`);
        }
      } else {
        console.error(`Failed to register startup: ${result.error}`);
        process.exit(1);
      }
      break;
    }

    case 'uninstall': {
      const { disableStartup } = await import('./startup.js');
      const result = disableStartup(configDir);
      if (result.ok) {
        console.log(`Orchestrator removed from startup. (${result.detail})`);
      } else {
        console.error(`Failed to remove startup: ${result.error}`);
        process.exit(1);
      }
      break;
    }

    case 'list': {
      const verbose = has(rest, '--verbose');
      const showPast = has(rest, '--past');
      const [allJobs, stateMap] = await Promise.all([
        send('list-jobs') as Promise<Array<Record<string, unknown>>>,
        verbose
          ? (send('list-state') as Promise<Record<string, Array<Record<string, unknown>>>>)
          : Promise.resolve({} as Record<string, Array<Record<string, unknown>>>),
      ]);
      /*
       * A spent once job is kept in the registry now rather than deleted, so without this the list
       * would carry a line for every one-off job ever run - up to the retention bound of fifty - and
       * the jobs that still have a firing ahead of them would be lost among them.
       *
       * Filtered before the JSON branch, not only in the rendering, so `orch list` means the same
       * thing to an agent as it does to a person. Both get the past with `--past`.
       */
      const jobs = (allJobs ?? []).filter((j) => showPast || j['spent'] !== true);
      const hiddenPast = (allJobs?.length ?? 0) - jobs.length;
      // Said, not left to be discovered: a job the user knows they created and cannot find in the
      // list reads as data loss. Only on the human path, so the JSON stays parseable.
      const pastNote = (): void => {
        if (hiddenPast === 0) {
          return;
        }
        console.log(
          `\n${hiddenPast} past once job${hiddenPast === 1 ? '' : 's'} hidden (already fired). `
          + `Show with: orch list --past`,
        );
      };
      if (!jobs.length) {
        // "No jobs registered." would be a lie when the registry holds jobs this view is hiding, and
        // it is the exact wording a user would read as "my jobs are gone".
        const empty = hiddenPast > 0 ? 'No jobs left to fire.' : 'No jobs registered.';
        output(forceJson || !process.stdout.isTTY ? [] : empty, forceJson);
        if (!forceJson && process.stdout.isTTY) {
          pastNote();
        }
        break;
      }
      if (forceJson || !process.stdout.isTTY) {
        output(jobs, forceJson);
        break;
      }
      for (const j of jobs) {
        let scheduleDisplay: string;
        if (j['type'] === 'once') {
          // A spent job has no countdown left; "overdue by 14d" would describe a moment it has
          // already acted on, which reads as a job that is late rather than one that is finished.
          scheduleDisplay = j['spent'] === true
            ? `fired ${describeAgo(j['spentAt'] === undefined ? NaN : String(j['spentAt']), Date.now())}`
            // Says "overdue by X" rather than clamping to "in 0s", which read as "about to fire" for a
            // job whose moment had passed - the state that means the daemon was down when it was due.
            : onceScheduleDisplay(
              j['scheduledAt'] === undefined ? undefined : String(j['scheduledAt']),
              j['delayMs'] === undefined ? undefined : Number(j['delayMs']),
              Date.now(),
            );
        } else if (j['type'] === 'manual') {
          scheduleDisplay = `run with: orch trigger ${String(j['id'])}`;
        } else {
          scheduleDisplay = j['schedule'] != null ? String(j['schedule']) : String(j['delaySeconds']) + 's';
        }
        // violations-suppress: shared/no-emoji local/no-unicode-symbol CLI terminal indicator - intentional visual marker for enabled/disabled state
        const line  = `${j['enabled'] ? '✓' : '✗'} ${String(j['id']).padEnd(24)} ${String(j['type']).padEnd(8)} ${scheduleDisplay}`;
        let extra = '';
        if (verbose) {
          const history = stateMap[String(j['id'])];
          const lastRun = Array.isArray(history) && history.length > 0 ? history[0] : null;
          extra = `  last=${String(lastRun?.['startedAt'] ?? '-')}  exit=${String(lastRun?.['exitCode'] ?? '-')}`;
        }
        console.log(line + extra);
      }
      pastNote();
      break;
    }

    /*
     * What the daemon has actually armed, beside what the registry asks for.
     *
     * Added because every "it was configured and never fired" bug in this project needed someone to
     * read the scheduler's source to find, and each one would have been one line here. `problem` is
     * the field to read first; everything else is context for it.
     *
     * JSON when piped, which is how an agent will call it.
     */
    case 'timers': {
      const rows = await send('list-timers') as Array<{
        jobId: string; type: string; enabled: boolean; armed: string | null;
        dueAt: string | null; windowEndsAt: string | null; nextFiring: string | null;
        windowState: string | null; spent: boolean; problem: string | null;
      }>;

      // On stderr in both modes: piped, stdout stays the bare JSON array an agent parses, and the warning is still seen.
      const failing = rows.filter(r => r.problem !== null);
      if (failing.length > 0) {
        console.error(`warning: ${failing.length} job(s) will not fire as configured: ${failing.map(r => r.jobId).join(', ')}. Each one's "problem" says why.`);
      }

      if (forceJson || !process.stdout.isTTY) {
        output(rows, forceJson);
        break;
      }
      if (rows.length === 0) {
        console.log('No jobs registered.');
        break;
      }

      for (const r of rows) {
        const due  = r.dueAt ?? r.nextFiring;
        // A spent once job has nothing scheduled and that is correct, so it says which of the two
        // "nothing armed" states it is in. Both lines used to read "not armed / nothing scheduled",
        // which is the same words for a finished job and for one the scheduler had lost track of.
        const when = r.spent
          ? 'already fired'
          : r.type === 'manual' && due === null ? 'trigger only'
          : due !== null ? `${due} (${describeMoment(due, Date.now())})` : 'nothing scheduled';
        // violations-suppress: shared/no-emoji local/no-unicode-symbol CLI terminal indicator - marks the armed/not-armed state the way `orch list` marks enabled/disabled
        const mark = r.problem === null ? '✓' : '✗';
        const armedCol = r.spent ? 'spent' : (r.armed ?? (r.type === 'manual' ? 'manual' : 'not armed'));
        console.log(`${mark} ${r.jobId.padEnd(24)} ${r.type.padEnd(8)} ${armedCol.padEnd(14)} ${when}`);
        if (r.windowState !== null && r.windowState !== 'active') {
          console.log(`    window: ${r.windowState}`);
        }
        // The other timer a cron job can carry. Without it, "why did my job disable itself" has no
        // answer in this output.
        if (r.windowEndsAt !== null) {
          console.log(`    active period ends: ${r.windowEndsAt} (${describeMoment(r.windowEndsAt, Date.now())})`);
        }
        if (r.problem !== null) {
          console.log(`    problem: ${r.problem}`);
        }
      }
      const broken = rows.filter(r => r.problem !== null).length;
      // Spent jobs counted apart, because they are not armed and saying "all N armed as configured"
      // over a list containing them would be untrue of exactly the lines the reader can see.
      const spentCount = rows.filter(r => r.spent).length;
      const spentNote = spentCount === 0
        ? ''
        : ` ${spentCount} past once job(s) already fired.`;
      // Stated rather than left to be counted: a clean run should say so, and a dirty one should not
      // need the reader to scan for crosses.
      console.log(broken === 0
        ? `\nAll ${rows.length - spentCount} job(s) armed as configured.${spentNote}`
        : `\n${broken} of ${rows.length} job(s) will not fire as configured (see "problem" above).${spentNote}`);
      break;
    }

    case 'show': {
      const [id] = rest;
      const job = await send('get-job', { id });
      if (!job) { console.error(`Job not found: "${id}"`); process.exit(3); }
      output(job, forceJson);
      break;
    }

    case 'add': {
      let type: string;
      let id: string | undefined;
      let addRest: string[];

      if (has(rest, '--once')) {
        type = 'once';
        const positionals: string[] = [];
        for (let i = 0; i < rest.length; i++) {
          if (rest[i] === '--once' || rest[i] === '--disabled') {
            continue;
          }
          if (rest[i]!.startsWith('--')) {
            // takesValue knows every field flag. The hand-kept list this replaces lacked most of
            // them, so a free-text value (a description) in front of the id was read as the id.
            if (takesValue(rest[i]!)) {
              i++;
            }
          } else {
            positionals.push(rest[i]!);
          }
        }
        id      = positionals[0];
        addRest = rest.filter(a => a !== '--once');
      } else {
        const [t, i, ...r] = rest;
        type    = t ?? '';
        id      = i;
        addRest = r;
      }

      if (!id) {
        errorExit(`Missing job id.

Usage patterns:
  orch add cron <id> --schedule "..." --command "..."
  orch add startup <id> --command "..."
  orch add --once <id> --delay <duration> --command "..."
  orch add manual <id> --command "..."

Examples:
  orch add cron backup --schedule "0 2 * * *" --command "/home/user/backup.sh"
  orch add startup check-health --command "curl http://localhost:8080/health"
  orch add --once report --delay 1h --command "node scripts/report.js"
  orch add manual deploy --command "node scripts/deploy.js"`, 4);
      }
      rejectUnknownFlags(addRest, EXTRA_ADD_FLAGS, 'orch add');
      if (type === 'manual') {
        const scheduling = ['--schedule', '--delay', '--missed-firing', '--active-for', '--active-from', '--active-until']
          .find(name => addRest.includes(name));
        if (scheduling !== undefined) {
          errorExit(`${scheduling} is not accepted on a manual job: manual jobs have no schedule, they run only when triggered.

To run on a schedule, create a cron job instead:
  orch add cron <id> --schedule "<expr>" --command "..."
To run this one, drop ${scheduling}, then: orch trigger <id>`, 4);
        }
      }
      const command = flag(addRest, '--command');
      if (!command) {
        errorExit(`--command is required for all job types.

Example: orch add cron backup --schedule "0 2 * * *" --command "~/backup.sh"`, 4);
      }

      const body: Record<string, unknown> = {
        id, type, command, enabled: !has(addRest, '--disabled'),
      };

      // Same table as `edit`, so a field cannot be settable at creation and not afterwards, or the
      // reverse. `command` is already in `body` above and collecting it again is harmless.
      try {
        Object.assign(body, collectFieldFlags(addRest));
      } catch (e) {
        errorExit(getErrorMessage(e), 4);
      }
      try {
        const resourceLimits = resourceLimitFlags(addRest);
        if (resourceLimits !== undefined) {
          checkResourceLimits(resourceLimits);
          body['resourceLimits'] = resourceLimits;
        }
      } catch (e) {
        errorExit(getErrorMessage(e), 4);
      }
      try {
        const restart = restartFlags(addRest);
        if (restart !== undefined) {
          if (!restart.switched) {
            throw new Error(`${restart.firstOption} needs --restart-on-exit: the options tune a restart policy, they do not turn it on. Add --restart-on-exit.`);
          }
          body['restartOnExit'] = restartSettingOf(restart, undefined, {
            id, retryOnExitCodes: numberListFlag(addRest, '--retry-on-exit-codes'), retryDelays: numberListFlag(addRest, '--retry-delays'),
          });
        }
      } catch (e) {
        errorExit(getErrorMessage(e), 4);
      }
      try {
        const logRotation = logRotationFlags(addRest);
        if (logRotation !== undefined) {
          checkLogRotation(logRotation, id);
          body['logRotation'] = logRotation;
        }
      } catch (e) {
        errorExit(getErrorMessage(e), 4);
      }
      const liveness = buildLiveness(addRest);
      if (liveness) {
        body['liveness'] = liveness;
      }
      try {
        const progress = progressFlags(addRest);
        if (progress !== undefined) {
          body['progress'] = progress;
        }
      } catch (e) {
        errorExit(getErrorMessage(e), 4);
      }

      if (type === 'cron') {
        const schedule = flag(addRest, '--schedule');
        if (!schedule) {
          errorExit(`--schedule is required for cron jobs.

Format: 5-field cron (min hour day month weekday)

Examples:
  "*/5 * * * *"   every 5 minutes
  "0 9 * * 1-5"   9 AM on weekdays (Monday-Friday)
  "30 8 * * *"    8:30 AM daily
  "0 0 1 * *"     midnight on the 1st of each month

Full usage: orch add cron <id> --schedule "<expr>" --command "..."`, 4);
        }
        body['schedule'] = schedule;
        const missedFiring = flag(addRest, '--missed-firing');
        if (missedFiring) {
          body['missedFiring'] = missedFiring;
        }
      }

      if (type === 'startup') {
        const delay = flag(addRest, '--delay');
        if (delay !== undefined) {
          body['delaySeconds'] = parseInt(delay, 10);
        }
      }

      if (type === 'cron') {
        try {
          Object.assign(body, activeWindowFlags(addRest));
        } catch (e) {
          errorExit((e as Error).message, 4);
        }
      }

      if (type === 'once') {
        const delayStr = flag(addRest, '--delay');
        if (!delayStr) {
          errorExit(`--delay is required for once jobs.

Supported formats: 30s, 2m, 1h, 1d

Examples:
  orch add --once report --delay 30s --command "node scripts/report.js"
  orch add --once cleanup --delay 2h --command "rm /tmp/*.log"
  orch add --once archive --delay 1d --command "tar czf archive.tar.gz /data"`, 4);
        }
        let delayMs: number;
        try {
          delayMs = parseDuration(delayStr);
        } catch (e) {
          errorExit((e as Error).message, 4);
        }
        body['delayMs']     = delayMs;
        body['scheduledAt'] = new Date().toISOString();
      }

      try {
        const addRetryOnExitCodes = numberListFlag(addRest, '--retry-on-exit-codes');
        const addRetryDelays      = numberListFlag(addRest, '--retry-delays');
        const addSkipExitCodes    = numberListFlag(addRest, '--skip-exit-codes');
        if (addRetryOnExitCodes) {
          body['retryOnExitCodes'] = addRetryOnExitCodes;
        }
        if (addRetryDelays)      {
          body['retryDelays']      = addRetryDelays;
        }
        if (addSkipExitCodes)    {
          body['skipExitCodes']    = addSkipExitCodes;
        }
      } catch (e) {
        errorExit(getErrorMessage(e), 4);
      }

      await send('add-job', body);
      console.log(`Job "${id}" added.`);
      break;
    }

    case 'remove': {
      const [id] = rest;
      const reply = await send('remove-job', { id }) as { leftovers?: Array<{ path: string; reason: string }> } | undefined;
      console.log(`Job "${id}" removed.`);
      // The job is gone; some of its derived data could not be deleted (a locked file), so say which and why.
      if (reply?.leftovers && reply.leftovers.length > 0) {
        const lines = reply.leftovers.map((l) => `  ${l.path || '(job id)'}: ${l.reason}`);
        console.error(`Not deleted (the daemon log has the same lines):\n${lines.join('\n')}\nDelete them by hand once the process holding them has ended.`);
      }
      break;
    }

    case 'enable': {
      const [id] = rest;
      await send('enable-job', { id });
      console.log(`Job "${id}" enabled.`);
      break;
    }

    case 'disable': {
      const [id] = rest;
      await send('disable-job', { id });
      console.log(`Job "${id}" disabled.`);
      break;
    }

    case 'edit': {
      const [id, ...editRest] = rest;
      const updates: Record<string, unknown> = {};
      rejectUnknownFlags(editRest, EXTRA_EDIT_FLAGS, 'orch edit');
      // The hand-written list this replaces also mapped --liveness-port-file to a `livenessPortFile`
      // key, which is not a field of Job: the daemon reads liveness.portFile. Used without
      // --liveness-strategy it wrote a junk key and changed no liveness check at all.
      try {
        Object.assign(updates, collectFieldFlags(editRest));
      } catch (e) {
        errorExit(getErrorMessage(e), 4);
      }
      try {
        const progress = progressFlags(editRest);
        if (progress !== undefined) {
          updates['progress'] = progress;
        }
      } catch (e) {
        errorExit(getErrorMessage(e), 4);
      }
      // An edit is a patch of restartOnExit too: the options are merged over the job's current setting here.
      let restartEdit: RestartFlags | undefined;
      try {
        restartEdit = restartFlags(editRest);
      } catch (e) {
        errorExit(getErrorMessage(e), 4);
      }
      if (restartEdit !== undefined) {
        const current = await send('get-job', { id }) as {
          restartOnExit?: boolean | RestartOnExit; retryOnExitCodes?: number[]; retryDelays?: number[];
        } | null;
        if (!current) {
          errorExit(`Job not found: "${id}". Run \`orch list\` to see the available job ids.`, 3);
        }
        const restarts = current.restartOnExit !== undefined && current.restartOnExit !== false;
        if (!restarts && !restartEdit.switched) {
          errorExit(`${restartEdit.firstOption} tunes a restart policy, and job "${id}" does not restart. `
            + `Add --restart-on-exit to turn it on: orch edit ${id} --restart-on-exit ${restartEdit.firstOption} <value>`, 4);
        }
        try {
          updates['restartOnExit'] = restartSettingOf(restartEdit, current.restartOnExit === false ? undefined : current.restartOnExit, { ...current, id });
        } catch (e) {
          errorExit(getErrorMessage(e), 4);
        }
      }
      // An edit is a patch of logRotation too: the keys given as flags are merged over the job's current setting here.
      let logRotationEdit: LogRotation | undefined;
      try {
        logRotationEdit = logRotationFlags(editRest);
      } catch (e) {
        errorExit(getErrorMessage(e), 4);
      }
      if (logRotationEdit !== undefined) {
        const current = await send('get-job', { id }) as { logRotation?: LogRotation } | null;
        if (!current) {
          errorExit(`Job not found: "${id}". Run \`orch list\` to see the available job ids.`, 3);
        }
        const merged = { ...(current.logRotation ?? {}), ...logRotationEdit };
        try {
          checkLogRotation(merged, id);
        } catch (e) {
          errorExit(getErrorMessage(e), 4);
        }
        updates['logRotation'] = merged;
      }
      const delay = flag(editRest, '--delay');
      if (delay !== undefined) {
        updates['delaySeconds'] = parseInt(delay, 10);
      }
      // Same flags as `add`, so extending or shortening a window is the same vocabulary as setting
      // one. `--unset activeUntil` removes the end and leaves the job running indefinitely.
      try {
        Object.assign(updates, activeWindowFlags(editRest));
      } catch (e) {
        errorExit(getErrorMessage(e), 4);
      }
      // Called even with no strategy, for its own validation: it is what refuses a lone
      // --liveness-port-file. Only ASSIGNED when a strategy was given, since liveness: null would
      // clear the job's existing check on every unrelated edit.
      const liveness = buildLiveness(editRest);
      if (flag(editRest, '--liveness-strategy')) {
        updates['liveness'] = liveness;
      }
      // An edit is a patch, so an omitted flag means "leave this alone" -- there is no value that
      // means "remove this option". --unset is how you say it. Names are checked here so a typo
      // costs no daemon round-trip and reports as a validation error.
      let unset: string[];
      try {
        unset = multiFlag(editRest, '--unset');
      } catch (e) {
        errorExit(`${getErrorMessage(e)}

Usage: orch edit <id> --unset <field>[,<field>...]

Example: orch edit my-job --unset cwd

Fields that can be unset: ${Object.keys(UNSETTABLE_FIELDS).join(', ')}`, 4);
      }
      if (unset.includes('logRotation') && 'logRotation' in updates) {
        errorExit('Cannot clear logRotation (--unset logRotation) and change it in the same command -- drop --unset logRotation or the --log-max-size/--log-keep flags.', 4);
      }
      // An edit is a patch of the resourceLimits object too: the flags and the `resourceLimits.<key>`
      // unsets are applied to the job's current limits here, and the result is sent as a whole.
      const keyUnsets = unset.filter(f => f.startsWith('resourceLimits.'));
      unset = unset.filter(f => !f.startsWith('resourceLimits.'));
      let resourceFlags: ResourceLimits | undefined;
      try {
        resourceFlags = resourceLimitFlags(editRest);
      } catch (e) {
        errorExit(getErrorMessage(e), 4);
      }
      if (unset.includes('resourceLimits') && (resourceFlags !== undefined || keyUnsets.length > 0)) {
        errorExit(`Cannot clear resourceLimits (--unset resourceLimits) and change it in the same command -- drop `
          + `--unset resourceLimits or the ${resourceFlags !== undefined ? 'resource flags' : '--unset resourceLimits.<key>'}.`, 4);
      }
      for (const entry of keyUnsets) {
        const key = entry.slice('resourceLimits.'.length);
        if (!(RESOURCE_LIMIT_KEYS as readonly string[]).includes(key)) {
          errorExit(`Unknown resourceLimits key in "--unset ${entry}": "${key}". Keys: ${RESOURCE_LIMIT_KEYS.join(', ')}. `
            + 'To clear all of them: orch edit <id> --unset resourceLimits', 4);
        }
        if (resourceFlags !== undefined && key in resourceFlags) {
          errorExit(`Cannot set and unset resourceLimits.${key} in the same command -- drop one of ${resourceFlagOf(key)} and --unset ${entry}.`, 4);
        }
      }
      if (resourceFlags !== undefined || keyUnsets.length > 0) {
        const job = await send('get-job', { id }) as { resourceLimits?: ResourceLimits } | null;
        if (!job) {
          errorExit(`Job not found: "${id}". Run \`orch list\` to see the available job ids.`, 3);
        }
        const merged: Record<string, unknown> = { ...(job.resourceLimits ?? {}), ...(resourceFlags ?? {}) };
        for (const entry of keyUnsets) {
          delete merged[entry.slice('resourceLimits.'.length)];
        }
        if (Object.keys(merged).length === 0) {
          unset.push('resourceLimits');
        } else {
          try {
            checkResourceLimits(merged as ResourceLimits);
          } catch (e) {
            errorExit(getErrorMessage(e), 4);
          }
          updates['resourceLimits'] = merged;
        }
      }
      for (const field of unset) {
        const problem = unsettableFieldError(field);
        if (problem) {
          errorExit(problem, 4);
        }
        if (field in updates) {
          errorExit(`Cannot set and unset "${field}" in the same command -- drop one of `
            + `--${field.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`)} and --unset ${field}.`, 4);
        }
      }

      await send('edit-job', { id, updates, ...(unset.length ? { unset } : {}) });
      console.log(`Job "${id}" updated.`);
      break;
    }

    case 'exec': {
      // One-shot command execution via the daemon (for agent delegation)
      const cmd = rest.join(' ');
      if (!cmd.trim()) {
        errorExit(`Missing command for exec.

Usage: orch exec "<command>" [--wait] [--label <label>]

Examples:
  orch exec "npm run build"
  orch exec "curl https://example.com" --wait
  orch exec "docker ps" --label "check-docker"

Use --wait to block until the command finishes.`);
      }
      const waitForExec = has(rest, '--wait');
      const label = rest.find(a => a.startsWith('--label='))?.slice('--label='.length);
      const cleanCmd = rest.filter(a => !a.startsWith('--')).join(' ');
      const result = await send('exec-run', { command: cleanCmd || cmd, label }) as { runId: string; pid: number | null; status: string };
      if (waitForExec) {
        // Poll until done
        let status = result.status;
        while (status === 'running') {
          await new Promise(r => setTimeout(r, 1000));
          const s = await send('exec-status', { runId: result.runId }) as { status: string; exitCode: number | null };
          status = s.status;
          if (status !== 'running') {
            console.log(`Exec ${result.runId} ${status} (exit ${s.exitCode ?? '?'})`);
          }
        }
      } else {
        console.log(JSON.stringify(result, null, 2));
      }
      break;
    }

    case 'trigger':
    case 'run': {
      const [id, ...trigRest] = rest;
      const wait = has(trigRest, '--wait');
      const force = has(trigRest, '--force');
      // `force` travels only when asked for, so a daemon that predates it receives the payload it knows.
      const data = await send('trigger-job', { id, wait, ...(force ? { force: true } : {}) }) as {
        status?: string; exitCode?: number; pid?: number; consumed?: boolean; running?: number; maxConcurrency?: number;
      };
      if (forceJson) {
        console.log(JSON.stringify(data));
        break;
      }
      // Not an error and not exit 1: the job did what its maxConcurrency says, and a script chaining
      // on `orch trigger` should not have to treat "already running" as a failure to carry on.
      if (data.status === 'already-running') {
        console.log(`Job "${id}" is already running (${data.running ?? '?'}/${data.maxConcurrency ?? '?'}); `
          + 'nothing was started. Use --force to start another instance.');
        break;
      }
      // Said out loud: running a once job consumes it, so it leaves the job list. Unexplained, a job
      // vanishing right after the user triggered it reads as a bug rather than as the type working.
      const consumedNote = data.consumed === true ? ' Once job: consumed, it will not fire again.' : '';
      console.log((wait
        ? `Job "${id}" finished (exit ${data.exitCode ?? '?'}).`
        : `Job "${id}" triggered (pid ${data.pid ?? '?'}).`) + consumedNote);
      break;
    }

    // `terminate` is an alias: the word `kill` inside a shell command trips process-termination
    // guardrails, which makes the command unusable in some environments. Same handler, so the
    // alias cannot drift from it.
    case 'terminate':
    case 'kill': {
      const [id] = rest;
      if (id === undefined) {
        // Echo the verb that was actually typed: hardcoding `kill` would answer someone using
        // the alias with the very word their shell refuses.
        console.error(`Usage: orch ${cmd} <id>`);
        process.exit(1);
      }
      // kill-job answers killed:false both for an unknown id and for a job that simply is not
      // running, so resolve the job first. Reporting "not running" for a typo would send the
      // user looking for a scheduling problem that does not exist.
      const job = await send('get-job', { id }) as { id: string } | null;
      if (job === null) {
        console.error(`Unknown job "${id}". List them with: orch list`);
        process.exit(1);
      }
      const { killed, count, cancelledRestart } = await send('kill-job', { id }) as { killed: boolean; count?: number; cancelledRestart?: boolean };
      // Not an error: asking for a stopped job to stop is idempotent. Said out loud, though,
      // so a script does not read silence as "killed". `count` is absent from an older daemon.
      const instances = count !== undefined && count > 1 ? ` (${count} instances)` : '';
      // A job that is only waiting to be restarted is not running, but the kill did stop something: say which.
      const waiting = cancelledRestart === true;
      console.log(killed
        ? `Job "${id}" killed${instances}${waiting ? ' (its pending restart was cancelled)' : ''}.`
        : `Job "${id}" is not running${waiting ? '; its pending restart was cancelled' : ''}.`);
      break;
    }

    case 'restart-job': {
      const [id] = rest;
      if (id === undefined || id.startsWith('-')) {
        console.error('Usage: orch restart-job <id> [--json]   (orch restart restarts the daemon, not a job)');
        process.exit(1);
      }
      const r = await send('restart-job', { id }) as {
        wasRunning?: boolean; killed?: number; started?: boolean; pid?: number | null; reason?: string;
      };
      const ended = (r.killed ?? 0) === 1 ? '1 instance' : `${r.killed ?? 0} instances`;
      if (forceJson) {
        console.log(JSON.stringify(r));
      } else if (r.started === true) {
        console.log(r.wasRunning === true
          ? `Job "${id}" restarted (was running, ${ended} ended; new pid ${r.pid ?? '?'}).`
          : `Job "${id}" was not running, started (pid ${r.pid ?? '?'}).`);
      } else {
        console.error(`Job "${id}" was ${r.wasRunning === true ? `ended (${ended}) but ` : ''}not started: ${r.reason ?? 'the daemon gave no reason'}`);
      }
      // A restart that started nothing is not a success, whichever way it is printed.
      if (r.started !== true) {
        process.exit(1);
      }
      break;
    }

    case 'cli': {
      const [subCmd, ...cliRest] = rest;

      if (subCmd === '--help' || subCmd === '-h' || subCmd === 'help') {
        console.log(CLI_GROUP_HELP);
        return;
      }

      if (subCmd === 'self-check') {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { runSelfCheck } = require('./self-check') as typeof import('./self-check.js');
        const quiet = has(rest, '--quiet') || process.env['CLI_SELF_CHECK_QUIET'] === '1';
        await runSelfCheck(quiet);
        return;
      }

      if (subCmd === 'version') {
        warnUnknownArgs(cliRest, [], 'orch cli version');
        await cliVersionCommand('@wadeck-app/orchestrator-cli', version);
        return;
      }

      if (subCmd === 'logs') {
        warnUnknownArgs(cliRest, ['--follow', '-f'], 'orch cli logs');
        await cliLogsCommand(configDir, { follow: has(cliRest, '--follow') || has(cliRest, '-f') });
        return;
      }

      if (subCmd === 'update') {
        // Before anything else: a repo-built bundle is older than every published version, so the updater would
        // run `npm install -g` over the real install. Refused here with the reason; the updater refuses too.
        const updateVersion = deps.cliUpdate?.version ?? version;
        if (!isReleaseVersion(updateVersion)) {
          process.stderr.write(`[fail] ${devBuildRefusalMessage('orch', updateVersion)}
`);
          process.exit(1);
        }
        const updaterPath = deps.cliUpdate?.updaterPath ?? path.join(__dirname, 'orchestrator-updater.cjs');
        const fsCheck = require('node:fs') as typeof import('node:fs');
        if (deps.cliUpdate?.run === undefined && !fsCheck.existsSync(updaterPath)) {
          process.stderr.write(`[fail] Updater not found: ${updaterPath} (dev mode -- no bundle)\n`);
          process.exit(1);
        }
        // The update restarts the daemon: say first what that does to the jobs no supervisor guards.
        await warnJobsDie('orch cli update');
        if (deps.cliUpdate?.run) {
          await deps.cliUpdate.run(updaterPath, cliRest);
        } else {
          await cliUpdateCommand(updaterPath, '@wadeck-app/orchestrator-cli', { rawArgs: cliRest });
        }
        return;
      }

      warnUnknownArgs([String(subCmd ?? '')], ['self-check', 'version', 'logs', 'update', '--help', '-h', 'help'], 'orch cli');
      console.error(`Unknown cli subcommand: "${String(subCmd)}". Run: orch cli --help`);
      process.exit(1);
      break;
    }

    case 'setup-task': {
      const nodePath    = process.execPath.replace(/\//g, '\\');
      const projectDir  = path.join(path.dirname(process.argv[1] ?? __filename), '..').replace(/\//g, '\\');
      const runnerJs    = path.join(projectDir, 'scripts', 'task-runner.js');
      const launcherVbs = path.join(configDir, 'orchestrator-launcher.vbs');
      const task = new WindowsTask({
        taskName:    'Orchestrator-Sync',
        projectDir,
        nodePath,
        runnerJs,
        launcherVbs,
        schedule1:   '08:00',
        schedule2:   '20:00',
        description: `Orchestrator scheduled task. Installed: ${new Date().toISOString().slice(0, 10)}.`,
      });
      try {
        task.install();
        console.log('[ok] Scheduled task installed.');
      } catch (e) {
        console.error(`[fail] Failed to install task: ${(e as Error).message}`);
        process.exit(1);
      }
      break;
    }

    case 'remove-task': {
      const nodePath    = process.execPath.replace(/\//g, '\\');
      const projectDir  = path.join(path.dirname(process.argv[1] ?? __filename), '..').replace(/\//g, '\\');
      const runnerJs    = path.join(projectDir, 'scripts', 'task-runner.js');
      const launcherVbs = path.join(configDir, 'orchestrator-launcher.vbs');
      const task = new WindowsTask({
        taskName:    'Orchestrator-Sync',
        projectDir,
        nodePath,
        runnerJs,
        launcherVbs,
        schedule1:   '08:00',
        schedule2:   '20:00',
        description: '',
      });
      try {
        task.uninstall();
        console.log('[ok] Scheduled task removed.');
      } catch (e) {
        console.error(`[fail] Failed to remove task: ${(e as Error).message}`);
        process.exit(1);
      }
      break;
    }

    case 'server': {
      const sub = rest[0];
      const dashPortFile = path.join(configDir, 'config.dashboard');
      if (sub === 'start') {
        let serverBinary: string;
        try {
          const { findOrchServerBinary } = require('./dashboard-binary.js') as typeof import('./dashboard-binary.js');
          serverBinary = findOrchServerBinary();
        } catch (e) {
          console.error(`Dashboard server not available: ${(e as Error).message}`);
          process.exit(1);
        }
        // Check if already running. A leftover file whose pid is gone must not
        // block the start, so the pid is probed rather than trusted.
        const startState = classifyDashboard(readDashboardFile(dashPortFile));
        if (startState.kind === 'running') {
          console.log(`Dashboard already running at http://localhost:${startState.info.port}`);
          process.exit(0);
        }
        if (startState.kind === 'stale' || startState.kind === 'corrupt') {
          const detail = startState.kind === 'stale'
            ? `pid=${startState.info.pid} is gone`
            : 'file is unreadable';
          console.log(`Removing stale dashboard state (${detail}).`);
          try { fs.unlinkSync(dashPortFile); } catch { /* already gone */ }
        }
        // Auto-start daemon if not running
        const daemonPortFile = path.join(configDir, 'config.port');
        const isDaemonRunning = (): boolean => {
          try {
            if (!fs.existsSync(daemonPortFile)) {
              return false;
            }
            const stat = fs.statSync(daemonPortFile);
            return (Date.now() - stat.mtimeMs) < 60_000;
          } catch { return false; }
        };
        if (!isDaemonRunning()) {
          console.log('Orchestrator daemon is not running -- starting it...');
          startDaemon();
          // Wait up to 10s for daemon port file to appear
          const deadline = Date.now() + 10_000;
          await new Promise<void>((resolve, reject) => {
            const tick = (): void => {
              if (isDaemonRunning()) { resolve(); return; }
              if (Date.now() >= deadline) { reject(new Error('Daemon did not start within 10s')); return; }
              setTimeout(tick, 200);
            };
            tick();
          });
          console.log('Orchestrator daemon started.');
        }
        const { spawn } = require('node:child_process') as typeof import('node:child_process');
        const { createInterface } = require('node:readline') as typeof import('node:readline');
        const child = spawn(process.execPath, [serverBinary, '--config-dir', configDir, '--base-port', '47950'], {
          stdio: ['ignore', 'pipe', 'inherit'],
          detached: true,
          windowsHide: true,
        });
        const rl = createInterface({ input: child.stdout! });
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('Dashboard server did not start within 10s')), 10000);
          rl.on('line', (line: string) => {
            try {
              const msg = JSON.parse(line) as { type: string; port?: number };
              if (msg.type === 'ready') {
                clearTimeout(timer);
                console.log(`Dashboard started at http://localhost:${msg.port}`);
                resolve();
              }
            } catch { /* non-JSON line, ignore */ }
          });
          child.on('error', (err: Error) => { clearTimeout(timer); reject(err); });
        });
        child.unref();
        process.exit(0);
      } else if (sub === 'stop') {
        const stopState = classifyDashboard(readDashboardFile(dashPortFile));
        if (stopState.kind === 'stopped') {
          console.log('Dashboard server is not running.');
          process.exit(0);
        }
        // A dead pid still leaves the file behind. Treat clearing it as success:
        // "stop" previously failed with ESRCH here and left the file in place,
        // which is exactly the state "status" tells the user to fix with "stop".
        if (stopState.kind === 'stale' || stopState.kind === 'corrupt') {
          const detail = stopState.kind === 'stale'
            ? `pid=${stopState.info.pid} was already gone`
            : 'state file was unreadable';
          try { fs.unlinkSync(dashPortFile); } catch { /* already gone */ }
          console.log(`Dashboard server was not running (${detail}); cleaned up stale state.`);
          process.exit(0);
        }
        try {
          process.kill(stopState.info.pid, 'SIGTERM');
          fs.unlinkSync(dashPortFile);
          console.log('Dashboard server stopped.');
        } catch (e) {
          console.error(`Failed to stop dashboard server (pid=${stopState.info.pid}): ${(e as Error).message}`);
          process.exit(1);
        }
        process.exit(0);
      } else if (sub === 'status') {
        const statusState = classifyDashboard(readDashboardFile(dashPortFile));
        if (statusState.kind === 'stopped') {
          console.log('Dashboard server: stopped');
          process.exit(0);
        }
        if (statusState.kind === 'corrupt') {
          console.log(`Dashboard server: unreadable state file (${dashPortFile}) -- run "orch server stop" to clean up`);
          process.exit(0);
        }
        if (statusState.kind === 'stale') {
          console.log(`Dashboard server: stale (pid=${statusState.info.pid} is gone -- run "orch server stop" to clean up)`);
          process.exit(0);
        }
        const info = statusState.info;
        const url = `http://localhost:${info.port}`;
        let alive = false;
        try {
          const res = await fetch(`${url}/api/heartbeat`, { method: 'POST', signal: AbortSignal.timeout(2000) });
          alive = res.status === 204;
        } catch { /* not reachable */ }
        if (alive) {
          console.log(`Dashboard server: running  pid=${info.pid}  url=${url}  started=${info.startedAt}`);
        } else {
          // Distinct from the 'stale' branch above: that pid is gone, this one is
          // alive but not answering the heartbeat.
          console.log(`Dashboard server: unresponsive (pid=${info.pid} is alive but did not answer ${url}/api/heartbeat within 2s -- run "orch server stop" then "orch server start")`);
        }
        process.exit(0);
      } else {
        console.error('Usage: orch server start|stop|status');
        process.exit(1);
      }
    }

    case 'tray': {
      const subCmd = rest[0];
      if (!subCmd || subCmd === 'list' || subCmd === '--help' || subCmd === '-h') {
        const actions = await send('tray-list') as string[];
        process.stdout.write(actions.join('\n') + '\n');
        return;
      }
      const result = await send('tray-action', { id: subCmd }) as { ok: boolean; error?: string };
      if (!result.ok) {
        process.stderr.write(`Error: ${result.error ?? 'unknown error'}\n`);
        process.exitCode = 1;
      } else {
        process.stdout.write(`[ok] tray action "${subCmd}" triggered\n`);
      }
      return;
    }

    // Top-level logs command: reads from the daemon operational log (logs/daemon/)
    // which aggregates daemon events, tray actions, and dashboard messages.
    // Note: cliLogsCommand reads the CLI invocation ndjson -- use our own reader here.
    case 'logs': {
      const followFlags = ['--follow', '-f'];
      const jobFlag = flag(rest, '--job');
      const tailFlag = flag(rest, '--tail');
      const jsonFlag = has(rest, '--json');
      const logsUsage = (problem: string): never => {
        console.error(`${problem}\nUsage: orch logs [--follow] [--job <id>] [--tail <N>] [--json] [--raw]`);
        process.exit(4);
      };
      // Nothing here reads a time range: ignoring --since silently would show everything while the user thinks it is filtered.
      if (has(rest, '--since')) {
        logsUsage('--since is not supported by orch logs (it shows today\'s log). Limit the output with --tail <N>, or read one run with: orch job <jobId> logs [execId]');
      }
      warnUnknownArgs(
        rest,
        [...followFlags, '--job', '--tail', '--json', '--raw'],
        'orch logs',
        new Set(['--job', '--tail']),
      );
      // A value that is itself a flag means the real value is missing.
      const missingValue = (v: string | undefined): boolean => v === undefined || v.startsWith('--');
      if (has(rest, '--job') && missingValue(jobFlag)) {
        logsUsage('--job needs a job id. See the ids with: orch list');
      }
      // The id becomes a folder name under logs/jobs: same rule as registry.add and the logs route (no path in an id).
      if (jobFlag !== undefined && !/^[a-z0-9-]+$/i.test(jobFlag)) {
        logsUsage(`Invalid job id "${jobFlag}": an id has only letters, digits and "-". See the ids with: orch list`);
      }
      if (has(rest, '--tail') && missingValue(tailFlag)) {
        logsUsage('--tail needs a value: the number of last lines to show.');
      }
      if (tailFlag !== undefined && !/^\d+$/.test(tailFlag)) {
        logsUsage(`--tail must be a whole number of 0 or more (the number of last lines to show); got "${tailFlag}".`);
      }
      const follow = has(rest, '--follow') || has(rest, '-f');
      const tailLines = tailFlag !== undefined ? parseInt(tailFlag, 10) : undefined;
      const json = jsonFlag || !process.stdout.isTTY;

      const fsLogs  = require('node:fs') as typeof import('node:fs');
      const today   = new Date().toISOString().slice(0, 10);

      // Job logs are written one file per run -- `<jobId>-<startedAt>.log` (see RunLogger) --
      // not one aggregate file per day, so the day's logs must be assembled from every run file
      // that started today, oldest first.
      const jobLogDir = jobFlag ? path.join(configDir, 'logs', 'jobs', jobFlag) : undefined;
      const todaysJobLogFiles = (): string[] => {
        if (!jobLogDir || !fsLogs.existsSync(jobLogDir)) {
          return [];
        }
        // A run rotated into segments is several files (<id>-<stamp>.log, .log.2, ...): run order first, then segment order.
        return fsLogs.readdirSync(jobLogDir)
          .flatMap(f => {
            const seg = f.startsWith(`${jobFlag}-${today}`) ? parseSegmentName(jobFlag!, f) : null;
            return seg === null ? [] : [{ f, ...seg }];
          })
          .sort((a, b) => (a.stamp < b.stamp ? -1 : a.stamp > b.stamp ? 1 : a.n - b.n))
          .map(({ f }) => path.join(jobLogDir, f));
      };

      const logFile = jobFlag
        ? undefined
        : path.join(configDir, 'logs', 'daemon', `daemon-${today}.log`);

      // The one place every line of this view goes through (snapshot and tail): escape sequences are stripped
      // unless --raw. Job output is stripped when written, but older logs and programs that ignore NO_COLOR have some.
      const raw = has(rest, '--raw');
      const printLines = (rawLines: string[]): void => {
        const lines = raw ? rawLines : rawLines.map(stripAnsi);
        if (json) {
          for (const line of lines) {
            // Anchored: a bracket in the middle of a message is not a stamp.
            const match = line.match(/^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\] (.*)$/);
            if (match) {
              console.log(JSON.stringify({ timestamp: match[1], message: match[2] }));
            } else {
              console.log(JSON.stringify({ message: line }));
            }
          }
        } else {
          process.stdout.write(lines.join('\n'));
          if (lines.length > 0) {
            process.stdout.write('\n');
          }
        }
      };

      const parseLines = (content: string): string[] => {
        let lines = content.split('\n').filter(l => l);
        if (tailLines !== undefined) {
          lines = lines.slice(Math.max(0, lines.length - tailLines));
        }
        return lines;
      };

      // fs.watch throws ENOENT on a folder that does not exist: say why there is nothing to follow instead.
      if (jobFlag && follow && !fsLogs.existsSync(jobLogDir!)) {
        console.error(`Cannot follow job "${jobFlag}": it has no log folder (${jobLogDir}), so it has never run or the id is wrong. See the ids with: orch list`);
        process.exit(1);
      }

      let offset = 0;
      let watchedFile: string | undefined;
      if (jobFlag) {
        const files = todaysJobLogFiles();
        if (files.length === 0) {
          const msg = `No logs for job "${jobFlag}" today`;
          process.stdout.write(json ? JSON.stringify({ message: msg }) + '\n' : msg + '\n');
        } else {
          const content = files.map(f => fsLogs.readFileSync(f, 'utf8')).join('');
          printLines(parseLines(content));
          watchedFile = files[files.length - 1];
          offset = fsLogs.statSync(watchedFile).size;
        }
      } else {
        if (!fsLogs.existsSync(logFile!)) {
          const msg = `No daemon logs for today`;
          process.stdout.write(json ? JSON.stringify({ message: msg }) + '\n' : msg + '\n');
        } else {
          const content = fsLogs.readFileSync(logFile!, 'utf8');
          printLines(parseLines(content));
          offset = Buffer.byteLength(content, 'utf8');
        }
        watchedFile = logFile;
      }

      if (!follow) {
        return;
      }

      const tailFile = (file: string): void => {
        const size = fsLogs.statSync(file).size;
        if (size <= offset) {
          return;
        }
        const buf = Buffer.alloc(size - offset);
        const fd  = fsLogs.openSync(file, 'r');
        fsLogs.readSync(fd, buf, 0, buf.length, offset);
        fsLogs.closeSync(fd);
        offset = size;
        printLines(buf.toString('utf8').split('\n').filter(l => l));
      };

      // Polled for both views, never fs.watch / fs.watchFile: a watcher is armed some time after the call returns
      // (fs.watchFile takes its baseline stat late; on macOS a directory watch goes through FSEvents, which is
      // asynchronous and coalesces), so a line written between the snapshot and the moment it is live was never
      // reported, and the report of a later one depended on the platform. A poll reads the file's size, which is
      // what is actually wanted, and is paced by an injectable clock.
      const time   = deps.logs?.time ?? systemTime;
      const pollMs = deps.logs?.pollMs ?? 250;
      const pollOnce = (): void => {
        if (jobFlag) {
          // Each run writes a brand-new file (no single file to grow), so follow looks at the job's folder
          // and switches to the newest run (the name carries the start stamp, so the name order is the run order).
          const files = todaysJobLogFiles();
          const latest = files[files.length - 1];
          if (!latest) {
            return;
          }
          if (latest !== watchedFile) {
            // Lines the previous run wrote since the last poll are read before leaving it.
            if (watchedFile !== undefined && fsLogs.existsSync(watchedFile)) {
              tailFile(watchedFile);
            }
            watchedFile = latest;
            offset = 0;
          }
        }
        if (watchedFile !== undefined && fsLogs.existsSync(watchedFile)) {
          tailFile(watchedFile);
        }
      };
      await new Promise<void>((resolve) => {
        let timer: { cancel(): void };
        const onSigint = (): void => {
          timer.cancel();
          process.off('SIGINT', onSigint);
          resolve();
        };
        const arm = (): void => {
          timer = time.after(pollMs, () => {
            pollOnce();
            arm();
          });
        };
        arm();
        process.on('SIGINT', onSigint);
      });
      return;
    }

    // `orch progress replay <jobId>`: how well each progress strategy would have estimated the job's past runs.
    // Reads registry.json, state.json and the run logs of the config dir; no daemon needed.
    case 'progress': {
      const [sub, ...subRest] = rest;
      const usage = (problem: string): never => {
        console.error(`${problem}\n${PROGRESS_REPLAY_USAGE}`);
        process.exit(4);
      };
      if (sub === undefined) {
        usage('Missing sub-command. Available: replay.');
      }
      if (sub !== 'replay') {
        usage(`Unknown sub-command "${sub}" for orch progress. Available: replay.`);
      }
      const parsed = parseReplayArgs(subRest, forceJson);
      if (!parsed.ok) {
        console.error(parsed.error);
        process.exit(4);
      }
      const code = runProgressReplay(parsed.args, configDir, (t) => console.log(t), (t) => console.error(t));
      if (code !== 0) {
        process.exit(code);
      }
      return;
    }

    // The old name of `orch job <jobId> logs`, kept one release so the rename is explained instead of "Unknown command".
    case 'job-logs': {
      console.error('orch job-logs was renamed: use orch job <jobId> logs [execId] [-f]');
      process.exit(4);
    }

    // `orch job <jobId> <sub-command>`: the sub-commands of one job. Only `logs` exists.
    case 'job': {
      const [jobId, sub, ...subRest] = rest;
      const JOB_SUBCOMMANDS = ['logs'];
      // Not found is either a null answer or an error saying so; any other failure (daemon down) is not hidden.
      const jobExists = async (id: string): Promise<boolean> => {
        try {
          return (await send('get-job', { id })) != null;
        } catch (e) {
          if (/not found/i.test(getErrorMessage(e))) {
            return false;
          }
          throw e;
        }
      };
      const usage = (problem: string): never => {
        console.error(`${problem}\n\n${JOB_HELP}`);
        process.exit(4);
      };
      if (jobId === undefined || jobId.startsWith('-')) {
        usage('Missing job id. See the ids with: orch list');
      }
      // `orch job logs -f`: the sub-command typed where the job id goes. Only said when no job has that id,
      // so a job really called "logs" keeps working.
      if (JOB_SUBCOMMANDS.includes(jobId!) && !(await jobExists(jobId!))) {
        console.error(`No job has the id "${jobId}". Did you mean: orch job <jobId> ${jobId} ...? The job id comes first.\n\n${JOB_HELP}`);
        process.exit(4);
      }
      if (sub === undefined) {
        usage(`Missing sub-command for job "${jobId}".`);
      }
      if (sub !== 'logs') {
        usage(`Unknown sub-command "${sub}" for job "${jobId}". Available: logs.`);
      }
      const parsed = parseJobLogsArgs(jobId!, subRest, forceJson);
      if (!parsed.ok) {
        console.error(parsed.error);
        process.exit(4);
      }
      const code = await runJobLogs(parsed.options, { send, configDir, ...deps.jobLogs });
      if (code !== 0) {
        process.exit(code);
      }
      return;
    }

    default: {
      console.error(`Unknown command: "${String(cmd)}". Run: orch --help`);
      process.exit(1);
    }
  }
}

// ---------------------------------------------------------------------------
// Entry point (when invoked as a binary)
// ---------------------------------------------------------------------------

/**
 * Waits for the daemon to be genuinely reachable, not merely for its port file to exist.
 *
 * An unclean shutdown (SIGKILL, power loss) leaves a stale config.port behind, so testing
 * existence alone answered "ready" on the first tick while nothing was running: `orch start`
 * then printed "Daemon started." and exited 0 having started nothing. Reads the recorded pid
 * and probes it, the same way the `--pid` branch does.
 */
async function waitForDaemonAlive(configDir: string, timeoutMs: number): Promise<boolean> {
  const fsMod = require('node:fs') as typeof import('node:fs');
  const portFile = path.join(configDir, 'config.port');
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const { pid } = JSON.parse(fsMod.readFileSync(portFile, 'utf8')) as { pid: number };
      process.kill(pid, 0);
      return true;
    } catch { /* file absent, malformed, or the pid is gone */ }
    if (Date.now() >= deadline) {
      return false;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
}

export async function main(): Promise<void> {
  const fs = require('node:fs') as typeof import('node:fs');
  const { createDaemonClient } = require('@wadeck-app/singleton-daemon-kit') as typeof import('@wadeck-app/singleton-daemon-kit');
  const { spawn } = require('node:child_process') as typeof import('node:child_process');

  const configDir = DEFAULT_CONFIG_DIR;

  // Type-only stand-in for the SDK client's `commands` option. It exists to make send()'s
  // generics infer the right result types; it must NOT be a real command map bound to a real
  // Scheduler, because the SDK calls these as a *local fallback* whenever the daemon is
  // unreachable (readPortFile fails or the pid is dead) -- which, for a CLI that always wants
  // to error/auto-start instead, is every cold-start race by construction. A real map here
  // used to be bound to `null as any` for the Scheduler argument "for type inference only,
  // never executed" -- false: the very first `orch trigger --wait` issued while the daemon
  // was still starting hit this path and crashed on `null.trigger()` with no daemon-side
  // trace at all, since the request never left the process.
  // violations-suppress: ts/no-unsafe-type-cast empty object cast to the command map's type, for inference only -- see comment above for why it must stay empty at runtime
  const commands = {} as import('./types.js').OrchestratorCommands;

  const client = createDaemonClient({ configDir, commands });

  function startDaemon(): void {
    const { launcherToRun, findDaemonEntry, platformPackage } =
      require('./platform-binary.js') as typeof import('./platform-binary.js');

    const daemonPath = findDaemonEntry();
    if (!daemonPath) {
      console.error(`Cannot start: no daemon bundle found next to ${__dirname}.`);
      console.error('Re-install with: npm install -g @wadeck-app/orchestrator-cli');
      process.exit(1);
    }

    // The Go launcher is required, with no degraded mode behind it. It supervises the daemon,
    // which is what makes auto-restart after an update work, and on Windows it is also the
    // only thing that detaches cleanly: the shell tracks every descendant of an MSYS2/Git Bash
    // spawn() in its process group, so it waits for them even with detached+unref().  // violations-suppress: cli/no-spawn-without-windows-hide prose, not a call
    // Starting the daemon without it used to be a silent fallback through wscript.exe, which
    // produced a daemon that looked fine and never restarted itself after an update.
    const launcherPath = launcherToRun(configDir);
    if (!launcherPath) {
      const pkg = platformPackage();
      console.error('Cannot start the daemon: the Go launcher binary was not found.');
      console.error('It supervises the daemon and auto-restarts it after an update, so there is');
      console.error('no degraded mode to fall back to.');
      console.error(pkg
        ? `  expected in ${pkg}, or in launcher-go/dist for a monorepo checkout`
        : `  unsupported platform: ${process.platform}-${process.arch}`);
      console.error('  installed:  npm install -g @wadeck-app/orchestrator-cli');
      console.error('  checkout:   npm run build-launcher --workspace=packages/orchestrator-cli');
      process.exit(1);
    }

    // Hand the launcher an absolute bundle path: its baked nodeScript is resolved relative to
    // its own directory, which breaks as soon as npm nests the platform package instead of
    // hoisting it next to the main package.
    const child = spawn(launcherPath, [configDir], {
      stdio: 'ignore',
      detached: true,
      windowsHide: true,
      env: { ...process.env, LAUNCHER_BUNDLE_OVERRIDE: daemonPath, ORCH_CONFIG_DIR: configDir },
    });
    // Without this, a launcher that cannot be executed (wrong arch, missing exec bit,
    // corrupt binary) surfaces as an unhandled 'error' event and a raw ENOEXEC/EACCES stack
    // printed after we already said "starting...".
    child.on('error', (err) => {
      console.error(`Failed to execute the Go launcher at ${launcherPath}: ${getErrorMessage(err)}`);
      console.error('Re-install with: npm install -g @wadeck-app/orchestrator-cli');
      process.exit(1);
    });
    child.unref();
    console.log('Orchestrator starting...');
  }

  // Wait up to timeoutMs for the daemon port file to appear (async-friendly polling).
  const waitForDaemon = (timeoutMs: number): Promise<boolean> =>
    waitForDaemonAlive(configDir, timeoutMs);

  // Error codes that mean "the connection to the daemon failed", regardless of what Node's
  // human-readable message happens to say. Checked via `err.code` rather than
  // `msg.includes(...)`, because a connection the server reset mid-response surfaces as
  // `Error: socket hang up` with `code: 'ECONNRESET'` -- the message itself never contains
  // the string "ECONNRESET", so a plain substring check on the message misses it and the
  // auto-start retry below never kicks in; the user sees the raw "socket hang up" instead.

  // ssh-agent pattern (D25): auto-start daemon on first command that needs it,
  // wait up to 3 s, retry once. --version / --pid bypass this via early returns in runCli.
  let _autoStarted = false;
  function send(command: string, payload?: unknown, options?: import('./types.js').SendOptions): Promise<unknown> {
    // A `wait: true` payload (trigger-job, exec) holds the HTTP connection open with zero
    // bytes flowing until the job finishes, which can legitimately take far longer than the
    // client's default 5s idle timeout. Disable it for these instead of guessing a bigger
    // fixed number -- the job's own timeout/kill logic is what should end it, not the transport.
    const isWaitPayload = typeof payload === 'object' && payload !== null && (payload as { wait?: unknown }).wait === true;
    const doSend = (): Promise<unknown> => {
      if (command === 'version') {
        return client.version() as Promise<unknown>;
      }
      const c = client as { send(cmd: string, p?: unknown, opts?: { timeoutMs?: number }): Promise<unknown> };
      // restart-job answers after the old instance is really gone (up to 15 s), well past the 5 s idle default.
      return c.send(command, payload, isWaitPayload ? { timeoutMs: 0 } : command === 'restart-job' ? { timeoutMs: 30_000 } : undefined);
    };

    return doSend().catch(async (e: unknown) => {
      const msg = getErrorMessage(e);
      // The caller wants to know whether the daemon is there, not to have it there.
      if (options?.autoStart === false) {
        throw e;
      }
      const isDaemonDown = isDaemonDownError(e);
      if (isDaemonDown && !_autoStarted) {
        _autoStarted = true;
        startDaemon();
        const ready = await waitForDaemon(3000);
        if (!ready) {
          errorExit(`Orchestrator daemon could not be started.

Try manually:
  orch start --verbose

Check logs:
  orch logs --follow`, 2);
        }
        // Retry once after auto-start
        return doSend().catch((e2: unknown) => {
          const err2Msg = getErrorMessage(e2);
          const code = (e2 as NodeJS.ErrnoException | undefined)?.code;
          errorExit(`Daemon connection failed after auto-start: ${err2Msg}${code ? ` [${code}]` : ''}

The daemon may still have started the command in the background -- check:
  orch status
  orch logs --follow`, 1);
        });
      }
      if (msg.includes('not found') || msg.includes('Not found')) {
        errorExit(`${msg}

List available jobs:
  orch list`, 3);
      }
      errorExit(msg, 1);
    });
  }

  // Read and display any pending update notice from the background updater.
  const { UpdateManager: CliUpdateManager } = await import('@wadeck-app/shared-cli');
  const cliUpdateManager = new CliUpdateManager('@wadeck-app/orchestrator-cli', configDir);
  const cliUpdateState = cliUpdateManager.readAndClearState();
  // 'applying' is not cleared by the read: it is the updater's journal, repaired by its next run.
  const cliUpdateNotice = updateNotice(cliUpdateState);
  if (cliUpdateNotice) {
    process.stderr.write(`[orch] ${cliUpdateNotice.text}
`);
  }

  await runCli(process.argv.slice(2), { send, startDaemon, configDir });
}

if (require.main === module) {
  main().catch((e: unknown) => { console.error(getErrorMessage(e)); process.exit(1); });
}
