import nodeFs from 'node:fs';
import path from 'node:path';
import { telemetryPath, rotatedPath } from './job-telemetry.js';
import { resourceHistoryPath } from './resource-history.js';
import { progressFilePath } from './progress/store.js';
import { getErrorMessage } from './fsUtil.js';

/** The file operations this module needs, so a test can make one path fail the way a locked file does on Windows. */
export type JobDataFs = Pick<typeof nodeFs, 'existsSync' | 'readFileSync' | 'readdirSync' | 'rmSync' | 'rmdirSync'>;

/** Same rule as registry.add, the logs route and the telemetry files: an id becomes a file name, so it cannot carry a path. */
const JOB_ID_RE = /^[a-z0-9-]+$/i;

export interface JobDataLeftover {
  path:   string;
  reason: string;
}

export interface JobDataCleanup {
  /** How many items of each kind were deleted. Counts only: the audit trail must not carry paths. */
  cleaned:   { telemetry: number; resourceHistory: number; progress: number; runs: number };
  /** What could not be deleted, and why. Empty when everything that had to go went. */
  leftovers: JobDataLeftover[];
}

export interface JobDataOptions {
  fs?: JobDataFs;
  /**
   * The job has a run in progress. The files that run is writing stay (deleting them would fail on Windows,
   * or be undone by the run's next write) and are reported as leftovers: the next add under this id drops them.
   */
  running?: boolean | (() => boolean);
}

function empty(): JobDataCleanup {
  return { cleaned: { telemetry: 0, resourceHistory: 0, progress: 0, runs: 0 }, leftovers: [] };
}

function refuse(jobId: string): JobDataCleanup {
  const result = empty();
  result.leftovers.push({
    path:   '',
    reason: `${JSON.stringify(jobId)} is not a valid job id (letters, digits and "-" only), nothing was deleted`,
  });
  return result;
}

/** Deletes one file if it exists; a failure is recorded, never thrown. Returns whether it is gone. */
function dropFile(fs: JobDataFs, file: string, result: JobDataCleanup): boolean {
  try {
    if (!fs.existsSync(file)) {
      return false;
    }
    fs.rmSync(file, { force: true });
    return true;
  } catch (err) {
    result.leftovers.push({ path: file, reason: getErrorMessage(err) });
    return false;
  }
}

function dropDerivedFiles(configDir: string, jobId: string, fs: JobDataFs, running: boolean | (() => boolean), result: JobDataCleanup): void {
  const telemetry = [telemetryPath(configDir, jobId), rotatedPath(configDir, jobId)];
  const history   = [resourceHistoryPath(configDir, jobId)];
  history.push(`${history[0]}.tmp`);
  const learned   = [progressFilePath(configDir, jobId)];
  learned.push(`${learned[0]}.tmp`);
  // Asked only when there is something to delete, so a caller can make the question expensive.
  if ([...telemetry, ...history, ...learned].every((f) => !fs.existsSync(f))) {
    return;
  }
  if (typeof running === 'function' ? running() : running) {
    for (const [kind, files] of [['telemetry', telemetry], ['resource history', history], ['progress data', learned]] as const) {
      const present = files.filter((f) => fs.existsSync(f));
      for (const file of present) {
        result.leftovers.push({ path: file, reason: `the job is still running, its ${kind} is written by the run in progress` });
      }
    }
    return;
  }
  for (const file of telemetry) {
    if (dropFile(fs, file, result)) {
      result.cleaned.telemetry++;
    }
  }
  for (const file of history) {
    if (dropFile(fs, file, result)) {
      result.cleaned.resourceHistory++;
    }
  }
  for (const file of learned) {
    if (dropFile(fs, file, result)) {
      result.cleaned.progress++;
    }
  }
}

/** Deletes the run folders that are finished; one whose supervisor still says `running` is never touched. */
function dropFinishedRuns(configDir: string, jobId: string, fs: JobDataFs, result: JobDataCleanup): void {
  const root = path.join(configDir, 'runs', jobId);
  let names: string[];
  try {
    names = fs.readdirSync(root);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      result.leftovers.push({ path: root, reason: getErrorMessage(err) });
    }
    return;
  }
  let kept = 0;
  for (const name of names) {
    const dir = path.join(root, name);
    let finished = fs.existsSync(path.join(dir, 'done'));
    if (!finished) {
      const statusFile = path.join(dir, 'status.json');
      try {
        const status = JSON.parse(String(fs.readFileSync(statusFile, 'utf8'))) as { state?: unknown };
        if (status.state === 'running') {
          // The supervisor may be alive: the normal path cleans it once it ends.
          kept++;
          continue;
        }
        finished = typeof status.state === 'string';
      } catch (err) {
        result.leftovers.push({ path: statusFile, reason: `status.json cannot be read (${getErrorMessage(err)}), the run folder is left in place` });
        kept++;
        continue;
      }
      if (!finished) {
        result.leftovers.push({ path: statusFile, reason: 'status.json has no state, the run folder is left in place' });
        kept++;
        continue;
      }
    }
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      result.cleaned.runs++;
    } catch (err) {
      result.leftovers.push({ path: dir, reason: getErrorMessage(err) });
      kept++;
    }
  }
  if (kept === 0) {
    try {
      fs.rmdirSync(root);
    } catch (err) {
      result.leftovers.push({ path: root, reason: getErrorMessage(err) });
    }
  }
}

/** The job's default cwd under <configDir>/tmp, only when nothing is in it: anything in it is the job's own output. */
function dropEmptyTmp(configDir: string, jobId: string, fs: JobDataFs, running: () => boolean, result: JobDataCleanup): void {
  const dir = path.join(configDir, 'tmp', jobId);
  try {
    // A run in progress uses it as its cwd: it stays even when empty.
    if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0 && !running()) {
      fs.rmdirSync(dir);
    }
  } catch (err) {
    result.leftovers.push({ path: dir, reason: getErrorMessage(err) });
  }
}

/**
 * What removing a job deletes: the data derived from its runs (telemetry, resource history, learned progress data, finished run
 * folders, an empty default cwd). Its logs stay: they are the record of what the job did and age out on
 * their own. A failure on one path is reported in `leftovers` and the rest carries on, since a locked
 * file must not fail the removal.
 */
export function removeJobData(configDir: string, jobId: string, options: JobDataOptions = {}): JobDataCleanup {
  if (typeof jobId !== 'string' || !JOB_ID_RE.test(jobId)) {
    return refuse(jobId);
  }
  const fs = options.fs ?? nodeFs;
  const result = empty();
  // Asked at most once, and only when something needs the answer: the derived files and the tmp folder must agree on it,
  // and a caller may make the question expensive.
  const source = options.running ?? false;
  let answer: boolean | undefined;
  const running = (): boolean => (answer ??= typeof source === 'function' ? source() : source);
  dropDerivedFiles(configDir, jobId, fs, running, result);
  dropFinishedRuns(configDir, jobId, fs, result);
  dropEmptyTmp(configDir, jobId, fs, running, result);
  return result;
}

/**
 * For a job being ADDED: drops the telemetry and resource history an older version or a crash left under
 * its id, so the new job does not inherit another job's past.
 */
export function dropStaleJobData(configDir: string, jobId: string, options: JobDataOptions = {}): JobDataCleanup {
  if (typeof jobId !== 'string' || !JOB_ID_RE.test(jobId)) {
    return refuse(jobId);
  }
  const result = empty();
  dropDerivedFiles(configDir, jobId, options.fs ?? nodeFs, options.running ?? false, result);
  return result;
}
