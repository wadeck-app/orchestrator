import React from 'react';
import { FieldSelect, Switch, type FieldSelectOption } from '@wadeck-app/dsl-ui';
import {
  RESTART_DEFAULTS, RESTART_STRATEGIES, RESTART_STRATEGY_EXPLANATIONS, RESTART_STRATEGY_LABELS, strategyUses,
  type RestartFieldErrors, type RestartInputs, type RestartNumberKey, type RestartStrategy,
} from '../restart-policy.js';

export interface RestartFieldsProps {
  enabled: boolean;
  onToggle: (enabled: boolean) => void;
  inputs: RestartInputs;
  onChange: (next: RestartInputs) => void;
  errors: RestartFieldErrors;
  /** The job's timeout as the form holds it: '' is "not set", which the daemon reads as its default of 300 s. */
  timeoutSeconds: number | '';
  /** Why the policy cannot be switched on (a retry list is set); the switch is locked while this is given and the policy is off. */
  lockedReason?: string;
  /** The refusal after a Save attempt, when the job has both a policy and a retry list. */
  conflictError?: string;
}

const INPUT_CLS = 'block w-32 rounded border border-border bg-surface text-content px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary aria-[invalid=true]:border-danger';

const STRATEGY_OPTIONS: FieldSelectOption[] = RESTART_STRATEGIES.map(value => ({ value, label: RESTART_STRATEGY_LABELS[value] }));

interface NumberFieldSpec {
  key: RestartNumberKey;
  label: string;
  hint: string;
}

// @formatter:off
const NUMBER_FIELDS: NumberFieldSpec[] = [
  { key: 'initialDelaySeconds', label: 'Initial delay (seconds)',  hint: 'The pause before the first restart. Above 0.' },
  { key: 'factor',              label: 'Factor',                   hint: 'What the pause is multiplied by at each restart. Above 1; for a constant pause use the fixed strategy.' },
  { key: 'stepSeconds',         label: 'Step (seconds)',           hint: 'What is added to the pause at each restart. Above 0. Empty means the initial delay.' },
  { key: 'maxDelaySeconds',     label: 'Max delay (seconds)',      hint: 'The pause never exceeds this. At least the initial delay.' },
  { key: 'maxRestarts',         label: 'Max restarts',             hint: 'Restarts allowed within the window; one more and the job is given up on until you trigger it. Whole number, at least 1.' },
  { key: 'windowSeconds',       label: 'Window (seconds)',         hint: 'The sliding window the limit is counted over. Whole seconds, at least 1.' },
  { key: 'stableAfterSeconds',  label: 'Stable after (seconds)',   hint: 'A run that stayed up this long clears the backoff and the restart count. Whole seconds, at least 1.' },
];
// @formatter:on

function placeholderOf(key: RestartNumberKey, inputs: RestartInputs): string {
  // The step follows the initial delay, typed or default.
  if (key === 'stepSeconds') {
    return inputs.initialDelaySeconds.trim() !== '' ? inputs.initialDelaySeconds.trim() : String(RESTART_DEFAULTS.initialDelaySeconds);
  }
  return String(RESTART_DEFAULTS[key as keyof typeof RESTART_DEFAULTS]);
}

/**
 * The restart policy of a job: a switch, then (when on) the strategy and the numeric options the strategy reads.
 * Plain number inputs with step="any" and a placeholder, for the same reason as ResourceLimitsFields: dsl-ui's
 * FieldNumber has neither, and the daemon's defaults belong in the empty box.
 */
export function RestartFields({ enabled, onToggle, inputs, onChange, errors, timeoutSeconds, lockedReason, conflictError }: RestartFieldsProps): React.ReactElement {
  const locked = lockedReason !== undefined && !enabled;
  const effectiveTimeout = timeoutSeconds === '' ? 300 : timeoutSeconds;
  return (
    <div className="rounded border border-border p-3 space-y-3">
      <Switch label="Restart on exit" checked={enabled} onChange={onToggle} disabled={locked} />
      <p className="text-xs text-muted">
        Brings the job back after any exit: success, failure, signal or timeout. For a server that must stay up. A manual stop never restarts it.
      </p>
      {lockedReason !== undefined && (
        conflictError !== undefined
          ? <p role="alert" className="text-xs text-danger">{conflictError}</p>
          : <p className="text-xs text-warning-text">{lockedReason}</p>
      )}
      {enabled && (
        <>
          <p className="text-xs text-muted">
            A job with the default 300 s timeout is killed and restarts every 5 minutes. Use timeout 0 (Advanced options) for a server.
          </p>
          {effectiveTimeout !== 0 && (
            <p role="status" className="rounded border border-warning bg-warning-bg px-3 py-2 text-xs text-warning-text">
              {timeoutSeconds === '' ? 'No timeout is set, so the default of 300 s applies' : `The timeout of this job is ${timeoutSeconds} s`}:
              {' '}every run is killed after {effectiveTimeout} s and restarted. Set it to 0 in Advanced options for a server.
            </p>
          )}
          <p className="text-xs text-muted">Every box is optional: an empty one takes the default shown in it.</p>
          <div>
            <FieldSelect
              label="Strategy"
              value={inputs.strategy}
              onChange={v => onChange({ ...inputs, strategy: v as RestartStrategy })}
              options={STRATEGY_OPTIONS}
            />
            <p className="mt-1 text-xs text-muted">{RESTART_STRATEGY_EXPLANATIONS[inputs.strategy]}</p>
          </div>
          {NUMBER_FIELDS.filter(field => strategyUses(inputs.strategy, field.key)).map(field => {
            const error = errors[field.key];
            const id = `restart-${field.key}`;
            return (
              <div key={field.key}>
                <label htmlFor={id} className="block text-sm font-medium text-content mb-1">{field.label}</label>
                {/* violations-suppress: react/no-raw-input needs step="any" and a placeholder, which FieldNumber does not offer */}
                <input
                  id={id}
                  type="number"
                  step="any"
                  value={inputs[field.key]}
                  placeholder={placeholderOf(field.key, inputs)}
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
        </>
      )}
    </div>
  );
}
