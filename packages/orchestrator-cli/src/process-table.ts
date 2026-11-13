import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { killTree } from './process-tree.js';

/*
 * The daemon measures the CPU and RAM of every running job's process tree. pidusage and pidtree answer that with one
 * process start per question; on a Windows without WMIC (11 24H2 and later) each one is a PowerShell, nothing ends
 * it when it hangs, and a job with ten processes cost eleven of them every sample.
 *
 * Here the whole process table is read with ONE query, the answer is shared by every job asking within a second, no
 * two queries ever run at once, and a query that does not return is ended with its children. Windows only: the other
 * platforms read /proc or run one `ps`, which pidtree and pidusage already do.
 */

/** One process, as the table lists it. Times are what the OS reports: CPU in units of 100 ns, start as ms since the epoch (0 when unknown). */
export interface ProcRow {
  pid: number;
  ppid: number;
  cpu100ns: number;
  rssBytes: number;
  startedAtMs: number;
}

/** What sampleProcessTree reads of one process (the part of pidusage's answer it uses). */
export interface ProcUsage {
  /** CPU percent of one core, summed over cores like pidusage (can exceed 100). */
  cpu: number;
  memory: number;
  elapsed: number;
  ppid: number;
  timestamp: number;
}

const WMIC_COLUMNS = ['CreationDate', 'KernelModeTime', 'ParentProcessId', 'ProcessId', 'UserModeTime', 'WorkingSetSize'] as const;

/** "20261113130000.500000+060" (local time and its offset from UTC in minutes) as ms since the epoch; '' is 0. */
export function wmicDateToMs(text: string): number {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\.(\d{3})\d{3}([+-]\d{3})$/.exec(text.trim());
  if (m === null) {
    return 0;
  }
  const [, y, mo, d, h, mi, s, ms, off] = m;
  return Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s), Number(ms)) - Number(off) * 60_000;
}

/** The output of `wmic process get ... /format:csv`: columns are found by their name, blank lines and CR CR LF endings ignored. */
export function parseWmicCsv(text: string): ProcRow[] {
  const lines = text.split(/\r*\n/).map((l) => l.trim()).filter((l) => l !== '');
  const header = (lines[0] ?? '').split(',');
  const index = new Map(header.map((name, i) => [name.trim(), i]));
  for (const column of WMIC_COLUMNS) {
    if (!index.has(column)) {
      throw new Error(
        `wmic printed no "${column}" column (it printed: ${lines[0] ?? 'nothing'}). Check: wmic process get ${WMIC_COLUMNS.join(',')} /format:csv`,
      );
    }
  }
  const at = (cells: string[], name: string): string => (cells[index.get(name)!] ?? '').trim();
  const rows: ProcRow[] = [];
  for (const line of lines.slice(1)) {
    const cells = line.split(',');
    if (cells.length < header.length) {
      continue;
    }
    rows.push({
      pid: Number(at(cells, 'ProcessId')),
      ppid: Number(at(cells, 'ParentProcessId')),
      cpu100ns: Number(at(cells, 'KernelModeTime')) + Number(at(cells, 'UserModeTime')),
      rssBytes: Number(at(cells, 'WorkingSetSize')),
      startedAtMs: wmicDateToMs(at(cells, 'CreationDate')),
    });
  }
  return rows;
}

/** The rows printed by POWERSHELL_LOOP: "pid ppid cpu rss startMs" per line. */
export function parsePowerShellRows(text: string): ProcRow[] {
  const rows: ProcRow[] = [];
  for (const raw of text.split(/\r*\n/)) {
    const line = raw.trim();
    if (line === '') {
      continue;
    }
    const m = /^(\d+) (\d+) (\d+) (\d+) (\d+)$/.exec(line);
    if (m === null) {
      throw new Error(`the PowerShell process query printed something unexpected: ${text.trim().slice(0, 200)}`);
    }
    rows.push({ pid: Number(m[1]), ppid: Number(m[2]), cpu100ns: Number(m[3]), rssBytes: Number(m[4]), startedAtMs: Number(m[5]) });
  }
  return rows;
}

/**
 * The loop of the long-lived PowerShell: one line in per question, the rows and the end marker out. It ends at end of
 * input, so a daemon that is gone takes it with it.
 */
const POWERSHELL_LOOP = [
  '$ProgressPreference = \'SilentlyContinue\'',
  'while ($null -ne [Console]::In.ReadLine()) {',
  '  try {',
  '    Get-CimInstance -ClassName Win32_Process | ForEach-Object {',
  '      $c = if ($_.CreationDate) { ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() } else { 0 }',
  '      \'{0} {1} {2} {3} {4}\' -f $_.ProcessId, $_.ParentProcessId, ([long]$_.KernelModeTime + [long]$_.UserModeTime), [long]$_.WorkingSetSize, $c',
  '    }',
  '  } catch {',
  '    \'##ERR \' + ($_.Exception.Message -replace \'\\r?\\n\', \' \')',
  '  }',
  '  \'##END\'',
  '}',
].join('\n');

export interface RunOptions {
  timeoutMs: number;
  /** What is being run, for the error: "the process table query". */
  what: string;
  /** Called with the pid of the child, for the tests that check it is gone. */
  onSpawn?: (pid: number) => void;
}

/**
 * Runs a command and returns its stdout. One that does not finish within the timeout is ended with its children
 * (killTree), so a hung query is a rejection that names what to do, never a process left behind.
 */
export function runCommand(cmd: string, args: string[], options: RunOptions): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    if (child.pid !== undefined) {
      options.onSpawn?.(child.pid);
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const settle = (fn: () => void): void => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        fn();
      }
    };
    const timer = setTimeout(() => {
      settle(() => {
        if (child.pid !== undefined) {
          void killTree(child.pid);
        }
        reject(new Error(
          `${options.what} did not finish within ${options.timeoutMs / 1000} s and was ended (${cmd}). `
          + 'The machine is probably overloaded; the job monitoring skips this measurement and tries again at the next sample.',
        ));
      });
    }, options.timeoutMs);
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.once('error', (err) => {
      settle(() => reject(new Error(`${options.what}: could not start ${cmd}: ${err.message}`)));
    });
    child.once('close', (code) => {
      settle(() => {
        if (code === 0) {
          resolve(stdout);
        } else {
          reject(new Error(`${options.what} (${cmd}) ended with exit code ${String(code)}: ${stderr.trim().slice(0, 300) || 'no message'}`));
        }
      });
    });
  });
}

export interface LineWorkerOptions {
  cmd: string;
  args: string[];
  /** What is asked, for the errors: "the process table query (PowerShell)". */
  what: string;
  /** An answer that takes longer ends the worker; the next query starts a new one. */
  timeoutMs: number;
  /** A worker nobody asks for during this long is ended (its stdin is closed); the next query starts a new one. */
  idleMs: number;
  onSpawn?: (pid: number) => void;
}

const END_MARKER = '##END';
const ERROR_PREFIX = '##ERR ';
/** After its stdin is closed a worker has this long to end by itself before it is ended. */
const EXIT_GRACE_MS = 3000;

/**
 * One long-lived child answering one question per line on its stdin with lines on its stdout, then the end marker.
 * Starting a PowerShell per question is what took 30-40 s on a loaded machine (and left a conhost.exe each time): here it
 * is started once. It never has two questions at a time, is ended when it hangs (killTree, so no process is left behind), when
 * nobody asks for a while, and when the daemon goes (its stdin closes and the child ends at end of input).
 */
export class LineWorker {
  private readonly _o: LineWorkerOptions;
  private _child: ChildProcess | null = null;
  private _idleTimer: NodeJS.Timeout | null = null;
  private _tail: Promise<unknown> = Promise.resolve();

  constructor(options: LineWorkerOptions) {
    this._o = options;
  }

  /** The lines the worker printed before its end marker. Questions asked together are answered one after the other. */
  query(): Promise<string[]> {
    const answer = this._tail.then(() => this._ask(), () => this._ask());
    this._tail = answer.catch(() => undefined);
    return answer;
  }

  /** Ends the worker now. */
  async dispose(): Promise<void> {
    this._clearIdle();
    const child = this._child;
    this._child = null;
    if (child?.pid !== undefined) {
      await killTree(child.pid);
    }
  }

  private _clearIdle(): void {
    if (this._idleTimer !== null) {
      clearTimeout(this._idleTimer);
      this._idleTimer = null;
    }
  }

  private _armIdle(child: ChildProcess): void {
    this._clearIdle();
    this._idleTimer = setTimeout(() => {
      this._idleTimer = null;
      if (this._child === child) {
        this._child = null;
        child.stdin?.end();
        const force = setTimeout(() => { if (child.pid !== undefined) { void killTree(child.pid); } }, EXIT_GRACE_MS);
        force.unref();
        child.once('close', () => clearTimeout(force));
      }
    }, this._o.idleMs);
    this._idleTimer.unref();
  }

  private _start(): ChildProcess {
    const child = spawn(this._o.cmd, this._o.args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    if (child.pid !== undefined) {
      this._o.onSpawn?.(child.pid);
    }
    // A write to a worker that has just died is reported by the question that was waiting, not as an unhandled error.
    child.stdin?.on('error', () => undefined);
    child.stderr?.on('data', () => undefined);
    // Between two questions nothing here may keep the daemon alive (a detached daemon must exit by itself): the child and its pipes
    // are not counted by the event loop. A question in progress is: its timeout timer is.
    child.unref();
    for (const pipe of [child.stdin, child.stdout, child.stderr]) {
      (pipe as unknown as { unref?: () => void } | null)?.unref?.();
    }
    this._child = child;
    return child;
  }

  private _ask(): Promise<string[]> {
    this._clearIdle();
    const child = this._child ?? this._start();
    const { what, cmd, timeoutMs } = this._o;
    return new Promise<string[]>((resolve, reject) => {
      const lines: string[] = [];
      let failure: string | null = null;
      let partial = '';
      let settled = false;
      const forget = (): void => {
        if (this._child === child) {
          this._child = null;
        }
      };
      const finish = (fn: () => void): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        child.stdout?.off('data', onData);
        child.off('close', onClose);
        child.off('error', onError);
        fn();
      };
      const timer = setTimeout(() => {
        finish(() => {
          forget();
          if (child.pid !== undefined) {
            void killTree(child.pid);
          }
          reject(new Error(
            `${what} did not answer within ${timeoutMs / 1000} s and the worker was ended (${cmd}). `
            + 'The machine is probably overloaded; the job monitoring skips this measurement and tries again at the next sample.',
          ));
        });
      }, timeoutMs);
      const onData = (d: Buffer): void => {
        partial += d.toString();
        const parts = partial.split(/\r*\n/);
        partial = parts.pop() ?? '';
        for (const raw of parts) {
          const line = raw.trim();
          if (line === END_MARKER) {
            finish(() => {
              this._armIdle(child);
              if (failure === null) {
                resolve(lines);
              } else {
                reject(new Error(`${what}: ${failure}`));
              }
            });
            return;
          }
          if (line.startsWith(ERROR_PREFIX)) {
            failure = line.slice(ERROR_PREFIX.length);
          } else if (line !== '') {
            lines.push(line);
          }
        }
      };
      const onClose = (code: number | null): void => {
        finish(() => {
          forget();
          reject(new Error(`${what}: the worker ended with exit code ${String(code)} while answering (${cmd})`));
        });
      };
      const onError = (err: Error): void => {
        finish(() => {
          forget();
          reject(new Error(`${what}: could not start ${cmd}: ${err.message}`));
        });
      };
      child.stdout?.on('data', onData);
      child.once('close', onClose);
      child.once('error', onError);
      child.stdin?.write('q\n');
    });
  }
}

/** How a Windows process table is read: wmic when the machine has it (lighter), PowerShell otherwise. */
export type TableBackend = 'wmic' | 'powershell';

export interface WindowsReader {
  read: () => Promise<ProcRow[]>;
  /** The backend of the last read (the one that will be used next). */
  backend: () => TableBackend;
  /** Ends the PowerShell worker, if one is running. */
  dispose: () => Promise<void>;
}

/**
 * A query on a loaded machine has taken 30-40 s (measured by the agent of a second machine), so this only ends one that
 * is stuck. Queries never overlap (ProcessTable), so a slow one delays the measurements instead of piling up.
 */
const QUERY_TIMEOUT_MS = 60_000;
/** The PowerShell worker is ended after this long without a question (the sampling asks every few seconds while a job runs). */
const WORKER_IDLE_MS = 60_000;

/**
 * wmic is in System32\wbem until Windows 11 24H2 removed it. ORCH_PROCESS_TABLE=powershell pretends it is not there: how a
 * machine that has WMIC checks what one without it does (the tests, a diagnosis).
 */
export function wmicInstalled(): boolean {
  if (process.env['ORCH_PROCESS_TABLE'] === 'powershell') {
    return false;
  }
  return fs.existsSync(path.join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'wbem', 'WMIC.exe'));
}

export function createWindowsReader(
  options: { hasWmic?: () => boolean; run?: typeof runCommand; worker?: Pick<LineWorker, 'query' | 'dispose'>; onFallback?: (message: string) => void } = {},
): WindowsReader {
  const run = options.run ?? runCommand;
  let backend: TableBackend = (options.hasWmic ?? wmicInstalled)() ? 'wmic' : 'powershell';
  const worker = options.worker ?? new LineWorker({
    cmd: 'powershell.exe',
    args: ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(POWERSHELL_LOOP, 'utf16le').toString('base64')],
    what: 'the process table query (PowerShell)',
    timeoutMs: QUERY_TIMEOUT_MS,
    idleMs: WORKER_IDLE_MS,
  });
  const viaPowerShell = async (): Promise<ProcRow[]> => parsePowerShellRows((await worker.query()).join('\n'));
  return {
    backend: () => backend,
    dispose: () => worker.dispose(),
    read: async () => {
      if (backend === 'powershell') {
        return viaPowerShell();
      }
      try {
        return parseWmicCsv(await run(
          'wmic', ['process', 'get', WMIC_COLUMNS.join(','), '/format:csv'],
          { timeoutMs: QUERY_TIMEOUT_MS, what: 'the process table query (wmic)' },
        ));
      } catch (err) {
        // A wmic that cannot start is one that was removed after we looked: PowerShell from now on, said once.
        if (err instanceof Error && /could not start/.test(err.message)) {
          backend = 'powershell';
          options.onFallback?.(`wmic is not available any more (${err.message}); the job monitoring uses PowerShell from now on`);
          return viaPowerShell();
        }
        throw err;
      }
    },
  };
}

interface Snapshot {
  takenAt: number;
  byPid: Map<number, ProcRow>;
  children: Map<number, number[]>;
  /** The snapshot before this one, for the CPU change; null for the first. */
  previous: Snapshot | null;
}

export interface TableStats {
  /** Queries started (the process starts of the whole job monitoring). */
  reads: number;
  failures: number;
  lastReadMs: number | null;
  lastError: string | null;
}

export interface ProcessTableOptions {
  read: () => Promise<ProcRow[]>;
  now: () => number;
  /**
   * A snapshot younger than this answers every question; the jobs sampling in the same second share one query. Never
   * less than the time the last query took.
   */
  ttlMs: number;
}

export class ProcessTable {
  private readonly _read: () => Promise<ProcRow[]>;
  private readonly _now: () => number;
  private readonly _ttlMs: number;
  private _current: Snapshot | null = null;
  private _inFlight: Promise<Snapshot> | null = null;
  private readonly _stats: TableStats = { reads: 0, failures: 0, lastReadMs: null, lastError: null };

  constructor(options: ProcessTableOptions) {
    this._read = options.read;
    this._now = options.now;
    this._ttlMs = options.ttlMs;
  }

  stats(): TableStats {
    return { ...this._stats };
  }

  /** The pid and every descendant of it; just the pid when it is not in the table. */
  async tree(rootPid: number): Promise<number[]> {
    const snapshot = await this._snapshot();
    const out = [rootPid];
    const seen = new Set(out);
    for (let i = 0; i < out.length; i++) {
      for (const child of snapshot.children.get(out[i]!) ?? []) {
        if (!seen.has(child)) {
          seen.add(child);
          out.push(child);
        }
      }
    }
    return out;
  }

  /** What pidusage answers for these pids; a pid that is not running is absent. */
  async usageMany(pids: number[]): Promise<Record<number, ProcUsage | undefined>> {
    const snapshot = await this._snapshot();
    const out: Record<number, ProcUsage | undefined> = {};
    for (const pid of pids) {
      const row = snapshot.byPid.get(pid);
      if (row !== undefined) {
        out[pid] = {
          cpu: cpuPercent(row, snapshot),
          memory: row.rssBytes,
          elapsed: snapshot.takenAt - row.startedAtMs,
          ppid: row.ppid,
          timestamp: snapshot.takenAt,
        };
      }
    }
    return out;
  }

  private _snapshot(): Promise<Snapshot> {
    // A table that is slow to read is read less often: at most half of the time goes to waiting for a query.
    const ttlMs = Math.max(this._ttlMs, this._stats.lastReadMs ?? 0);
    if (this._current !== null && this._now() - this._current.takenAt < ttlMs) {
      return Promise.resolve(this._current);
    }
    if (this._inFlight !== null) {
      return this._inFlight;
    }
    const startedAt = this._now();
    this._stats.reads++;
    const query = this._read().then((rows) => {
      const byPid = new Map<number, ProcRow>();
      const children = new Map<number, number[]>();
      for (const r of rows) {
        byPid.set(r.pid, r);
        const siblings = children.get(r.ppid);
        if (siblings === undefined) {
          children.set(r.ppid, [r.pid]);
        } else {
          siblings.push(r.pid);
        }
      }
      const snapshot: Snapshot = { takenAt: this._now(), byPid, children, previous: this._current };
      // Only one generation back is ever read: do not chain the whole history.
      if (this._current !== null) {
        this._current.previous = null;
      }
      this._current = snapshot;
      this._stats.lastReadMs = snapshot.takenAt - startedAt;
      this._stats.lastError = null;
      return snapshot;
    }, (err: unknown) => {
      this._stats.failures++;
      this._stats.lastError = err instanceof Error ? err.message : String(err);
      throw err;
    });
    this._inFlight = query;
    const clear = (): void => { this._inFlight = null; };
    query.then(clear, clear);
    return query;
  }
}

/** The change since the previous snapshot; the average since the process started the first time it is seen (what pidusage did). */
function cpuPercent(row: ProcRow, snapshot: Snapshot): number {
  const before = snapshot.previous?.byPid.get(row.pid);
  if (before !== undefined && snapshot.previous !== null && before.startedAtMs === row.startedAtMs) {
    const wallMs = snapshot.takenAt - snapshot.previous.takenAt;
    if (wallMs > 0) {
      return Math.max(0, ((row.cpu100ns - before.cpu100ns) / 1e7) / (wallMs / 1000) * 100);
    }
  }
  const aliveMs = snapshot.takenAt - row.startedAtMs;
  return aliveMs > 0 ? Math.max(0, (row.cpu100ns / 1e7) / (aliveMs / 1000) * 100) : 0;
}

let shared: { table: ProcessTable; reader: WindowsReader } | null = null;

/** The daemon's one table (Windows only; undefined elsewhere, where pidtree and pidusage need no process start per measurement). */
export function systemProcessTable(onFallback?: (message: string) => void): { table: ProcessTable; reader: WindowsReader } | undefined {
  if (process.platform !== 'win32') {
    return undefined;
  }
  if (shared === null) {
    const reader = createWindowsReader({ onFallback });
    shared = { table: new ProcessTable({ read: reader.read, now: Date.now, ttlMs: 1000 }), reader };
  }
  return shared;
}

/** What `orch status` shows of the job monitoring: how the process table is read and what that has cost. */
export interface MonitoringInfo {
  /** wmic / powershell: one query of the whole table, shared by every job. pidusage: the other platforms (/proc or one `ps`). */
  backend: TableBackend | 'pidusage';
  queries: number;
  failures: number;
  lastQueryMs: number | null;
  lastError: string | null;
}

export function monitoringInfo(): MonitoringInfo {
  const native = systemProcessTable();
  if (native === undefined) {
    return { backend: 'pidusage', queries: 0, failures: 0, lastQueryMs: null, lastError: null };
  }
  const { reads, failures, lastReadMs, lastError } = native.table.stats();
  return { backend: native.reader.backend(), queries: reads, failures, lastQueryMs: lastReadMs, lastError };
}

/** What the daemon log says at start when the process table is read through PowerShell, the one backend that is costly. */
export function monitoringNotice(backend: MonitoringInfo['backend']): string | null {
  if (backend !== 'powershell') {
    return null;
  }
  return '[monitoring] WMIC is not installed on this machine (Windows 11 24H2 removed it): the resource monitor reads the process table '
    + 'with PowerShell, one query shared by all jobs, never two at once. Each query starts a PowerShell; a longer interval costs less: '
    + 'orch edit <id> --sample-interval 30 (default 5 s). Current cost: orch status';
}

/** Ends the PowerShell worker, if the table started one: called when the daemon stops. */
export async function disposeSystemProcessTable(): Promise<void> {
  await shared?.reader.dispose();
}
