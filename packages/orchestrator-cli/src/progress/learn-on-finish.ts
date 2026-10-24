import type { Job, RuntimeEntry } from '../types.js';
import { getErrorMessage } from '../fsUtil.js';
import { isLongRunning } from '../long-running.js';
import type { TimeService, Timer } from '../time-service.js';
import type { JsonWriter } from './async-writer.js';
import { createLogCorpus } from './log-corpus.js';
import { AUTO_STRATEGIES, STRATEGIES } from './registry.js';
import { resolveProgressSetting } from './setting.js';
import { openProgressFile } from './store.js';
import type { ProgressStrategy } from './types.js';

/*
 * Learning when a run ends (plan section 5). The strategies that learn from logs (log-learned, ensemble) used to do
 * it at the first get-progress after a run, on the request path. This reads the logs of the runs that ended right
 * after the end instead, so that first request finds nothing left to learn.
 *
 * The lazy path stays: a daemon that was down when the run ended never saw the event, and learning is idempotent
 * (a run already learned, by startedAt, is skipped), so both paths can run on the same run.
 *
 * Bounded: the 20 newest usable runs, the strategy's byte budget per pass, a byte cap per log (log-corpus), and one
 * pass per job however many events arrive. It runs on a timer, off the scheduler's finishing code, and never throws.
 */

/** Wait after the end: lets the run's last log lines reach the disk, and keeps the work off the finishing path. */
export const LEARN_DELAY_MS = 1000;

/** The run being learned from has ended: no open run exists, so the corpus is given a start that matches none. */
const NO_OPEN_RUN = '9999-12-31T23:59:59.000Z';

export interface LearnFinishedRunInput {
  configDir: string;
  job: Job;
  /** The run history of the job, the run that ended included. */
  history: readonly RuntimeEntry[];
  now(): Date;
  log: (line: string) => void;
  writer?: JsonWriter;
}

/** The strategies that learn from the logs, for what the job's `progress` setting makes it use. */
function learners(job: Job): ProgressStrategy[] {
  const setting = resolveProgressSetting(job.progress);
  if (setting.kind === 'off' || isLongRunning(job)) {
    return [];
  }
  const candidates = setting.kind === 'auto' ? AUTO_STRATEGIES : STRATEGIES.filter(s => s.id === setting.id);
  return candidates.filter(s => s.learn !== undefined);
}

/** Whether a finished run of `job` can be learned from at all (cheap: no disk). */
export function learnsFromFinish(job: Job): boolean {
  return learners(job).length > 0;
}

/** Learns from the logs of the runs that ended. May throw (a corrupt log directory, say): the caller reports it. */
export function learnFinishedRun(input: LearnFinishedRunInput): { strategies: string[]; learnedRuns: number } {
  const strategies = learners(input.job);
  if (strategies.length === 0) {
    return { strategies: [], learnedRuns: 0 };
  }
  const file = openProgressFile({
    configDir: input.configDir, jobId: input.job.id, job: input.job, log: input.log, ...(input.writer ? { writer: input.writer } : {}),
  });
  const logs = createLogCorpus({ configDir: input.configDir, jobId: input.job.id, history: input.history, currentStartedAt: NO_OPEN_RUN });
  let learnedRuns = 0;
  for (const strategy of strategies) {
    learnedRuns += strategy.learn!({ job: input.job, configDir: input.configDir, history: input.history, logs, now: input.now, store: file.storeFor(strategy) });
  }
  return { strategies: strategies.map(s => s.id), learnedRuns };
}

interface FinishedEvent {
  id: string;
  job: Job;
  exitCode: number | null;
  skipped?: boolean;
  cancelledByUser?: boolean;
}

export interface LearnOnFinishWiring {
  /** The scheduler: emits 'job-finished' for every run that ends, also for one the daemon learned of late. */
  source: { on(event: 'job-finished', listener: (ev: FinishedEvent) => void): unknown; off(event: 'job-finished', listener: (ev: FinishedEvent) => void): unknown };
  state: { getAll(): Readonly<Record<string, readonly RuntimeEntry[]>> };
  configDir: string;
  time: TimeService;
  log: (line: string) => void;
  writer?: JsonWriter;
  delayMs?: number;
}

/** Subscribes to the end of runs. `dispose` unsubscribes and cancels what is scheduled. */
export function wireLearnOnFinish(wiring: LearnOnFinishWiring): { dispose(): void } {
  const delayMs = wiring.delayMs ?? LEARN_DELAY_MS;
  const pending = new Map<string, Timer>();

  const onFinished = (ev: FinishedEvent): void => {
    // Only a run that succeeded is a usable run (history-strategy isUsableRun): nothing to learn from the others.
    if (ev.exitCode !== 0 || ev.skipped === true || ev.cancelledByUser === true || pending.has(ev.id) || !learnsFromFinish(ev.job)) {
      return;
    }
    pending.set(ev.id, wiring.time.after(delayMs, () => {
      pending.delete(ev.id);
      try {
        learnFinishedRun({
          configDir: wiring.configDir,
          job: ev.job,
          history: wiring.state.getAll()[ev.id] ?? [],
          now: () => new Date(wiring.time.now()),
          log: wiring.log,
          ...(wiring.writer ? { writer: wiring.writer } : {}),
        });
      } catch (err) {
        wiring.log(`[progress] job ${ev.id}: learning from the finished run failed (${getErrorMessage(err)}); the first get-progress learns it instead`);
      }
    }));
  };

  wiring.source.on('job-finished', onFinished);
  return {
    dispose() {
      wiring.source.off('job-finished', onFinished);
      for (const timer of pending.values()) {
        timer.cancel();
      }
      pending.clear();
    },
  };
}
