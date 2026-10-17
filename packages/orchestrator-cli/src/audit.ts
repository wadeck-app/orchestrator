import fs from 'node:fs';
import path from 'node:path';

export interface AuditEntry {
  ts: string;
  event: string;
  [key: string]: unknown;
}

export interface AuditOptions {
  /** Rotate the live file once it would grow past this many bytes. 0 turns rotation off. */
  maxBytes?: number;
  /** How many rotated files to keep, the newest ones. 0 keeps none. */
  maxFiles?: number;
}

// 5 MiB x 5 rotated files bounds the trail at about 30 MiB. The file was unbounded and reached 3 MB
// from one burst of junk entries; a legitimate day writes a few dozen lines.
export const AUDIT_DEFAULTS: Required<AuditOptions> = { maxBytes: 5 * 1024 * 1024, maxFiles: 5 };

// audit.<ISO timestamp with ':' and '.' replaced>.ndjson sorts chronologically as a plain string.
const ROTATED_RE = /^audit\.\d{4}-\d{2}-\d{2}T[\d-]+Z\.ndjson$/;

export class AuditLogger {
  private readonly _dir: string;
  private readonly _file: string;
  private readonly _maxBytes: number;
  private readonly _maxFiles: number;
  /** Size of the live file, tracked so a write does not cost a stat. Null until first needed. */
  private _size: number | null = null;

  constructor(configDir: string, options: AuditOptions = {}) {
    this._dir = configDir;
    this._file = path.join(configDir, 'audit.ndjson');
    this._maxBytes = options.maxBytes ?? AUDIT_DEFAULTS.maxBytes;
    this._maxFiles = options.maxFiles ?? AUDIT_DEFAULTS.maxFiles;
  }

  log(event: string, details?: Record<string, unknown>): void {
    const entry: AuditEntry = { ts: new Date().toISOString(), event, ...details };
    const line = JSON.stringify(entry) + '\n';
    try {
      this._rotateIfNeeded(Buffer.byteLength(line));
      fs.appendFileSync(this._file, line, 'utf8');
      this._size = (this._size ?? 0) + Buffer.byteLength(line);
    } catch { /* ignore: the audit trail is a side channel and must never break a job */ }
  }

  /** Newest first, reaching back into rotated files when the live one holds fewer than `n`. */
  readLast(n: number): AuditEntry[] {
    const files = [...this._rotatedFiles(), this._file];
    const collected: AuditEntry[] = [];
    for (let i = files.length - 1; i >= 0 && collected.length < n; i--) {
      let content: string;
      try { content = fs.readFileSync(files[i], 'utf8'); } catch { continue; }
      const lines = content.split('\n').filter(Boolean);
      for (let j = lines.length - 1; j >= 0 && collected.length < n; j--) {
        try { collected.push(JSON.parse(lines[j]) as AuditEntry); } catch { /* a torn line: skip it, keep the rest */ }
      }
    }
    return collected;
  }

  private _rotateIfNeeded(incomingBytes: number): void {
    if (this._maxBytes <= 0) {
      return;
    }
    if (this._size === null) {
      try { this._size = fs.statSync(this._file).size; } catch { this._size = 0; }
    }
    // An empty file is never rotated, so one oversized entry cannot produce an empty rotated file.
    if (this._size === 0 || this._size + incomingBytes <= this._maxBytes) {
      return;
    }
    // Two rotations in the same millisecond move the stamp forward rather than add a suffix, which
    // would sort before the name it follows.
    let at = Date.now();
    let target = path.join(this._dir, `audit.${new Date(at).toISOString().replace(/[:.]/g, '-')}.ndjson`);
    while (fs.existsSync(target)) {
      at += 1;
      target = path.join(this._dir, `audit.${new Date(at).toISOString().replace(/[:.]/g, '-')}.ndjson`);
    }
    fs.renameSync(this._file, target);
    this._size = 0;
    this._prune();
  }

  private _rotatedFiles(): string[] {
    try {
      return fs.readdirSync(this._dir).filter((f) => ROTATED_RE.test(f)).sort()
        .map((f) => path.join(this._dir, f));
    } catch { return []; }
  }

  private _prune(): void {
    const files = this._rotatedFiles();
    for (const f of files.slice(0, Math.max(0, files.length - this._maxFiles))) {
      try { fs.unlinkSync(f); } catch { /* already gone */ }
    }
  }
}
