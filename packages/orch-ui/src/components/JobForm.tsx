import React, { useState } from 'react';
import { X, Plus, Wand2 } from 'lucide-react';
import type { Job, MissedFiring, LivenessConfig, LivenessStrategy } from '../types.js';
import { Button } from './Button.js';
import { FieldText } from './FieldText.js';
import { FieldNumber } from './FieldNumber.js';

// @formatter:off
const CHIP_BTN_CLS  = 'text-xs px-2 py-0.5 rounded border border-border text-muted hover:bg-muted-bg hover:text-content transition-colors';
const MONO_INPUT    = 'w-32 rounded border border-border px-2 py-1 text-sm bg-surface text-content font-mono';
const FULL_INPUT    = 'w-full rounded border border-border px-3 py-1.5 text-sm bg-surface text-content focus:outline-none focus:ring-2 focus:ring-primary';

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

function parseCron(expr: string): string | null {
  if (!expr.trim()) return null;
  const parts = expr.trim().split(/\s+/);
  if (parts.length < 5 || parts.length > 6) return 'Must have 5 or 6 parts (min hour dom mon dow [year])';
  return null;
}

// --- Cron Builder ---

type CronFreq = 'minutely' | 'every-n-min' | 'hourly' | 'daily' | 'weekdays' | 'weekly' | 'monthly';
const DAYS = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];

function buildCron(freq: CronFreq, n: number, h: number, m: number, day: number, weekdays: boolean[]): string {
  const mm = String(m).padStart(2, '0');
  switch (freq) {
    case 'minutely':   return '* * * * *';
    case 'every-n-min': return `*/${n} * * * *`;
    case 'hourly':     return `${m} * * * *`;
    case 'daily':      return `${m} ${h} * * *`;
    case 'weekdays':   return `${m} ${h} * * 1-5`;
    case 'weekly': {
      const picked = weekdays.map((on, i) => on ? i + 1 : null).filter(Boolean).join(',') || '1';
      return `${m} ${h} * * ${picked}`;
    }
    case 'monthly':    return `${m} ${h} ${day} * *`;
    default:           return '';
  }
  void mm;
}

function CronBuilder({ onChange, onClose }: { value: string; onChange: (v: string) => void; onClose: () => void }): React.ReactElement {
  const [freq, setFreq] = useState<CronFreq>('daily');
  const [n, setN] = useState(10);
  const [h, setH] = useState(10);
  const [m, setM] = useState(0);
  const [dom, setDom] = useState(1);
  const [weekdays, setWeekdays] = useState([true, true, true, true, true, false, false]);
  const preview = buildCron(freq, n, h, m, dom, weekdays);
  // @formatter:off
  const SEL = 'rounded border border-border px-2 py-1 text-sm bg-surface text-content focus:outline-none';
  // @formatter:on
  return (
    <div className="mt-2 p-3 rounded border border-border bg-muted-bg space-y-2 text-sm">
      <div className="flex items-center gap-2 flex-wrap">
        <label className="text-muted shrink-0">Frequency:</label>
        {/* violations-suppress: react/no-raw-input cron builder select - compact wizard control */}
        <select className={SEL} value={freq} onChange={e => setFreq(e.target.value as CronFreq)}>
          <option value="minutely">Every minute</option>
          <option value="every-n-min">Every N minutes</option>
          <option value="hourly">Every hour</option>
          <option value="daily">Daily</option>
          <option value="weekdays">Weekdays (Mon-Fri)</option>
          <option value="weekly">Specific days</option>
          <option value="monthly">Monthly</option>
        </select>
        {freq === 'every-n-min' && (
          // violations-suppress: react/no-raw-input cron builder number input - compact wizard control
          <input type="number" min={1} max={59} value={n} onChange={e => setN(Number(e.target.value))} className={`${SEL} w-16`} />
        )}
        {['daily','weekdays','weekly','monthly'].includes(freq) && (
          <>
            <label className="text-muted">at</label>
            {/* violations-suppress: react/no-raw-input cron builder time selects - compact wizard control */}
            <select className={SEL} value={h} onChange={e => setH(Number(e.target.value))}>
              {Array.from({length:24},(_,i)=><option key={i} value={i}>{String(i).padStart(2,'0')}</option>)}
            </select>
            <span className="text-muted">:</span>
            <select className={SEL} value={m} onChange={e => setM(Number(e.target.value))}>
              {[0,5,10,15,20,25,30,35,40,45,50,55].map(v=><option key={v} value={v}>{String(v).padStart(2,'0')}</option>)}
            </select>
          </>
        )}
        {freq === 'monthly' && (
          <>
            <label className="text-muted">on day</label>
            <select className={SEL} value={dom} onChange={e => setDom(Number(e.target.value))}>
              {Array.from({length:28},(_,i)=><option key={i+1} value={i+1}>{i+1}</option>)}
            </select>
          </>
        )}
        {freq === 'hourly' && (
          <>
            <label className="text-muted">at minute</label>
            <select className={SEL} value={m} onChange={e => setM(Number(e.target.value))}>
              {[0,5,10,15,20,25,30,35,40,45,50,55].map(v=><option key={v} value={v}>{v}</option>)}
            </select>
          </>
        )}
      </div>
      {freq === 'weekly' && (
        <div className="flex gap-1 flex-wrap">
          {DAYS.map((d, i) => (
            // violations-suppress: react/no-raw-button day toggle chip - compact wizard day selection
            <button key={d} type="button" onClick={() => setWeekdays(prev => prev.map((v, j) => j === i ? !v : v))}
              className={`px-2 py-0.5 rounded text-xs border ${weekdays[i] ? 'bg-primary text-on-primary border-primary' : 'border-border text-muted bg-surface'}`}>
              {d}
            </button>
          ))}
        </div>
      )}
      <div className="flex items-center justify-between gap-2">
        <code className="text-xs text-muted bg-surface border border-border rounded px-2 py-0.5">{preview}</code>
        <div className="flex gap-2">
          {/* violations-suppress: react/no-raw-button cron builder action buttons - compact inline wizard */}
          <button type="button" onClick={onClose} className="text-xs text-muted hover:text-content">Cancel</button>
          <button type="button" onClick={() => onChange(preview)}
            className="text-xs px-3 py-1 rounded bg-primary text-on-primary hover:bg-primary-hover">Apply</button>
        </div>
      </div>
    </div>
  );
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

      await onSubmit(data);
    } finally {
      setLoading(false);
    }
  };

  const cronHint = type === 'cron' && schedule.trim() && !errors?.schedule
    ? (() => {
        const p = schedule.trim().split(/\s+/);
        if (p.length >= 5) {
          const [min, hour, dom, mon, dow] = p;
          if (min === '*' && hour === '*') return 'Every minute';
          if (dom === '*' && mon === '*' && dow === '*') {
            if (min !== '*' && hour !== '*') return `Daily at ${hour.padStart(2, '0')}:${min.padStart(2, '0')}`;
          }
          return null;
        }
        return null;
      })()
    : null;

  const selectClass = 'w-full rounded border border-border px-3 py-1.5 text-sm bg-surface text-content focus:outline-none focus:ring-2 focus:ring-primary';
  const labelClass = 'block text-sm font-medium text-content mb-1';

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <FieldText label="Label" value={label} onChange={setLabel} placeholder="My job" error={errors?.label} required />

      <FieldText label="Tags (comma-separated)" value={tagInput} onChange={setTagInput} placeholder="scraper, daily, production" />

      <div>
        <label className={labelClass}>Type</label>
        <select className={selectClass} value={type} onChange={(e) => setType(e.target.value as JobType)}>
          <option value="cron">Cron</option>
          <option value="startup">Startup</option>
          <option value="once">Once</option>
        </select>
      </div>

      <FieldText label="Command" value={command} onChange={setCommand} placeholder="node script.js" error={errors?.command} required />
      <FieldText label="Working directory" value={cwd} onChange={setCwd} placeholder="/optional/path" />

      <div>
        <label className={labelClass}>Trigger mode</label>
        <select className={selectClass} value={triggerMode} onChange={(e) => setTriggerMode(e.target.value as TriggerMode)}>
          <option value="fire-and-forget">Fire and forget</option>
          <option value="wait">Wait for completion</option>
        </select>
      </div>

      {type === 'cron' && (
        <div>
          <div className="flex items-end gap-2">
            <div className="flex-1">
              <FieldText label="Schedule (cron expression)" value={schedule} onChange={setSchedule} placeholder="*/5 * * * *" error={errors?.schedule} />
            </div>
            {/* violations-suppress: react/no-raw-button cron builder toggle - compact icon button, no Button variant fits */}
            <button type="button" onClick={() => setShowBuilder(v => !v)} title="Open cron builder"
              className="mb-1 p-2 rounded border border-border text-muted hover:text-content hover:bg-muted-bg transition-colors">
              <Wand2 size={14} />
            </button>
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
        <FieldNumber label="Delay (seconds)" value={delaySeconds} onChange={setDelaySeconds} min={0} />
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
            onChange={setTimeoutSeconds}
            min={0}
          />
          {/* Missed firing */}
          <div>
            <label className={labelClass}>Missed firing</label>
            <select className={selectClass} value={missedFiring} onChange={(e) => setMissedFiring(e.target.value as MissedFiring)}>
              <option value="skip">Skip (default)</option>
              <option value="catch-up">Catch-up (run immediately after restart)</option>
            </select>
          </div>

          {/* Liveness */}
          <div>
            <label className={labelClass}>Liveness check</label>
            <select className={selectClass} value={livenessStrategy} onChange={(e) => setLivenessStrategy(e.target.value as LivenessStrategy)}>
              <option value="none">None</option>
              <option value="portFile">Port file</option>
              <option value="pidFile">PID file</option>
              <option value="command">Command</option>
            </select>
          </div>
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
                {/* violations-suppress: react/no-raw-input compact inline field without label - form context makes purpose clear */}
                <input
                  type="number" placeholder="exit code" value={pair.code}
                  onChange={e => setExitCodePairs(prev => prev.map((p, j) => j === i ? { ...p, code: e.target.value } : p))}
                  className="w-24 rounded border border-border px-2 py-1 text-sm bg-surface text-content"
                />
                {/* violations-suppress: react/no-raw-input compact inline field without label - form context makes purpose clear */}
                <input
                  type="text" placeholder="message" value={pair.msg}
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
                {/* violations-suppress: react/no-raw-input compact key field - form context makes purpose clear */}
                <input type="text" placeholder="KEY" value={pair.key}
                  onChange={e => setEnvPairs(prev => prev.map((p, j) => j === i ? { ...p, key: e.target.value } : p))}
                  className={MONO_INPUT} />
                {/* violations-suppress: react/no-raw-input compact value field - form context makes purpose clear */}
                <input type="text" placeholder="value" value={pair.val}
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
          <FieldNumber label="SLA window (minutes, 0 = disabled)" value={slaWindowMinutes} onChange={setSlaWindowMinutes} min={0} />

          {/* Dry run */}
          <div className="flex items-center gap-2">
            {/* violations-suppress: react/no-raw-input boolean checkbox - no FieldText variant for checkbox */}
            <input type="checkbox" id="dryRunSupported" checked={dryRunSupported} onChange={e => setDryRunSupported(e.target.checked)}
              className="rounded border-border" />
            <label htmlFor="dryRunSupported" className="text-sm text-content">Supports dry run (appends --dry-run to command)</label>
          </div>
        </div>
      )}

      <div className="flex justify-end gap-2 pt-2">
        <Button label="Cancel" variant="secondary" onClick={onCancel} type="button" />
        <Button label={loading ? 'Saving...' : 'Save'} variant="primary" type="submit" loading={loading} />
      </div>
    </form>
  );
}
