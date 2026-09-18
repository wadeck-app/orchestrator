import React, { useState } from 'react';
import { X, Plus, Wand2 } from 'lucide-react';
import { getErrorMessage, type Job, type MissedFiring, type LivenessConfig, type LivenessStrategy } from '../types.js';
import { describeCron } from '../cron-describe.js';
import { ButtonAction, ButtonCancel, CronBuilder, FieldNumber, FieldSelect, FieldText, IconButton, type FieldSelectOption } from '@wadeck-app/dsl-ui';

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
  onSubmit: (data: Partial<Job>) => Promise<void>;
  onCancel: () => void;
}

interface FormErrors {
  label?: string;
  command?: string;
  schedule?: string;
}

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
export function JobForm({ initial, onSubmit, onCancel }: JobFormProps): React.ReactElement {
  const [label, setLabel] = useState(initial?.label ?? '');
  const [type, setType] = useState<JobType>(initial?.type ?? 'cron');
  const [command, setCommand] = useState(initial?.command ?? '');
  const [cwd, setCwd] = useState(initial?.cwd ?? '');
  const [triggerMode, setTriggerMode] = useState<TriggerMode>(initial?.triggerMode ?? 'fire-and-forget');
  const [schedule, setSchedule] = useState(initial?.schedule ?? '');
  const [delaySeconds, setDelaySeconds] = useState(initial?.delaySeconds ?? 0);
  const [missedFiring, setMissedFiring] = useState<MissedFiring>(initial?.missedFiring ?? 'skip');
  const [timeoutSeconds, setTimeoutSeconds] = useState<number>(initial?.timeoutSeconds ?? 300);
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
      const data: Partial<Job> = { label: label.trim(), type, command: command.trim(), triggerMode, missedFiring };
      if (cwd.trim()) data.cwd = cwd.trim();
      if (type === 'cron' && schedule.trim()) data.schedule = schedule.trim();
      if (type === 'startup') data.delaySeconds = delaySeconds;

      // Liveness
      if (livenessStrategy !== 'none') {
        const liveness: LivenessConfig = { strategy: livenessStrategy };
        if (livenessStrategy === 'portFile' && livenessPort.trim()) liveness.portFile = livenessPort.trim();
        if (livenessStrategy === 'command' && livenessCommand.trim()) liveness.command = livenessCommand.trim();
        data.liveness = liveness;
      } else {
        data.liveness = null;
      }

      // timeout
      if (timeoutSeconds > 0) data.timeoutSeconds = timeoutSeconds;

      // onExitCode
      const validPairs = exitCodePairs.filter(p => p.code.trim() && p.msg.trim());
      if (validPairs.length > 0) {
        data.onExitCode = Object.fromEntries(validPairs.map(p => [p.code.trim(), p.msg.trim()]));
      }

      // env vars
      const validEnv = envPairs.filter(p => p.key.trim());
      if (validEnv.length > 0) {
        data.env = Object.fromEntries(validEnv.map(p => [p.key.trim(), p.val]));
      }

      // tags
      const tags = tagInput.split(',').map(t => t.trim()).filter(Boolean);
      if (tags.length > 0) data.tags = tags;

      // v3 fields
      if (dependsOn.trim()) data.dependsOn = dependsOn.trim();
      if (slaWindowMinutes > 0) data.slaWindowMinutes = slaWindowMinutes;
      if (dryRunSupported) data.dryRunSupported = true;

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
        </div>
      )}

      {type === 'startup' && (
        <FieldNumber label="Delay (seconds)" value={delaySeconds} onChange={numericSetter(setDelaySeconds)} min={0} />
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
            <label className={labelClass}>Run after job (ID)</label>
            {/* violations-suppress: react/no-raw-input compact ID input - no shared select for job IDs */}
            <input type="text" value={dependsOn} onChange={e => setDependsOn(e.target.value)}
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
        <ButtonAction label="Save" variant="primary" type="submit" loading={loading} />
      </div>
    </form>
  );
}
