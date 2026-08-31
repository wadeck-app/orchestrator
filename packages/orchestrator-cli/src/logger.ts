'use strict';

import fs   from 'node:fs';
import path from 'node:path';

const MAX_KEEP_DAYS = 30;
const HARD_CAP_DAYS = 120;

export class DailyLogger {
  private readonly _dir:    string;
  private readonly _prefix: string;
  private _date = '';
  private _fd:   number | null = null;

  constructor(logDir: string, prefix: string) {
    this._dir    = logDir;
    this._prefix = prefix;
    fs.mkdirSync(logDir, { recursive: true });
    this._rotate();
    this._prune();
  }

  write(line: string): void {
    this._rotate();
    const ts    = new Date().toISOString().replace('T', ' ').slice(0, 19);
    const entry = `[${ts}] ${line}\n`;
    if (this._fd !== null) fs.writeSync(this._fd, entry);
  }

  close(): void {
    if (this._fd !== null) { fs.closeSync(this._fd); this._fd = null; }
  }

  private _rotate(): void {
    const today = new Date().toISOString().slice(0, 10);
    if (today === this._date) return;
    this.close();
    this._date = today;
    const file = path.join(this._dir, `${this._prefix}-${today}.log`);
    this._fd   = fs.openSync(file, 'a');
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
