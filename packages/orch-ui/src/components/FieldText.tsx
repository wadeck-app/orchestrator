import React from 'react';

export interface FieldTextProps {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  error?: string;
  required?: boolean;
}

// @formatter:off
const INPUT_CLS = 'w-full rounded border border-border px-3 py-1.5 text-sm bg-surface text-content focus:outline-none focus:ring-2 focus:ring-primary';
// @formatter:on

export function FieldText({ label, value, onChange, placeholder, error, required }: FieldTextProps): React.ReactElement {
  return (
    <div>
      <label className="block text-sm font-medium text-content mb-1">
        {label}{required && ' *'}
      </label>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={INPUT_CLS}
      />
      {error && <p className="mt-1 text-xs text-danger">{error}</p>}
    </div>
  );
}
