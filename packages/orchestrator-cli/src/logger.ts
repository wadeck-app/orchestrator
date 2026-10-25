'use strict';

import fs   from 'node:fs';
import path from 'node:path';
import { getErrorMessage } from './fsUtil.js';
import { stripAnsi } from './ansi.js';
import { dropMarkerText, listRunSegments, segmentPath, type ResolvedLogRotation, type RunSegment } from './log-rotation.js';

const MAX_KEEP_DAYS = 30;
const HARD_CAP_DAYS = 120;
const MAX_RUN_LOGS  = 100; // keep last 100 run log files per job

/**
 * Where the log of a run lives: <prefix>-<YYYY-MM-DDTHH-MM-SS>.log, colons replaced for Windows.
 *
 * Shared because two writers append to the same file: the daemon (its markers) and, for a supervised job, the
 * supervisor (the job's output). They must agree on the name without ever talking to each other.
 */
export function runLogPath(logDir: string, prefix: string, startedAt: string): string {
  const compact = startedAt.replace(/:/g, '-').slice(0, 19); // YYYY-MM-DDTHH-MM-SS
  return path.join(logDir, `${prefix}-${compact}.log`);
}

/** What a RunLogger can be told beyond where to write. */
export interface RunLoggerOptions {
  /** The size limits of the run, see log-rotation.ts. Absent or `maxBytes: 0`: one file, however big it grows. */
  rotation?: ResolvedLogRotation;
  /** The clock (epoch ms) behind the default time stamp of a line and the age of the logs to prune; the real one by default. */
  now?: () => number;
}

/**
 * Per-run logger: writes all output for one job execution to a timestamped file, and to the next segment of the
 * same run once the current one would pass the size limit (log-rotation.ts).
 * Filename: <prefix>-<YYYY-MM-DDTHH-MM-SS>.log  (colons replaced for Windows compatibility), then .log.2, .log.3...
 *
 * The rules, which the supervisor implements identically (supervisor-go/run.go):
 *  - A line goes whole into one segment. It starts the next segment when it would take a non-empty segment over the
 *    limit; a line longer than the limit sits alone in its segment, unsplit.
 *  - Another writer may append to the same run (the daemon's markers next to the supervisor's output): before each
 *    line the writer moves on to the next segment if that exists, and the size it compares is the file's, not its own count.
 *  - The writer that creates a segment deletes the segments before the last `keepSegments`, and when it did, opens
 *    the new segment with one marker line saying how many earlier segments are gone.
 */
export class RunLogger {
  private readonly _file: string;
  private readonly _dir: string;
  private readonly _prefix: string;
  private readonly _stamp: string;
  private readonly _rotation: ResolvedLogRotation;
  private readonly _now: () => number;
  private _seg = 1;
  /** Bytes at the start of the current segment that are this writer's own drop marker, not run content. */
  private _markerBytes = 0;
  private _fd: number;
  private _writeError: string | null = null;
  private _rotationReported = false;

  constructor(logDir: string, prefix: string, startedAt: string, options: RunLoggerOptions = {}) {
    fs.mkdirSync(logDir, { recursive: true });
    this._dir = logDir;
    this._prefix = prefix;
    this._file = runLogPath(logDir, prefix, startedAt);
    this._stamp = path.basename(this._file).slice(prefix.length + 1, -'.log'.length);
    this._rotation = options.rotation ?? { maxBytes: 0, keepSegments: 1 };
    this._now = options.now ?? Date.now;
    const runs = listRunSegments(logDir, prefix);
    // Appends to the newest segment the run already has: a daemon that follows a run again, the supervisor's own restart.
    const have = runs.get(this._stamp);
    this._seg = have !== undefined && have.length > 0 ? have[have.length - 1]!.n : 1;
    try {
      this._fd = fs.openSync(segmentPath(this._file, this._seg), 'a');
    } catch (e) {
      this._fd = -1;
      const err = getErrorMessage(e);
      this._writeError = `Failed to open log file: ${err}`;
      try { process.stderr.write(`[RunLogger] ${this._writeError}\n`); } catch { /* EPIPE */ }
    }
    RunLogger._prune(runs, this._now());
  }

  /** `at` is for a line about something that happened earlier than now, such as the end of a run learned late. */
  write(line: string, at: Date = new Date(this._now())): void {
    const ts    = at.toISOString().replace('T', ' ').slice(0, 19);
    const entry = Buffer.from(`[${ts}] ${line}\n`);
    if (this._fd >= 0) {
      if (this._rotation.maxBytes > 0) {
        this._makeRoomFor(entry.length, ts);
      }
      this._append(entry);
    }
  }

  /**
   * A line the JOB printed (stdout, or stderr with its prefix), as opposed to the daemon's own markers: escape
   * sequences are stripped (colour has no value in a file read by editors, grep, the dashboard and agents), and a
   * line that is empty once stripped and trimmed writes nothing. The supervisor does the same for a supervised
   * job (supervisor-go/run.go), so the file reads the same whichever path ran the job.
   */
  writeOutput(line: string, prefix = ''): void {
    const text = stripAnsi(line).trimEnd();
    if (text) {
      this.write(`${prefix}${text}`);
    }
  }

  close(): void {
    if (this._fd >= 0) {
      try { fs.closeSync(this._fd); } catch { /* ignore close errors */ }
      this._fd = -1;
    }
  }

  /** The first segment of the run, which names it: <prefix>-<stamp>.log. Later segments carry a number after it. */
  get filePath(): string { return this._file; }

  private _append(entry: Buffer): void {
    try {
      fs.writeSync(this._fd, entry);
    } catch (e) {
      const err = getErrorMessage(e);
      if (!this._writeError) {
        this._writeError = err;
        try { process.stderr.write(`[RunLogger] Write failed: ${err}\n`); } catch { /* EPIPE */ }
      }
    }
  }

  /** Moves to the segment where `length` more bytes belong: the next one another writer already made, or a new one. */
  private _makeRoomFor(length: number, ts: string): void {
    while (fs.existsSync(segmentPath(this._file, this._seg + 1))) {
      if (!this._switchTo(this._seg + 1, false)) {
        return;
      }
    }
    let size: number;
    try {
      size = fs.fstatSync(this._fd).size;
    } catch {
      return;
    }
    if (size > this._markerBytes && size + length > this._rotation.maxBytes) {
      this._switchTo(this._seg + 1, true, ts);
    }
  }

  /** Makes `n` the current segment; false (reported once, nothing changes) when it cannot be opened. */
  private _switchTo(n: number, mayCreate: boolean, ts = ''): boolean {
    const file = segmentPath(this._file, n);
    let fd: number;
    let created = false;
    try {
      if (mayCreate) {
        try {
          fd = fs.openSync(file, 'ax');
          created = true;
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'EEXIST') {
            throw e;
          }
          // The other writer made it between our look and now: follow it.
          fd = fs.openSync(file, 'a');
        }
      } else {
        fd = fs.openSync(file, 'a');
      }
      // Windows opens a directory for appending without complaint: anything that is not a file is refused here.
      if (!fs.fstatSync(fd).isFile()) {
        fs.closeSync(fd);
        throw new Error('it exists and is not a regular file');
      }
    } catch (e) {
      if (!this._rotationReported) {
        this._rotationReported = true;
        try {
          process.stderr.write(`[RunLogger] cannot start the next log segment ${file}: ${getErrorMessage(e)}. `
            + 'The run keeps writing to the current segment, which can grow past the limit. Check the disk space and the permissions of the log folder.\n');
        } catch { /* EPIPE */ }
      }
      return false;
    }
    try { fs.closeSync(this._fd); } catch { /* ignore close errors */ }
    this._fd = fd;
    this._seg = n;
    this._markerBytes = 0;
    if (created) {
      const dropped = n - this._rotation.keepSegments;
      if (dropped >= 1) {
        this._dropSegmentsUpTo(dropped);
        const marker = Buffer.from(`[${ts}] ${dropMarkerText(dropped, this._rotation.keepSegments, this._rotation.maxBytes)}\n`);
        this._append(marker);
        this._markerBytes = marker.length;
      }
    }
    return true;
  }

  /** Deletes the segments of this run numbered up to `last`. One that cannot go (a reader holds it on Windows) goes at the next rotation. */
  private _dropSegmentsUpTo(last: number): void {
    for (const seg of listRunSegments(this._dir, this._prefix).get(this._stamp) ?? []) {
      if (seg.n <= last) {
        try { fs.unlinkSync(seg.file); } catch { /* retried at the next rotation */ }
      }
    }
  }

  /** The retention of run logs, per run: a run goes with all its segments. */
  private static _prune(runs: Map<string, RunSegment[]>, nowMs: number): void {
    try {
      const stamps = [...runs.keys()];
      for (const stamp of stamps) {
        // YYYY-MM-DDTHH-MM-SS, UTC: restore the colons of the time.
        const ts  = `${stamp.replace(/-(\d{2})-(\d{2})$/, ':$1:$2')}Z`;
        const age = (nowMs - new Date(ts).getTime()) / 86_400_000;
        if (age > HARD_CAP_DAYS || (stamps.length > MAX_RUN_LOGS && age > MAX_KEEP_DAYS)) {
          for (const seg of runs.get(stamp)!) {
            try { fs.unlinkSync(seg.file); } catch { /* ignore */ }
          }
        }
      }
    } catch { /* ignore */ }
  }
}

export class DailyLogger {
  private readonly _dir:    string;
  private readonly _prefix: string;
  private _date = '';
  private _fd:   number | null = null;
  private _writeError: string | null = null;

  constructor(logDir: string, prefix: string) {
    this._dir    = logDir;
    this._prefix = prefix;
    try {
      fs.mkdirSync(logDir, { recursive: true });
    } catch (e) {
      const err = getErrorMessage(e);
      this._writeError = `Failed to create log dir: ${err}`;
      try { process.stderr.write(`[DailyLogger] ${this._writeError}\n`); } catch { /* EPIPE */ }
    }
    this._rotate();
    this._prune();
  }

  write(line: string): void {
    this._rotate();
    const ts    = new Date().toISOString().replace('T', ' ').slice(0, 19);
    const entry = `[${ts}] ${line}\n`;
    if (this._fd !== null) {
      try {
        fs.writeSync(this._fd, entry);
      } catch (e) {
        const err = getErrorMessage(e);
        if (!this._writeError) {
          this._writeError = err;
          try { process.stderr.write(`[DailyLogger] Write failed: ${err}\n`); } catch { /* EPIPE */ }
        }
      }
    }
  }

  close(): void {
    if (this._fd !== null) {
      try { fs.closeSync(this._fd); } catch { /* ignore close errors */ }
      this._fd = null;
    }
  }

  private _rotate(): void {
    const today = new Date().toISOString().slice(0, 10);
    if (today === this._date) {
      return;
    }
    this.close();
    this._date = today;
    const file = path.join(this._dir, `${this._prefix}-${today}.log`);
    try {
      this._fd = fs.openSync(file, 'a');
    } catch (e) {
      this._fd = null;
      const err = getErrorMessage(e);
      if (!this._writeError) {
        this._writeError = err;
        try { process.stderr.write(`[DailyLogger] Failed to rotate: ${err}\n`); } catch { /* EPIPE */ }
      }
    }
  }

  private _prune(): void {
    try {
      const now      = Date.now();
      const msPerDay = 86_400_000;
      const files    = fs.readdirSync(this._dir)
        .filter(f => f.startsWith(this._prefix + '-') && f.endsWith('.log'))
        .sort();
      for (const f of files) {
        const dateStr = f.slice(this._prefix.length + 1, -4); // YYYY-MM-DD
        const age     = (now - new Date(dateStr).getTime()) / msPerDay;
        if (age > HARD_CAP_DAYS || (age > MAX_KEEP_DAYS && files.length > MAX_KEEP_DAYS)) {
          try { fs.unlinkSync(path.join(this._dir, f)); } catch { /* ignore */ }
        }
      }
    } catch { /* ignore */ }
  }
}
