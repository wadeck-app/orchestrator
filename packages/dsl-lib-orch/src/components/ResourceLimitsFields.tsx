import React from 'react';
import {
  ENFORCE_EXPLANATIONS, ENFORCE_LABELS, RESOURCE_DEFAULTS, type ResourceLimitErrors, type ResourceLimitInputs,
} from '../resource-limits.js';
import type { ResourceEnforce } from '../types.js';

export interface ResourceLimitsFieldsProps {
  inputs: ResourceLimitInputs;
  onChange: (next: ResourceLimitInputs) => void;
  errors: ResourceLimitErrors;
}

const INPUT_CLS = 'block w-32 rounded border border-border bg-surface text-content px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary';
const SELECT_CLS = 'block w-48 rounded border border-border bg-surface text-content px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary';

interface NumberFieldSpec {
  key: 'hardFactor' | 'softFactor' | 'sustainSeconds' | 'maxCpuPct' | 'maxRamMb';
  label: string;
  hint: string;
  placeholder?: string;
}

// @formatter:off
const NUMBER_FIELDS: NumberFieldSpec[] = [
  { key: 'hardFactor',     label: 'Hard factor',            hint: "A run is ended (or only reported, in warn mode) when it stays above the job's baseline times this. Greater than 1, at most 100.", placeholder: String(RESOURCE_DEFAULTS.hardFactor) },
  { key: 'softFactor',     label: 'Soft factor',            hint: 'Above the baseline times this the run is only flagged. Greater than 1 and below the hard factor.',                              placeholder: String(RESOURCE_DEFAULTS.softFactor) },
  { key: 'sustainSeconds', label: 'Sustain time (seconds)', hint: 'How long a run must stay over the hard limit before the monitor acts. Whole seconds, 2 to 3600.',                              placeholder: String(RESOURCE_DEFAULTS.sustainSeconds) },
  { key: 'maxCpuPct',      label: 'Max CPU (%)',            hint: 'An absolute CPU ceiling, instead of one derived from the baseline. Greater than 0. Empty means derived.' },
  { key: 'maxRamMb',       label: 'Max RAM (MB)',           hint: 'An absolute RAM ceiling, instead of one derived from the baseline. Greater than 0. Empty means derived.' },
];
// @formatter:on

/**
 * The fields of a job's resource limits. Plain number inputs with step="any" rather than dsl-ui's FieldNumber,
 * which has neither a step (a factor of 1.5 is refused by the browser's own validation at the default step of 1)
 * nor a placeholder (the daemon's defaults are shown there, so an empty box says what applies).
 */
export function ResourceLimitsFields({ inputs, onChange, errors }: ResourceLimitsFieldsProps): React.ReactElement {
  return (
    <div className="rounded border border-border p-3 space-y-4">
      <p className="text-xs text-muted">
        Every box is optional: an empty one takes the default shown in it.
      </p>
      <div>
        <label htmlFor="resourceEnforce" className="block text-sm font-medium text-content mb-1">Enforcement</label>
        {/* violations-suppress: react/no-raw-input three-option select with a per-option explanation below; dsl-ui's FieldSelect has no slot for it */}
        <select
          id="resourceEnforce"
          value={inputs.enforce}
          onChange={e => onChange({ ...inputs, enforce: e.target.value as ResourceEnforce })}
          className={SELECT_CLS}
        >
          {(Object.keys(ENFORCE_LABELS) as ResourceEnforce[]).map(value => (
            <option key={value} value={value}>{ENFORCE_LABELS[value]}</option>
          ))}
        </select>
        <p className="mt-1 text-xs text-muted">{ENFORCE_EXPLANATIONS[inputs.enforce]}</p>
      </div>
      {NUMBER_FIELDS.map(field => {
        const error = errors[field.key];
        const id = `resource-${field.key}`;
        return (
          <div key={field.key}>
            <label htmlFor={id} className="block text-sm font-medium text-content mb-1">{field.label}</label>
            {/* violations-suppress: react/no-raw-input needs step="any" and a placeholder, which FieldNumber does not offer */}
            <input
              id={id}
              type="number"
              step="any"
              value={inputs[field.key]}
              placeholder={field.placeholder}
              aria-invalid={error !== undefined}
              aria-describedby={`${id}-hint`}
              onChange={e => onChange({ ...inputs, [field.key]: e.target.value })}
              className={INPUT_CLS}
            />
            <p id={`${id}-hint`} className="mt-1 text-xs text-muted">{field.hint}</p>
            {error && <p role="alert" className="mt-1 text-xs text-danger">{error}</p>}
          </div>
        );
      })}
    </div>
  );
}
