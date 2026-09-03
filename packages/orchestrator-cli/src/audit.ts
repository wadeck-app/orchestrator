import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteJson } from './fsUtil.js';

export interface AuditEntry {
  ts: string;
  event: string;
  [key: string]: unknown;
}

export class AuditLogger {
  private readonly _file: string;

  constructor(configDir: string) {
    this._file = path.join(configDir, 'audit.ndjson');
  }

  log(event: string, details?: Record<string, unknown>): void {
    const entry: AuditEntry = { ts: new Date().toISOString(), event, ...details };
    const line = JSON.stringify(entry) + '\n';
    try { fs.appendFileSync(this._file, line, 'utf8'); } catch { /* ignore */ }
  }

  readLast(n: number): AuditEntry[] {
    try {
      const content = fs.readFileSync(this._file, 'utf8');
      const lines = content.trim().split('\n').filter(Boolean);
      return lines.slice(-n).map(l => JSON.parse(l) as AuditEntry).reverse();
    } catch { return []; }
  }
}
