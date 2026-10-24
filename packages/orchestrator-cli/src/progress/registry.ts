import { declaredStrategy } from './declared-strategy.js';
import { autoEnsembleStrategy, ensembleStrategy } from './ensemble-strategy.js';
import { historyStrategy } from './history-strategy.js';
import { logDeclaredStrategy } from './log-declared-strategy.js';
import { logLearnedStrategy } from './log-learned-strategy.js';
import { ratioStrategy } from './ratio-strategy.js';
import type { ProgressStrategy } from './types.js';

/**
 * The built-in strategies. Strategies are built in and declarative (patterns and JSON only): no external code is
 * loaded, there is no plugin setting in config.yml.
 */
export const STRATEGIES: readonly ProgressStrategy[] = [
  declaredStrategy, ratioStrategy, logDeclaredStrategy, logLearnedStrategy, ensembleStrategy, historyStrategy,
];

/**
 * What `auto` tries, in this order. `ratio` and `log-declared` are explicit only: they need a pattern the user
 * wrote, and orch cannot guess one. `declared` needs nothing configured (it looks for the `##orch-progress`
 * convention in the log). `ensemble` compares log-learned and history on the job's own runs, so `log-learned`
 * never appears here on its own; the gated instance steps aside when history is the best it can do.
 */
export const AUTO_STRATEGIES: readonly ProgressStrategy[] = [declaredStrategy, autoEnsembleStrategy, historyStrategy];

/**
 * The ids a job's `progress` setting may name, besides the pseudo-modes 'auto' and 'off'.
 * The single list: validation, the CLI errors and the help read it, so registering a strategy above is enough.
 */
export const PROGRESS_STRATEGY_IDS: readonly string[] = STRATEGIES.map(s => s.id);
