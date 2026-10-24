import { clamp01, levelOfScore, noEstimate } from './estimate-utils.js';
import { declaredStrategy } from './declared-strategy.js';
import { historyStrategy } from './history-strategy.js';
import { createLogLearnedStrategy, learnInto, type LearnedData } from './log-learned-strategy.js';
import { memoryStore, replayJob } from './replay.js';
import type { LogCorpus, ProgressContext, ProgressEstimate, ProgressStrategy, StrategyStore } from './types.js';

/**
 * `ensemble`: replays the member strategies on the job's own usable runs (leave-one-out, see replay.ts) and
 * answers with the one whose end time was closest to the real one. The reason always names the pick and the
 * replay error of every member that had estimates.
 *
 * The comparison costs far more than one estimate, so it is kept in the store and made in slices: each estimate
 * reads at most `learnByteBudget` bytes of past logs and replays at most `evalByteBudget` bytes of runs (one run
 * at least). Until it has enough evidence the reason says so, and `history` answers (explicit) or the strategy
 * steps aside (in `auto`).
 */

/** Usable runs needed for any answer. */
export const ENSEMBLE_MIN_RUNS = 3;
/** Usable runs needed to compare the strategies: 3 older ones to learn from, 2 runs to be judged on. */
export const ENSEMBLE_COMPARE_MIN_RUNS = 5;
/** The newest runs the strategies are judged on. */
export const ENSEMBLE_MAX_EVALUATED = 8;
/** Runs judged before the comparison is trusted. */
export const ENSEMBLE_MIN_EVALUATED = 2;
export const ENSEMBLE_LEARN_BYTE_BUDGET = 1024 * 1024;
export const ENSEMBLE_EVAL_BYTE_BUDGET = 2 * 1024 * 1024;
/** Two replay errors closer than this (share of the run) are a tie: the priority order decides. */
const TIE_MARGIN = 0.005;
/** A member must have an estimate on at least this share of the replayed samples to be picked. */
const MIN_COVERAGE = 0.5;
const REPLAY_STEP_PERCENT = 25;
const PAST_WINDOW = 20;

/** Priority order, also the tie-break. */
const MEMBER_IDS = ['declared', 'log-learned', 'history'] as const;
type MemberId = typeof MEMBER_IDS[number];

interface MemberScore {
  samples: number;
  covered: number;
  sumPct: number;
  sumSec: number;
}

interface EnsembleData {
  /** Versions of the members the data was made with. */
  members: Record<string, number>;
  /** The log-learned data, shared by the replay and the live estimate. */
  learned: LearnedData;
  /** Per judged run (its startedAt): what each member scored on it. */
  scores: Record<string, Partial<Record<MemberId, MemberScore>>>;
}

export interface EnsembleDeps {
  learnByteBudget?: number;
  evalByteBudget?: number;
  /** In `auto`: only answer when the pick is better than history. */
  gate?: boolean;
}

function fresh(versions: Record<string, number>): EnsembleData {
  return { members: versions, learned: { runs: {} }, scores: {} };
}

const percent = (share: number): string => `${(share * 100).toFixed(1)} %`;

export function createEnsembleStrategy(deps: EnsembleDeps = {}): ProgressStrategy {
  const learnBudget = deps.learnByteBudget ?? ENSEMBLE_LEARN_BYTE_BUDGET;
  const evalBudget = deps.evalByteBudget ?? ENSEMBLE_EVAL_BYTE_BUDGET;
  const gate = deps.gate === true;
  // Learning is done by the ensemble itself, before the replay, so the member never reads logs during a replay.
  const logLearned = createLogLearnedStrategy({ learnByteBudget: 0 });
  const members: Record<MemberId, ProgressStrategy> = { declared: declaredStrategy, 'log-learned': logLearned, history: historyStrategy };
  const versions = Object.fromEntries(MEMBER_IDS.map(id => [id, members[id].version]));

  return {
    id: 'ensemble',
    version: 1,
    validateOptions: (raw) => (raw === undefined ? { ok: true, value: undefined } : { ok: false, error: 'the ensemble strategy takes no options' }),

    estimate(ctx: ProgressContext): ProgressEstimate {
      const now = ctx.now();
      const none = (reason: string, detail?: Record<string, unknown>): ProgressEstimate => noEstimate('ensemble', now, reason, detail);
      const wrap = (e: ProgressEstimate, chosen: string, reason: string, extra: Record<string, unknown> = {}): ProgressEstimate => ({
        ...e, strategyId: 'ensemble', reason, detail: { ...e.detail, chosen, ...extra },
      });

      const past = ctx.logs.pastRuns(PAST_WINDOW);
      const n = past.length;
      if (n < ENSEMBLE_MIN_RUNS) {
        const missing = ENSEMBLE_MIN_RUNS - n;
        return none(`needs ${ENSEMBLE_MIN_RUNS} usable runs, has ${n} (the ensemble compares strategies on the job's past runs: run the job to completion ${missing} more time${missing === 1 ? '' : 's'})`, { usableRuns: n });
      }
      if (n < ENSEMBLE_COMPARE_MIN_RUNS) {
        const why = `needs ${ENSEMBLE_COMPARE_MIN_RUNS} usable runs to compare strategies, has ${n}`;
        if (gate) {
          return none(`ensemble: ${why}`, { usableRuns: n });
        }
        const h = historyStrategy.estimate(ctx);
        return wrap(h, 'history', `ensemble: history (${why}): ${h.reason}`, { usableRuns: n });
      }

      // The stored comparison, unless a member changed under it.
      let data = ctx.store.read() as EnsembleData | undefined;
      let dirty = false;
      if (data !== undefined && (typeof data !== 'object' || data === null || JSON.stringify(data.members) !== JSON.stringify(versions)
        || typeof data.learned?.runs !== 'object' || typeof data.scores !== 'object')) {
        ctx.store.invalidate('a member strategy changed version');
        data = undefined;
      }
      if (data === undefined) {
        data = fresh(versions);
        dirty = true;
      }
      const state = data;
      const learnedStore: StrategyStore = {
        read: () => state.learned,
        write: (d) => { state.learned = d as LearnedData; },
        meta: () => undefined,
        invalidate: () => { state.learned = { runs: {} }; },
      };

      // 1. Learn the logs of the window (sliced).
      const learned = learnInto(state.learned, past, learnBudget);
      dirty = dirty || learned.changed;

      // 2. Judge the newest runs that have 3 older ones, once all the logs are learned (sliced).
      const judged = past.slice(0, Math.max(0, n - ENSEMBLE_MIN_RUNS)).slice(0, ENSEMBLE_MAX_EVALUATED);
      const judgedKeys = new Set(judged.map(p => p.entry.startedAt));
      for (const key of Object.keys(state.scores)) {
        if (!judgedKeys.has(key)) {
          delete state.scores[key];
          dirty = true;
        }
      }
      if (learned.pending === 0) {
        const corpus: LogCorpus = { currentRun: () => ctx.logs.currentRun(), pastRuns: (limit) => past.slice(0, limit) };
        let spent = 0;
        for (const run of judged) {
          const key = run.entry.startedAt;
          if (state.scores[key] !== undefined) {
            continue;
          }
          const size = run.reader.size?.() ?? 0;
          if (spent > 0 && spent + size > evalBudget) {
            break;
          }
          spent += size;
          const replay = replayJob({
            job: ctx.job,
            configDir: ctx.configDir,
            corpus,
            strategies: MEMBER_IDS.map(id => members[id]),
            sampleEveryPercent: REPLAY_STEP_PERCENT,
            maxRuns: PAST_WINDOW,
            evaluate: (entry) => entry.startedAt === key,
            stores: { 'log-learned': learnedStore },
          });
          const score: Partial<Record<MemberId, MemberScore>> = {};
          for (const id of MEMBER_IDS) {
            const samples = replay.strategies[id]!.samples;
            const withError = samples.filter(s => s.errorPct !== null);
            score[id] = {
              samples: samples.length,
              covered: withError.length,
              sumPct: withError.reduce((a, s) => a + s.errorPct!, 0),
              sumSec: withError.reduce((a, s) => a + s.errorMs! / 1000, 0),
            };
          }
          state.scores[key] = score;
          dirty = true;
        }
      }
      if (dirty) {
        ctx.store.write(state, { learnedFromRuns: Object.keys(state.learned.runs) });
      }

      // 3. Rank the members on what was judged.
      const scored = Object.values(state.scores);
      const judgedCount = scored.length;
      const wanted = judged.length;
      if (judgedCount < Math.min(ENSEMBLE_MIN_EVALUATED, wanted)) {
        const progress = `${Object.keys(state.learned.runs).length} of ${n} past logs read, ${judgedCount} of ${wanted} runs replayed`;
        if (gate) {
          return none(`ensemble: comparing strategies (${progress}); history meanwhile`, { usableRuns: n, provisional: true });
        }
        const h = historyStrategy.estimate(ctx);
        return wrap(h, 'history', `ensemble: history (comparing strategies (${progress}); history meanwhile): ${h.reason}`, { usableRuns: n, provisional: true });
      }

      const table: Partial<Record<MemberId, { maePct: number; maeSec: number; coverage: number }>> = {};
      for (const id of MEMBER_IDS) {
        const sum = scored.reduce((a, s) => {
          const m = s[id];
          return m ? { samples: a.samples + m.samples, covered: a.covered + m.covered, sumPct: a.sumPct + m.sumPct, sumSec: a.sumSec + m.sumSec } : a;
        }, { samples: 0, covered: 0, sumPct: 0, sumSec: 0 });
        if (sum.covered > 0 && sum.covered / sum.samples >= MIN_COVERAGE) {
          table[id] = { maePct: sum.sumPct / sum.covered, maeSec: sum.sumSec / sum.covered, coverage: sum.covered / sum.samples };
        }
      }
      const eligible = MEMBER_IDS.filter(id => table[id] !== undefined);
      const best = Math.min(...eligible.map(id => table[id]!.maePct));
      // Pick order: the best, ties (within the margin) in priority order, then the rest by error.
      const order = [
        ...eligible.filter(id => table[id]!.maePct <= best + TIE_MARGIN),
        ...eligible.filter(id => table[id]!.maePct > best + TIE_MARGIN).sort((a, b) => table[a]!.maePct - table[b]!.maePct),
      ];
      const first = order[0];
      if (first === undefined) {
        return none('ensemble: no member strategy had enough estimates on the replayed runs; use history: orch edit <id> --progress history', { usableRuns: n });
      }
      const errors = (ids: readonly MemberId[]): string => ids.map(id => `${id} ${percent(table[id]!.maePct)}`).join(', ');
      const membersDetail = Object.fromEntries(eligible.map(id => [id, table[id]!]));

      if (gate && first === 'history') {
        return none(
          `ensemble: history has the lowest replay error (${errors(eligible)} over ${judgedCount} runs): nothing better than history to offer`,
          { usableRuns: n, chosen: 'history', members: membersDetail });
      }

      // 4. Ask the pick; if it has nothing to say now, the next one.
      const skipped: string[] = [];
      for (const id of order) {
        const store = id === 'log-learned' ? learnedStore : memoryStore();
        const e = members[id].estimate({ ...ctx, options: undefined, store });
        if (e.progress === null || e.confidence === 'none') {
          skipped.push(`${id} skipped: ${e.reason}`);
          continue;
        }
        if (gate && id === 'history') {
          return none(`ensemble: ${skipped.join('; ')}; history is the next candidate`, { usableRuns: n, members: membersDetail });
        }
        const others = eligible.filter(o => o !== id);
        const score = clamp01(1 - 3 * table[id]!.maePct);
        const level = judgedCount < 3 ? 'low' as const : levelOfScore(score);
        const head = `${id} (replay error ${percent(table[id]!.maePct)} of the run over ${judgedCount} runs${others.length > 0 ? `; ${errors(others)}` : ''}${skipped.length > 0 ? `; ${skipped.join('; ')}` : ''})`;
        return {
          ...wrap(e, id, `ensemble: ${head}: ${e.reason}`, { members: membersDetail, replayedRuns: judgedCount, usableRuns: n }),
          confidence: level,
          confidenceScore: score,
        };
      }
      return none(`ensemble: every member strategy is without an estimate now (${skipped.join('; ')})`, { usableRuns: n, members: membersDetail });
    },
  };
}

/** Explicit `--progress ensemble`: answers even when it only has history to offer. */
export const ensembleStrategy: ProgressStrategy = createEnsembleStrategy();
/** The `auto` candidate: answers only when a member beats history. Same id and version, so it shares the stored comparison. */
export const autoEnsembleStrategy: ProgressStrategy = createEnsembleStrategy({ gate: true });
