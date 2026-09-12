'use strict';

import fs   from 'node:fs';
import path from 'node:path';

const MAX_KEEP_DAYS = 30;
const HARD_CAP_DAYS = 120;
const MAX_RUN_LOGS  = 100; // keep last 100 run log files per job

/**
 * Per-run logger: writes all output for one job execution to a single timestamped file.
 * Filename: <prefix>-<YYYY-MM-DDTHH-MM-SS>.log  (colons replaced for Windows compatibility)
 */
export class RunLogger {
  private readonly _file: string;
  private _fd: number;
  private _writeError: string | null = null;

  constructor(logDir: string, prefix: string, startedAt: string) {
    fs.mkdirSync(logDir, { recursive: true });
    const compact = startedAt.replace(/:/g, '-').slice(0, 19); // YYYY-MM-DDTHH-MM-SS
    this._file = path.join(logDir, `${prefix}-${compact}.log`);
    try {
      this._fd = fs.openSync(this._file, 'a');
    } catch (e) {
      this._fd = -1;
      const err = e instanceof Error ? e.message : String(e);
      this._writeError = `Failed to open log file: ${err}`;
      try { process.stderr.write(`[RunLogger] ${this._writeError}\n`); } catch { /* EPIPE */ }
    }
    RunLogger._prune(logDir, prefix);
  }

  write(line: string): void {
    const ts    = new Date().toISOString().replace('T', ' ').slice(0, 19);
    const entry = `[${ts}] ${line}\n`;
    if (this._fd >= 0) {
      try {
        fs.writeSync(this._fd, entry);
      } catch (e) {
        const err = e instanceof Error ? e.message : String(e);
        if (!this._writeError) {
          this._writeError = err;
          try { process.stderr.write(`[RunLogger] Write failed: ${err}\n`); } catch { /* EPIPE */ }
        }
      }
    }
  }

  close(): void {
    if (this._fd >= 0) {
      try { fs.closeSync(this._fd); } catch { /* ignore close errors */ }
      this._fd = -1;
    }
  }

  get filePath(): string { return this._file; }

  private static _prune(logDir: string, prefix: string): void {
    try {
      const pat = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-\\d{4}-\\d{2}-\\d{2}T`);
      const files = fs.readdirSync(logDir).filter(f => pat.test(f) && f.endsWith('.log')).sort();
      const now   = Date.now();
      for (const f of files) {
        const ts  = f.slice(prefix.length + 1, -4).replace(/-(\d{2})-(\d{2})$/, ':$1:$2'); // restore HH:MM:SS
        const age = (now - new Date(ts).getTime()) / 86_400_000;
        if (age > HARD_CAP_DAYS || (files.length > MAX_RUN_LOGS && age > MAX_KEEP_DAYS)) {
          try { fs.unlinkSync(path.join(logDir, f)); } catch { /* ignore */ }
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
      const err = e instanceof Error ? e.message : String(e);
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
        const err = e instanceof Error ? e.message : String(e);
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
    if (today === this._date) return;
    this.close();
    this._date = today;
    const file = path.join(this._dir, `${this._prefix}-${today}.log`);
    try {
      this._fd = fs.openSync(file, 'a');
    } catch (e) {
      this._fd = null;
      const err = e instanceof Error ? e.message : String(e);
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
