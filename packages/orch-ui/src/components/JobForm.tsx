import React, { useState } from 'react';
import { X, Plus, Wand2 } from 'lucide-react';
import { getErrorMessage, type Job, type JobFormPayload, type MissedFiring, type LivenessConfig, type LivenessStrategy, type UnsettableJobField } from '../types.js';
import { describeCron } from '../cron-describe.js';
import { ButtonAction, ButtonCancel, CronBuilder, FieldDateRange, FieldNumber, FieldSelect, FieldText, IconButton, type DateRange, type FieldSelectOption } from '@wadeck-app/dsl-ui';

// @formatter:off
const CHIP_BTN_CLS   = 'text-xs px-2 py-0.5 rounded border border-border text-muted hover:bg-muted-bg hover:text-content transition-colors';
const MONO_INPUT     = 'w-32 rounded border border-border px-2 py-1 text-sm bg-surface text-content font-mono';
const FULL_INPUT    = 'w-full rounded border border-border px-3 py-1.5 text-sm bg-surface text-content focus:outline-none focus:ring-2 focus:ring-primary';

// Option lists for the selects. Hoisted out of the render so each is declared once, and so the
// four selects read as data rather than as four hand-rolled label-plus-select blocks - which is
// what they were, at py-1.5 against the design system's py-2.
// Typed, not `as const`: FieldSelect takes a mutable FieldSelectOption[], and a readonly
// tuple cannot be assigned to it.
const TYPE_OPTIONS: FieldSelectOption[] = [
  { value: 'cron',    label: 'Cron' },
  { value: 'startup', label: 'Startup' },
  { value: 'once',    label: 'Once' },
];

const TRIGGER_MODE_OPTIONS: FieldSelectOption[] = [
  { value: 'fire-and-forget', label: 'Fire and forget' },
  { value: 'wait',            label: 'Wait for completion' },
];

const MISSED_FIRING_OPTIONS: FieldSelectOption[] = [
  { value: 'skip',     label: 'Skip (default)' },
  { value: 'catch-up', label: 'Catch-up (run immediately after restart)' },
];

const LIVENESS_OPTIONS: FieldSelectOption[] = [
  { value: 'none',     label: 'None' },
  { value: 'portFile', label: 'Port file' },
  { value: 'pidFile',  label: 'PID file' },
  { value: 'command',  label: 'Command' },
];

/*
 * "Active for three weeks" as one click. Days rather than a duration string, because the form deals
 * in dates and the daemon takes timestamps - parsing "3w" here would only reintroduce a unit to get
 * wrong.
 */
const ACTIVE_PERIOD_PRESETS = [
  { label: '1 week',   days: 7   },
  { label: '2 weeks',  days: 14  },
  { label: '3 weeks',  days: 21  },
  { label: '1 month',  days: 30  },
  { label: '3 months', days: 90  },
] as const;

const CRON_TEMPLATES = [
  { label: 'Every 5 min',   value: '*/5 * * * *'  },
  { label: 'Every hour',    value: '0 * * * *'    },
  { label: 'Daily midnight',value: '0 0 * * *'    },
  { label: 'Weekdays 9am',  value: '0 9 * * 1-5'  },
  { label: '1st of month',  value: '0 9 1 * *'    },
] as const;
// @formatter:on

type JobType = Job['type'];
type TriggerMode = Job['triggerMode'];

export interface JobFormProps {
  initial?: Partial<Job>;
  onSubmit: (data: JobFormPayload) => Promise<void>;
  onCancel: () => void;
  /**
   * A save the form cannot see, still in flight.
   *
   * Under the DSL the brain owns the HTTP call, so the `onSubmit` this form awaits resolves as soon
   * as the event is published - long before the request finishes. The internal `loading` therefore
   * flashes off immediately and the Save button goes back to looking idle mid-save, which is half
   * of why saving appeared to do nothing. This carries the brain's own `$pending`.
   */
  busy?: boolean;
}

interface FormErrors {
  id?: string;
  label?: string;
  command?: string;
  schedule?: string;
  onceDelay?: string;
  activePeriod?: string;
}

// registry.ts validateJob() enforces this. Checked here too, so the field that is wrong gets named
// instead of the daemon answering 500 into a channel the page does not display.
const MAX_ID_LENGTH = 128;

/**
 * Adapts dsl-ui's FieldNumber, whose onChange carries `string | number` so the field can
 * report an emptied input, to a numeric state setter. Empty becomes 0 rather than NaN,
 * which would otherwise reach the daemon as a null timeout.
 */
function numericSetter(set: (n: number) => void): (v: string | number) => void {
  return v => {
    const n = typeof v === 'number' ? v : Number(v);
    set(Number.isFinite(n) ? n : 0);
  };
}

/**
 * Whether the job already stored something in this field. Same rule as registry.ts isEmptyValue(),
 * so "was configured" means the same thing on both sides: 0 and false are values, an empty string
 * or an empty collection is not.
 */
function wasConfigured(value: unknown): boolean {
  if (value === null || value === undefined || value === '') return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

/**
 * A period of `days`, measured from `from` when one is already chosen and from today otherwise.
 *
 * Measuring from the existing start is what makes "active from 1 March" + "3 weeks" mean the three
 * weeks after 1 March rather than the three weeks after today.
 */
function periodFromNow(days: number, from: Date | null): DateRange {
  const start = from ?? new Date();
  const end = new Date(start.getTime() + days * 86_400_000);
  return { from: start, to: end };
}

/** The window as the daemon wants it: ISO strings, or absent. */
function periodToPayload(period: DateRange): { activeFrom?: string; activeUntil?: string } {
  return {
    ...(period.from ? { activeFrom: period.from.toISOString() } : {}),
    ...(period.to ? { activeUntil: period.to.toISOString() } : {}),
  };
}

function parseCron(expr: string): string | null {
  if (!expr.trim()) return null;
  const parts = expr.trim().split(/\s+/);
  if (parts.length < 5 || parts.length > 6) return 'Must have 5 or 6 parts (min hour dom mon dow [year])';
  return null;
}

/**
 * @registryCategory composite
 * @registryTags form job edit create
 */
export function JobForm({ initial, onSubmit, onCancel, busy }: JobFormProps): React.ReactElement {
  // The id is the registry key. It is set once, at creation: the edit route addresses the job by id
  // in the URL and ignores the body, so an editable field here would only ever mislead.
  const isCreating = initial?.id === undefined;
  const [jobId, setJobId] = useState('');
  const [label, setLabel] = useState(initial?.label ?? '');
  const [type, setType] = useState<JobType>(initial?.type ?? 'cron');
  const [command, setCommand] = useState(initial?.command ?? '');
  const [cwd, setCwd] = useState(initial?.cwd ?? '');
  const [triggerMode, setTriggerMode] = useState<TriggerMode>(initial?.triggerMode ?? 'fire-and-forget');
  const [schedule, setSchedule] = useState(initial?.schedule ?? '');
  const [delaySeconds, setDelaySeconds] = useState(initial?.delaySeconds ?? 0);
  // Separate from `delaySeconds`, which belongs to `startup` and may legitimately be 0. A `once` job
  // must carry a POSITIVE delayMs or the daemon refuses it, so this one starts at a valid value
  // rather than being coerced up at submit time behind the user's back.
  const [onceDelaySeconds, setOnceDelaySeconds] = useState(
    initial?.delayMs !== undefined && initial.delayMs > 0 ? Math.round(initial.delayMs / 1000) : 1
  );
  const [missedFiring, setMissedFiring] = useState<MissedFiring>(initial?.missedFiring ?? 'skip');
  const [timeoutSeconds, setTimeoutSeconds] = useState<number>(initial?.timeoutSeconds ?? 300);
  // Seeded from the job so editing shows the window it already has, rather than an empty field that
  // would clear it on save.
  const [activePeriod, setActivePeriod] = useState<DateRange>({
    from: initial?.activeFrom ? new Date(initial.activeFrom) : null,
    to: initial?.activeUntil ? new Date(initial.activeUntil) : null,
  });
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [showBuilder, setShowBuilder] = useState(false);
  const [loading, setLoading] = useState(false);
  const [errors, setErrors] = useState<FormErrors>();
  // Kept apart from `errors`, which is per-field validation. A rejected save is about the request,
  // so it belongs to the form as a whole and must survive until the next attempt.
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Liveness
  const initLiveness = initial?.liveness;
  const [livenessStrategy, setLivenessStrategy] = useState<LivenessStrategy>(initLiveness?.strategy ?? 'none');
  const [livenessPort, setLivenessPort] = useState(initLiveness?.portFile ?? '');
  const [livenessCommand, setLivenessCommand] = useState(initLiveness?.command ?? '');

  // onExitCode: array of [code, message] pairs for UI editing
  const initExitCodes = Object.entries(initial?.onExitCode ?? {}).map(([k, v]) => ({ code: k, msg: v }));
  const [exitCodePairs, setExitCodePairs] = useState<{ code: string; msg: string }[]>(
    initExitCodes.length > 0 ? initExitCodes : []
  );

  // env vars: key=value pairs
  const initEnv = Object.entries(initial?.env ?? {}).map(([k, v]) => ({ key: k, val: v }));
  const [envPairs, setEnvPairs] = useState<{ key: string; val: string }[]>(
    initEnv.length > 0 ? initEnv : []
  );

  // tags
  const [tagInput, setTagInput] = useState((initial?.tags ?? []).join(', '));

  // new v3 fields
  const [dependsOn, setDependsOn] = useState(initial?.dependsOn ?? '');
  const [slaWindowMinutes, setSlaWindowMinutes] = useState<number>(initial?.slaWindowMinutes ?? 0);
  const [dryRunSupported, setDryRunSupported] = useState(initial?.dryRunSupported ?? false);

  const validate = (): boolean => {
    const e: FormErrors = {};
    if (isCreating) {
      if (!jobId.trim()) {
        e.id = 'Id is required';
      } else if (jobId.trim().length > MAX_ID_LENGTH) {
        e.id = `Id must be ${MAX_ID_LENGTH} characters or fewer`;
      }
    }
    if (type === 'once' && !(onceDelaySeconds >= 1)) {
      e.onceDelay = 'Delay must be at least 1 second';
    }
    // The daemon refuses a window that can never fire. Named here so the message points at the field
    // rather than arriving as a 500 from the registry.
    if (type === 'cron' && activePeriod.from && activePeriod.to
        && activePeriod.to.getTime() <= activePeriod.from.getTime()) {
      e.activePeriod = 'The end of the period must be after its start';
    }
    if (!label.trim()) e.label = 'Label is required';
    if (!command.trim()) e.command = 'Command is required';
    if (type === 'cron') {
      const cronErr = parseCron(schedule);
      if (cronErr) e.schedule = cronErr;
      else if (!schedule.trim()) e.schedule = 'Schedule is required for cron jobs';
    }
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!validate()) return;
    setLoading(true);
    try {
      const data: JobFormPayload = { label: label.trim(), type, command: command.trim(), triggerMode, missedFiring };
      // Only on create: the edit route reads the id from the URL, so sending it would let a body and
      // a path disagree about which job is being written.
      if (isCreating) {
        data.id = jobId.trim();
      }

      /*
       * An edit is a PATCH, so leaving a key out means "keep what you have". Emptying a field and
       * saving therefore used to do nothing at all: no error, and the old value still in place.
       * Naming the field here is the only way to say "clear it".
       *
       * Called from the branch where the field is NOT going into the body, so a field can never end
       * up in both - registry.edit() rejects that outright. Nothing to clear when creating, and
       * required fields never reach this: validate() stops the submit first.
       */
      const unset: UnsettableJobField[] = [];
      const clearIfWasConfigured = (field: UnsettableJobField, previous: unknown): void => {
        if (!isCreating && wasConfigured(previous)) unset.push(field);
      };

      if (cwd.trim()) data.cwd = cwd.trim();
      else clearIfWasConfigured('cwd', initial?.cwd);
      if (type === 'cron' && schedule.trim()) data.schedule = schedule.trim();
      if (type === 'cron') {
        const period = periodToPayload(activePeriod);
        Object.assign(data, period);
        // An edit is a PATCH, so an omitted key means "leave it alone". Clearing the period has to
        // travel as an unset or the job keeps the window the user just removed.
        if (period.activeFrom === undefined) {
          clearIfWasConfigured('activeFrom', initial?.activeFrom);
        }
        if (period.activeUntil === undefined) {
          clearIfWasConfigured('activeUntil', initial?.activeUntil);
        }
      } else {
        // Switching away from cron takes the field off the form, so the window must go with it rather
        // than linger on a job whose type has no use for it.
        clearIfWasConfigured('activeFrom', initial?.activeFrom);
        clearIfWasConfigured('activeUntil', initial?.activeUntil);
      }
      if (type === 'startup') data.delaySeconds = delaySeconds;
      // Switching the type takes this field off the form. Without this the patch keeps a delay that
      // now belongs to no type, and `orch show` still reports it.
      else clearIfWasConfigured('delaySeconds', initial?.delaySeconds);
      // Required by the daemon for this type, and never sent before, so every `once` job created
      // from the dashboard was rejected.
      if (type === 'once') {
        data.delayMs = onceDelaySeconds * 1000;
      }

      // Liveness
      if (livenessStrategy !== 'none') {
        const liveness: LivenessConfig = { strategy: livenessStrategy };
        if (livenessStrategy === 'portFile' && livenessPort.trim()) liveness.portFile = livenessPort.trim();
        if (livenessStrategy === 'command' && livenessCommand.trim()) liveness.command = livenessCommand.trim();
        data.liveness = liveness;
      } else {
        data.liveness = null;
      }

      // timeout. 0 is a value to the daemon, not an absence, so zeroing the box has to unset the
      // field rather than store a job that times out immediately.
      if (timeoutSeconds > 0) data.timeoutSeconds = timeoutSeconds;
      else clearIfWasConfigured('timeoutSeconds', initial?.timeoutSeconds);

      // onExitCode
      const validPairs = exitCodePairs.filter(p => p.code.trim() && p.msg.trim());
      if (validPairs.length > 0) {
        data.onExitCode = Object.fromEntries(validPairs.map(p => [p.code.trim(), p.msg.trim()]));
      } else {
        clearIfWasConfigured('onExitCode', initial?.onExitCode);
      }

      // env vars
      const validEnv = envPairs.filter(p => p.key.trim());
      if (validEnv.length > 0) {
        data.env = Object.fromEntries(validEnv.map(p => [p.key.trim(), p.val]));
      } else {
        clearIfWasConfigured('env', initial?.env);
      }

      // tags
      const tags = tagInput.split(',').map(t => t.trim()).filter(Boolean);
      if (tags.length > 0) data.tags = tags;
      else clearIfWasConfigured('tags', initial?.tags);

      // v3 fields. Emptying these was a silent no-op until the daemon accepted them in `unset`.
      if (dependsOn.trim()) data.dependsOn = dependsOn.trim();
      else clearIfWasConfigured('dependsOn', initial?.dependsOn);
      // These two carry their "off" state in a value the daemon keeps -- 0 and false are values, not
      // emptiness -- so the previous state is narrowed to what the form treats as configured.
      // Otherwise a job saved twice with the SLA already at 0 would send a pointless unset each time.
      if (slaWindowMinutes > 0) data.slaWindowMinutes = slaWindowMinutes;
      else clearIfWasConfigured('slaWindowMinutes', initial?.slaWindowMinutes || undefined);
      // Unticking the box has to remove the flag; omitting it would leave dry-run enabled.
      if (dryRunSupported) data.dryRunSupported = true;
      else clearIfWasConfigured('dryRunSupported', initial?.dryRunSupported || undefined);

      // Only when there is something to clear: an empty array would still reach the daemon and read
      // as an edit that clears nothing.
      if (unset.length > 0) data.unset = unset;

      setSubmitError(null);
      await onSubmit(data);
    } catch (err) {
      // For a caller that awaits the save itself. It is NOT what fixed the reported "Save does
      // nothing": under the DSL the brain owns the HTTP call, so this onSubmit never rejects and
      // this branch never runs. That failure is swallowed in dsl-renderer's useBrains, where the
      // only call site of runBrain ends in `.catch(console.error)` with no channel back to the page.
      // Kept because a direct consumer passing a rejecting onSubmit deserves to see why.
      setSubmitError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  // Shared with the dashboard rather than reimplemented. This version covered two shapes and
  // rendered a list of hours as `Daily at 10,19:00`, which is not a time.
  const cronHint = type === 'cron' && schedule.trim() && !errors?.schedule
    ? describeCron(schedule)
    : null;

  const labelClass = 'block text-sm font-medium text-content mb-1';

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {/* Create only. It is the registry key, the URL segment and what `orch trigger <id>` takes,
          so it is the one field the daemon cannot invent. */}
      {isCreating && (
        <FieldText
          label="Id"
          value={jobId}
          onChange={setJobId}
          placeholder="my-job"
          error={errors?.id}
          required
        />
      )}

      <FieldText label="Label" value={label} onChange={setLabel} placeholder="My job" error={errors?.label} required />

      <FieldText label="Tags (comma-separated)" value={tagInput} onChange={setTagInput} placeholder="scraper, daily, production" />

      <FieldSelect
        label="Type"
        value={type}
        onChange={v => setType(v as JobType)}
        options={TYPE_OPTIONS}
      />

      <FieldText label="Command" value={command} onChange={setCommand} placeholder="node script.js" error={errors?.command} required />
      <FieldText label="Working directory" value={cwd} onChange={setCwd} placeholder="/optional/path" />

      <FieldSelect
        label="Trigger mode"
        value={triggerMode}
        onChange={v => setTriggerMode(v as TriggerMode)}
        options={TRIGGER_MODE_OPTIONS}
      />

      {type === 'cron' && (
        <div>
          <div className="flex items-end gap-2">
            <div className="flex-1">
              <FieldText label="Schedule (cron expression)" value={schedule} onChange={setSchedule} placeholder="*/5 * * * *" error={errors?.schedule} />
            </div>
            {/* The row is items-end, so the button's bottom lines up with the input's. The
                hand-rolled version was a p-2 box nudged by mb-1, which left it 6px shorter
                than the field and off by 2px at the top and 4px at the bottom. */}
            <IconButton
              type="button"
              onClick={() => setShowBuilder(v => !v)}
              aria-label="Open cron builder"
              icon={<Wand2 size={14} />}
              size="icon-field"
              variant="secondary"
            />
          </div>
          {cronHint && <p className="mt-1 text-xs text-primary">{cronHint}</p>}
          {showBuilder && (
            <CronBuilder value={schedule} onChange={v => { setSchedule(v); setShowBuilder(false); }} onClose={() => setShowBuilder(false)} />
          )}
          <div className="flex flex-wrap gap-1 mt-2">
            {CRON_TEMPLATES.map(t => (
              // violations-suppress: react/no-raw-button cron template chip - Button component doesn't fit compact chip pattern
              <button key={t.value} type="button"
                onClick={() => setSchedule(t.value)}
                className={CHIP_BTN_CLS}>
                {t.label}
              </button>
            ))}
          </div>

          {/* The active period. dsl-ui's own range field rather than two date inputs: a period IS a
              range, and FieldDateRange already exists for exactly this.
              The presets are what "active for three weeks" looks like as one click - the same shape as
              the cron templates above, because it is the same kind of choice. */}
          <div className="mt-4">
            <FieldDateRange
              label="Active period (optional)"
              description="Leave empty to run indefinitely. A start in the future is allowed - the job waits. At the end the job is disabled, not deleted."
              value={activePeriod}
              onChange={setActivePeriod}
            />
            {errors?.activePeriod && <p className="mt-1 text-xs text-danger">{errors.activePeriod}</p>}
            <div className="flex flex-wrap gap-1 mt-2">
              {ACTIVE_PERIOD_PRESETS.map(p => (
                // violations-suppress: react/no-raw-button period preset chip - same compact chip pattern as the cron templates above
                <button key={p.label} type="button"
                  onClick={() => setActivePeriod(periodFromNow(p.days, activePeriod.from))}
                  className={CHIP_BTN_CLS}>
                  {p.label}
                </button>
              ))}
              {(activePeriod.from !== null || activePeriod.to !== null) && (
                // violations-suppress: react/no-raw-button clear chip - same compact chip pattern
                <button type="button"
                  onClick={() => setActivePeriod({ from: null, to: null })}
                  className={CHIP_BTN_CLS}>
                  Clear
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {type === 'startup' && (
        <FieldNumber label="Delay (seconds)" value={delaySeconds} onChange={numericSetter(setDelaySeconds)} min={0} />
      )}

      {type === 'once' && (
        <FieldNumber
          label="Run after (seconds)"
          value={onceDelaySeconds}
          onChange={numericSetter(setOnceDelaySeconds)}
          min={1}
          error={errors?.onceDelay}
          required
        />
      )}

      <div>
        {/* violations-suppress: react/no-raw-button text-link toggle - no Button variant for inline text links */}
        <button type="button" className="text-xs text-primary hover:underline" onClick={() => setShowAdvanced((v) => !v)}>
          {showAdvanced ? '(hide) Advanced options' : '(show) Advanced options'}
        </button>
      </div>

      {showAdvanced && (
        <div className="rounded border border-border p-3 space-y-4">
          {/* Timeout */}
          <FieldNumber
            label="Timeout (seconds)"
            value={timeoutSeconds}
            onChange={numericSetter(setTimeoutSeconds)}
            min={0}
          />
          <FieldSelect
            label="Missed firing"
            value={missedFiring}
            onChange={v => setMissedFiring(v as MissedFiring)}
            options={MISSED_FIRING_OPTIONS}
          />

          <FieldSelect
            label="Liveness check"
            value={livenessStrategy}
            onChange={v => setLivenessStrategy(v as LivenessStrategy)}
            options={LIVENESS_OPTIONS}
          />
          {livenessStrategy === 'portFile' && (
            <FieldText label="Port file path" value={livenessPort} onChange={setLivenessPort} placeholder="/tmp/app.port" />
          )}
          {livenessStrategy === 'command' && (
            <FieldText label="Liveness command" value={livenessCommand} onChange={setLivenessCommand} placeholder="curl -sf http://localhost:3000/health" />
          )}

          {/* onExitCode */}
          <div>
            <label className={labelClass}>Exit code messages</label>
            <p className="text-xs text-muted mb-2">Show a custom message in the tray when the job exits with a specific code.</p>
            {exitCodePairs.map((pair, i) => (
              <div key={i} className="flex gap-2 mb-2 items-center">
                {/* violations-suppress: react/no-raw-input paired compact inline field - FieldNumber requires visible label; accessible via aria-label */}
                <input
                  type="number" placeholder="exit code" value={pair.code} aria-label="Exit code"
                  onChange={e => setExitCodePairs(prev => prev.map((p, j) => j === i ? { ...p, code: e.target.value } : p))}
                  className="w-24 rounded border border-border px-2 py-1 text-sm bg-surface text-content"
                />
                {/* violations-suppress: react/no-raw-input paired compact inline field - FieldText requires visible label; accessible via aria-label */}
                <input
                  type="text" placeholder="message" value={pair.msg} aria-label="Exit code message"
                  onChange={e => setExitCodePairs(prev => prev.map((p, j) => j === i ? { ...p, msg: e.target.value } : p))}
                  className="flex-1 rounded border border-border px-2 py-1 text-sm bg-surface text-content"
                />
                {/* violations-suppress: react/no-raw-button icon-only remove button - no accessible Button variant for compact remove */}
                <button type="button" onClick={() => setExitCodePairs(prev => prev.filter((_, j) => j !== i))}
                  className="text-danger hover:opacity-70 text-xs px-1"><X size={12} /></button>
              </div>
            ))}
            {/* violations-suppress: react/no-raw-button add-row button - Button component doesn't fit compact list-append pattern */}
            <button type="button" onClick={() => setExitCodePairs(prev => [...prev, { code: '', msg: '' }])}
              className="text-xs text-primary hover:underline">+ Add exit code</button>
          </div>

          {/* Environment variables */}
          <div>
            <label className={labelClass}>Environment variables</label>
            <p className="text-xs text-muted mb-2">Extra env vars injected into the job process.</p>
            {envPairs.map((pair, i) => (
              <div key={i} className="flex gap-2 mb-2 items-center">
                {/* violations-suppress: react/no-raw-input paired compact inline field - FieldText requires visible label; accessible via aria-label */}
                <input type="text" placeholder="KEY" value={pair.key} aria-label="Environment variable key"
                  onChange={e => setEnvPairs(prev => prev.map((p, j) => j === i ? { ...p, key: e.target.value } : p))}
                  className={MONO_INPUT} />
                {/* violations-suppress: react/no-raw-input paired compact inline field - FieldText requires visible label; accessible via aria-label */}
                <input type="text" placeholder="value" value={pair.val} aria-label="Environment variable value"
                  onChange={e => setEnvPairs(prev => prev.map((p, j) => j === i ? { ...p, val: e.target.value } : p))}
                  className="flex-1 rounded border border-border px-2 py-1 text-sm bg-surface text-content" />
                {/* violations-suppress: react/no-raw-button icon-only remove - no Button variant for compact remove */}
                <button type="button" onClick={() => setEnvPairs(prev => prev.filter((_, j) => j !== i))}
                  className="text-danger hover:opacity-70 px-1"><X size={12} /></button>
              </div>
            ))}
            {/* violations-suppress: react/no-raw-button add-row - Button doesn't fit compact list-append */}
            <button type="button" onClick={() => setEnvPairs(prev => [...prev, { key: '', val: '' }])}
              className="text-xs text-primary hover:underline flex items-center gap-1"><Plus size={10} />Add variable</button>
          </div>
          {/* Dependency */}
          <div>
            {/* Tied to the input by id: the label was floating, so a screen reader announced an
                unnamed text box and getByLabelText could not find it either. */}
            <label className={labelClass} htmlFor="dependsOn">Run after job (ID)</label>
            {/* violations-suppress: react/no-raw-input compact ID input - no shared select for job IDs */}
            <input type="text" id="dependsOn" value={dependsOn} onChange={e => setDependsOn(e.target.value)}
              placeholder="Leave empty for no dependency"
              className={FULL_INPUT} />
          </div>

          {/* SLA window */}
          <FieldNumber label="SLA window (minutes, 0 = disabled)" value={slaWindowMinutes} onChange={numericSetter(setSlaWindowMinutes)} min={0} />

          {/* Dry run */}
          <div className="flex items-center gap-2">
            {/* violations-suppress: react/no-raw-input boolean checkbox - no FieldText variant for checkbox */}
            <input type="checkbox" id="dryRunSupported" checked={dryRunSupported} onChange={e => setDryRunSupported(e.target.checked)}
              className="rounded border-border" />
            <label htmlFor="dryRunSupported" className="text-sm text-content">Supports dry run (appends --dry-run to command)</label>
          </div>
        </div>
      )}

      {/* Directly above the button that failed, so the cause is where the eye already is.
          role="alert" so it is announced rather than only drawn. */}
      {submitError !== null && (
        <div role="alert" className="rounded border border-danger bg-danger-subtle px-3 py-2 text-sm text-danger">
          Could not save: {submitError}
        </div>
      )}

      <div className="flex justify-end gap-2 pt-2">
        <ButtonCancel onCancel={onCancel} />
        {/* `loading || busy`: under the DSL the brain owns the request, so `onSubmit` resolves
            immediately and the internal `loading` flickers off while the save is still in flight.
            `busy` carries the brain's own $pending, which is the only thing that knows. */}
        <ButtonAction label="Save" variant="primary" type="submit" loading={loading || busy === true} />
      </div>
    </form>
  );
}
