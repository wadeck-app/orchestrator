import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { atomicWriteJson, getErrorMessage } from '../fsUtil.js';
import type { Job } from '../types.js';
import type { StoreMeta, StrategyStore } from './types.js';

/*
 * <configDir>/progress/<jobId>.json: what the strategies learned about a job, and which strategy `auto` chose for
 * the open run. All of it is derived from the logs and the run history and can be rebuilt, so this module never
 * throws into the estimate: an unreadable file is reported and replaced, a failed write is reported and skipped.
 * Every drop writes a "[progress] job <id>: dropped learned ..." line through `log`.
 */

export const PROGRESS_FILE_SCHEMA = 1;

interface StrategyEntry {
  strategyVersion: number;
  logFingerprint?: string;
  learnedFromRuns?: string[];
  data: unknown;
}

interface ProgressFileContent {
  schema: number;
  jobId: string;
  /** Hash of the command, cwd and progress setting the data was learned under. */
  configHash: string;
  strategies: Record<string, StrategyEntry>;
  chosen?: { runStartedAt: string; strategyId: string; chosenAt: string };
}

export function progressFilePath(configDir: string, jobId: string): string {
  return path.join(configDir, 'progress', `${jobId}.json`);
}

function configHashOf(job: Pick<Job, 'command' | 'cwd' | 'progress'>): string {
  return createHash('sha1').update(JSON.stringify([job.command, job.cwd ?? null, job.progress ?? null])).digest('hex').slice(0, 16);
}

export interface OpenProgressFileInput {
  configDir: string;
  jobId: string;
  job: Pick<Job, 'command' | 'cwd' | 'progress'>;
  log: (line: string) => void;
}

export interface ProgressFile {
  storeFor(strategy: { id: string; version: number }): StrategyStore;
  chosen(runStartedAt: string): { strategyId: string; chosenAt: string } | undefined;
  setChosen(runStartedAt: string, strategyId: string, at: Date): void;
}

export function openProgressFile(input: OpenProgressFileInput): ProgressFile {
  const file = progressFilePath(input.configDir, input.jobId);
  const hash = configHashOf(input.job);
  const prefix = `[progress] job ${input.jobId}:`;
  const fresh = (): ProgressFileContent => ({ schema: PROGRESS_FILE_SCHEMA, jobId: input.jobId, configHash: hash, strategies: {} });

  const load = (): ProgressFileContent => {
    let raw: string;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (err) {
      // ENOTDIR: a file stands where the progress folder should be (Linux and macOS say that, Windows says ENOENT).
      // Nothing was learned there yet; the failed save that follows is the only thing worth a log line.
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        return fresh();
      }
      input.log(`${prefix} learned data file unreadable (${getErrorMessage(err)}); it is rebuilt from the logs and the run history`);
      return fresh();
    }
    let parsed: ProgressFileContent;
    try {
      parsed = JSON.parse(raw) as ProgressFileContent;
    } catch (err) {
      input.log(`${prefix} learned data file unreadable (${getErrorMessage(err)}); it is rebuilt from the logs and the run history`);
      return fresh();
    }
    if (parsed === null || typeof parsed !== 'object' || parsed.schema !== PROGRESS_FILE_SCHEMA
      || typeof parsed.strategies !== 'object' || parsed.strategies === null) {
      input.log(`${prefix} learned data file unreadable (schema ${String((parsed as { schema?: unknown } | null)?.schema)}, expected ${PROGRESS_FILE_SCHEMA}); it is rebuilt from the logs and the run history`);
      return fresh();
    }
    if (parsed.configHash !== hash) {
      input.log(`${prefix} dropped learned data: the command, cwd or progress setting of the job changed`);
      return fresh();
    }
    return parsed;
  };

  let content: ProgressFileContent | undefined;
  const get = (): ProgressFileContent => (content ??= load());

  const save = (what: string): void => {
    try {
      atomicWriteJson(file, get());
    } catch (err) {
      input.log(`${prefix} could not save learned ${what} (${getErrorMessage(err)}): the estimate continues without it`);
    }
  };

  return {
    storeFor(strategy) {
      const entry = (): StrategyEntry | undefined => {
        const e = get().strategies[strategy.id];
        if (e && e.strategyVersion !== strategy.version) {
          input.log(`${prefix} dropped learned ${strategy.id} data: strategy version changed (${e.strategyVersion} -> ${strategy.version})`);
          delete get().strategies[strategy.id];
          return undefined;
        }
        return e;
      };
      return {
        read: () => entry()?.data,
        meta: (): StoreMeta | undefined => {
          const e = entry();
          if (!e) {
            return undefined;
          }
          return {
            ...(e.logFingerprint !== undefined ? { logFingerprint: e.logFingerprint } : {}),
            ...(e.learnedFromRuns !== undefined ? { learnedFromRuns: e.learnedFromRuns } : {}),
          };
        },
        write(data, meta) {
          get().strategies[strategy.id] = {
            strategyVersion: strategy.version,
            ...(meta?.logFingerprint !== undefined ? { logFingerprint: meta.logFingerprint } : {}),
            ...(meta?.learnedFromRuns !== undefined ? { learnedFromRuns: meta.learnedFromRuns } : {}),
            data,
          };
          save(`${strategy.id} data`);
        },
        invalidate(reason) {
          if (get().strategies[strategy.id] === undefined) {
            return;
          }
          input.log(`${prefix} dropped learned ${strategy.id} data: ${reason}`);
          delete get().strategies[strategy.id];
          save(`${strategy.id} data`);
        },
      };
    },

    chosen(runStartedAt) {
      const c = get().chosen;
      return c && c.runStartedAt === runStartedAt ? { strategyId: c.strategyId, chosenAt: c.chosenAt } : undefined;
    },

    setChosen(runStartedAt, strategyId, at) {
      const c = get().chosen;
      if (c && c.runStartedAt === runStartedAt && c.strategyId === strategyId) {
        return;
      }
      get().chosen = { runStartedAt, strategyId, chosenAt: at.toISOString() };
      save('choice');
    },
  };
}
