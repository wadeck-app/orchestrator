import fs from 'node:fs';
import type { RuntimeEntry, StateData } from './types.js';
import { atomicWriteJson, readJsonFile } from './fsUtil.js';

export class State {
  private readonly _file: string;
  private _cache: Record<string, RuntimeEntry> | null = null;

  constructor(filePath: string) {
    this._file = filePath;
  }

  private _ensure(): void {
    if (this._cache === null) {
      const raw = fs.existsSync(this._file)
        ? (readJsonFile<StateData>(this._file) ?? { jobs: {} })
        : { jobs: {} };
      this._cache = raw.jobs;
      if (!fs.existsSync(this._file)) this._flush();
    }
  }

  private _flush(): void {
    atomicWriteJson(this._file, { jobs: this._cache });
  }

  record(id: string, entry: RuntimeEntry): void {
    this._ensure();
    this._cache![id] = { startedAt: entry.startedAt, exitCode: entry.exitCode ?? null, pid: entry.pid ?? null };
    this._flush();
  }

  get(id: string): RuntimeEntry | null {
    this._ensure();
    const e = this._cache![id];
    return e ? { ...e } : null;
  }

  getAll(): Record<string, RuntimeEntry> {
    this._ensure();
    if (!fs.existsSync(this._file)) this._flush();
    const copy: Record<string, RuntimeEntry> = {};
    for (const [k, v] of Object.entries(this._cache!)) copy[k] = { ...v };
    return copy;
  }

  clear(id: string): void {
    this._ensure();
    if (this._cache![id] !== undefined) {
      delete this._cache![id];
      this._flush();
    }
  }
}
