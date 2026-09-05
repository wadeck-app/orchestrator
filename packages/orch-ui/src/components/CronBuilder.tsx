import React, { useState } from 'react';

type CronFreq = 'minutely' | 'every-n-min' | 'hourly' | 'daily' | 'weekdays' | 'weekly' | 'monthly';
const DAYS = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];

function buildCron(freq: CronFreq, n: number, h: number, m: number, day: number, weekdays: boolean[]): string {
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
}

export interface CronBuilderProps {
  value: string;
  onChange: (v: string) => void;
  onClose: () => void;
}

// @formatter:off
const SEL = 'rounded border border-border px-2 py-1 text-sm bg-surface text-content focus:outline-none';
// @formatter:on

export function CronBuilder({ onChange, onClose }: CronBuilderProps): React.ReactElement {
  const [freq, setFreq] = useState<CronFreq>('daily');
  const [n, setN] = useState(10);
  const [h, setH] = useState(10);
  const [m, setM] = useState(0);
  const [dom, setDom] = useState(1);
  const [weekdays, setWeekdays] = useState([true, true, true, true, true, false, false]);
  const preview = buildCron(freq, n, h, m, dom, weekdays);
  return (
    <div className="mt-2 p-3 rounded border border-border bg-muted-bg space-y-2 text-sm">
      <div className="flex items-center gap-2 flex-wrap">
        <label className="text-muted shrink-0">Frequency:</label>
        {/* violations-suppress: react/no-raw-input CronBuilder IS the atomic wizard control; select has no FieldText equivalent */}
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
          // violations-suppress: react/no-raw-input CronBuilder IS the atomic wizard control; number stepper has no FieldNumber equivalent here
          <input type="number" min={1} max={59} value={n} onChange={e => setN(Number(e.target.value))} className={`${SEL} w-16`} />
        )}
        {['daily','weekdays','weekly','monthly'].includes(freq) && (
          <>
            <label className="text-muted">at</label>
            {/* violations-suppress: react/no-raw-input CronBuilder IS the atomic wizard control; hour/minute selects have no FieldText equivalent */}
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
            // violations-suppress: react/no-raw-button day-toggle chip - CronBuilder IS the atomic wizard; toggle chips have no Button variant
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
          {/* violations-suppress-start: react/no-raw-button CronBuilder IS the atomic wizard; Cancel is a text-link (no Button variant), Apply has custom xs sizing that Button does not support */}
          <button type="button" onClick={onClose} className="text-xs text-muted hover:text-content">Cancel</button>
          <button type="button" onClick={() => onChange(preview)}
            className="text-xs px-3 py-1 rounded bg-primary text-on-primary hover:bg-primary-hover">Apply</button>
          {/* violations-suppress-end: react/no-raw-button */}
        </div>
      </div>
    </div>
  );
}
