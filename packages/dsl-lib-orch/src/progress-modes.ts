/*
 * The values of a job's `progress` setting, as the job form offers them.
 *
 * Duplicated from the daemon on purpose: the UI cannot import orchestrator-cli. The ids are the strategy ids of
 * orchestrator-cli/src/progress/registry.ts; test/progress-modes-parity.test.ts fails when the two lists differ.
 * The sentences describe what each strategy reads (see its source under orchestrator-cli/src/progress/).
 */

export interface ProgressMode {
  /** 'auto', 'off', or a registered strategy id. */
  id: string;
  label: string;
  /** One line, shown under the select. */
  explanation: string;
  /** A JSON example shown as the placeholder of the options box; absent when the mode takes no options. */
  optionsExample?: string;
  /** The daemon refuses the mode without options (ratio, log-declared). */
  optionsRequired?: boolean;
}

// @formatter:off
export const PROGRESS_MODES: readonly ProgressMode[] = [
  { id: 'auto',         label: 'Auto (default)',
    explanation: 'Uses the job\'s own ##orch-progress lines when its log has them, else what past runs show, else the usual duration.' },
  { id: 'off',          label: 'Off',
    explanation: 'No progress or estimated end is shown for this job.' },
  { id: 'history',      label: 'History',
    explanation: 'Elapsed time against the usual duration (median of the recent successful runs). Needs 3 successful runs.' },
  { id: 'log-learned',  label: 'Log, learned',
    explanation: 'Learns milestones from log lines that recur in past successful runs. Needs 3 runs with logs; runs under 10 s are too coarse.',
    optionsExample: '{"minSupportPercent": 60}' },
  { id: 'log-declared', label: 'Log, declared',
    explanation: 'Milestones you describe as log-line patterns, each with the fraction of the run where it appears.',
    optionsExample: '{"milestones": [{"pattern": "Step 1", "at": 0.3}, {"pattern": "Step 2", "at": 0.7}, {"pattern": "Done", "at": 1}]}',
    optionsRequired: true },
  { id: 'declared',     label: 'Declared by the job',
    explanation: 'The job reports it: ##orch-progress <0-100> [message] lines in its log, or a JSON file named in the options.',
    optionsExample: '{"file": "progress.json"}' },
  { id: 'ratio',        label: 'Counter in the log',
    explanation: 'Reads a counter such as 12/40 or 35% from the log with your pattern, and extrapolates the end from its pace.',
    optionsExample: '{"pattern": "(\\\\d+)/(\\\\d+)"}',
    optionsRequired: true },
  { id: 'ensemble',     label: 'Ensemble',
    explanation: 'Replays history, log-learned and declared on past runs and uses the most accurate. Needs 5 successful runs.' },
];
// @formatter:on

export function progressModeIds(): string[] {
  return PROGRESS_MODES.map(m => m.id);
}

export function progressModeOf(id: string): ProgressMode | undefined {
  return PROGRESS_MODES.find(m => m.id === id);
}
