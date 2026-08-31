import React, { useState } from 'react';
import type { Job } from '../types.js';

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
}

export function JobForm({ initial, onSubmit, onCancel }: Props): React.ReactElement {
  const [label, setLabel] = useState(initial?.label ?? '');
  const [type, setType] = useState<JobType>(initial?.type ?? 'cron');
  const [command, setCommand] = useState(initial?.command ?? '');
  const [cwd, setCwd] = useState(initial?.cwd ?? '');
  const [triggerMode, setTriggerMode] = useState<TriggerMode>(initial?.triggerMode ?? 'fire-and-forget');
  const [schedule, setSchedule] = useState(initial?.schedule ?? '');
  const [delaySeconds, setDelaySeconds] = useState(initial?.delaySeconds ?? 0);
  const [loading, setLoading] = useState(false);
  const [errors, setErrors] = useState<FormErrors>({});

  const validate = (): boolean => {
    const e: FormErrors = {};
    if (!label.trim()) e.label = 'Label is required';
    if (!command.trim()) e.command = 'Command is required';
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!validate()) return;
    setLoading(true);
    try {
      const data: Partial<Job> = { label: label.trim(), type, command: command.trim(), triggerMode };
      if (cwd.trim()) data.cwd = cwd.trim();
      if (type === 'cron' && schedule.trim()) data.schedule = schedule.trim();
      if (type === 'startup') data.delaySeconds = delaySeconds;
      await onSubmit(data);
    } finally {
      setLoading(false);
    }
  };

  const inputClass = 'w-full rounded border border-gray-300 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500';
  const labelClass = 'block text-sm font-medium text-gray-700 mb-1';
  const errorClass = 'mt-1 text-xs text-red-600';

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label className={labelClass}>Label *</label>
        <input className={inputClass} value={label} onChange={(e) => setLabel(e.target.value)} placeholder="My job" />
        {errors.label && <p className={errorClass}>{errors.label}</p>}
      </div>

      <div>
        <label className={labelClass}>Type</label>
        <select className={inputClass} value={type} onChange={(e) => setType(e.target.value as JobType)}>
          <option value="cron">Cron</option>
          <option value="startup">Startup</option>
          <option value="once">Once</option>
        </select>
      </div>

      <div>
        <label className={labelClass}>Command *</label>
        <input className={inputClass} value={command} onChange={(e) => setCommand(e.target.value)} placeholder="node script.js" />
        {errors.command && <p className={errorClass}>{errors.command}</p>}
      </div>

      <div>
        <label className={labelClass}>Working directory</label>
        <input className={inputClass} value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder="/optional/path" />
      </div>

      <div>
        <label className={labelClass}>Trigger mode</label>
        <select className={inputClass} value={triggerMode} onChange={(e) => setTriggerMode(e.target.value as TriggerMode)}>
          <option value="fire-and-forget">Fire and forget</option>
          <option value="wait">Wait for completion</option>
        </select>
      </div>

      {type === 'cron' && (
        <div>
          <label className={labelClass}>Schedule (cron expression)</label>
          <input className={inputClass} value={schedule} onChange={(e) => setSchedule(e.target.value)} placeholder="*/5 * * * *" />
        </div>
      )}

      {type === 'startup' && (
        <div>
          <label className={labelClass}>Delay (seconds)</label>
          <input
            type="number"
            min={0}
            className={inputClass}
            value={delaySeconds}
            onChange={(e) => setDelaySeconds(Number(e.target.value))}
          />
        </div>
      )}

      <div className="flex justify-end gap-2 pt-2">
        <button
          type="button"
          onClick={onCancel}
          className="px-4 py-2 text-sm rounded border border-gray-300 text-gray-700 hover:bg-gray-50 transition-colors"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={loading}
          className="px-4 py-2 text-sm rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {loading ? 'Saving...' : 'Save'}
        </button>
      </div>
    </form>
  );
}
