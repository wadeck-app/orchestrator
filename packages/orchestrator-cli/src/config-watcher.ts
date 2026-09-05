import fs from 'node:fs';
import path from 'node:path';
import { load as parseYaml } from 'js-yaml';
import type { Registry } from './registry.js';
import type { Job } from './types.js';

interface JobsYaml {
  jobs?: Partial<Job>[];
}

export class ConfigWatcher {
  private readonly _file: string;
  private readonly _registry: Registry;
  private _watcher: fs.FSWatcher | null = null;
  private _debounce: ReturnType<typeof setTimeout> | null = null;

  constructor(file: string, registry: Registry) {
    this._file = file;
    this._registry = registry;
  }

  start(): void {
    if (!fs.existsSync(this._file)) return;
    this.reload();
    this._watcher = fs.watch(this._file, () => {
      if (this._debounce) clearTimeout(this._debounce);
      this._debounce = setTimeout(() => { this.reload(); }, 500);
    });
  }

  stop(): void {
    if (this._debounce) clearTimeout(this._debounce);
    this._watcher?.close();
    this._watcher = null;
  }

  reload(): { synced: number } {
    if (!fs.existsSync(this._file)) return { synced: 0 };
    try {
      const raw = parseYaml(fs.readFileSync(this._file, 'utf8')) as JobsYaml;
      const jobs = raw?.jobs ?? [];
      let synced = 0;
      for (const partial of jobs) {
        if (!partial.id || !partial.command) continue;
        const existing = this._registry.get(partial.id);
        if (existing) {
          this._registry.edit(partial.id, partial as Partial<Job>);
        } else {
          this._registry.add(partial as Partial<Job>);
        }
        synced++;
      }
      return { synced };
    } catch (e) {
      console.error('[config-watcher] parse error:', (e as Error).message);
      return { synced: 0 };
    }
  }

  isActive(): boolean {
    return this._watcher !== null;
  }
}
