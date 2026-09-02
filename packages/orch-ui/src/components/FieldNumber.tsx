import React from 'react';

export interface FieldNumberProps {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  error?: string;
}

// @formatter:off
const INPUT_CLS = 'w-full rounded border border-border px-3 py-1.5 text-sm bg-surface text-content focus:outline-none focus:ring-2 focus:ring-primary';
// @formatter:on

export function FieldNumber({ label, value, onChange, min, max, error }: FieldNumberProps): React.ReactElement {
  return (
    <div>
      <label className="block text-sm font-medium text-content mb-1">{label}</label>
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        onChange={(e) => onChange(Number(e.target.value))}
        className={INPUT_CLS}
      />
      {error && <p className="mt-1 text-xs text-danger">{error}</p>}
    </div>
  );
}
