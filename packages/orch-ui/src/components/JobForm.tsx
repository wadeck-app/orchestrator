import React, { useState } from 'react';
import { X } from 'lucide-react';
import type { Job, MissedFiring, LivenessConfig, LivenessStrategy } from '../types.js';
import { Button } from './Button.js';
import { FieldText } from './FieldText.js';
import { FieldNumber } from './FieldNumber.js';

type JobType = Job['type'];
type TriggerMode = Job['triggerMode'];

interface Props {
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

/**
 * @registryCategory form
 * @registryTags form job edit create
 */
export function JobForm({ initial, onSubmit, onCancel }: Props): React.ReactElement {
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
          <FieldText label="Schedule (cron expression)" value={schedule} onChange={setSchedule} placeholder="*/5 * * * *" error={errors?.schedule} />
          {cronHint && <p className="mt-1 text-xs text-primary">{cronHint}</p>}
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
        </div>
      )}

      <div className="flex justify-end gap-2 pt-2">
        <Button label="Cancel" variant="secondary" onClick={onCancel} type="button" />
        <Button label={loading ? 'Saving...' : 'Save'} variant="primary" type="submit" loading={loading} />
      </div>
    </form>
  );
}
