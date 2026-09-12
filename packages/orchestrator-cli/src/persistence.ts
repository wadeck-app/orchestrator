import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteJson, readJsonFile } from './fsUtil.js';

/**
 * Generic cached JSON store with built-in error handling, migrations, and batch flushing.
 * Reduces I/O boilerplate and centralizes persistence logic.
 */
export abstract class CachedJsonStore<T> {
  protected readonly filePath: string;
  protected cache: T | null = null;
  protected dirty = false;
  protected flushTimer: ReturnType<typeof setTimeout> | null = null;
  protected readonly flushIntervalMs: number;

  constructor(filePath: string, flushIntervalMs = 500) {
    this.filePath = filePath;
    this.flushIntervalMs = flushIntervalMs;
  }

  /**
   * Load from disk. Called once on first access.
   * Override to implement migrations or transformations.
   */
  protected abstract load(): T;

  /**
   * Prepare data for writing. Override to implement pre-write logic.
   */
  protected serialize(data: T): unknown {
    return data;
  }

  /**
   * Deserialize from disk. Override for post-load transformations.
   */
  protected deserialize(raw: unknown): T {
    return raw as T;
  }

  protected ensureLoaded(): void {
    if (this.cache !== null) return;
    try {
      this.cache = this.load();
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      try { process.stderr.write(`[CachedJsonStore] Failed to load ${path.basename(this.filePath)}: ${err}\n`); } catch { /* EPIPE */ }
      this.cache = this.getEmptyCache();
    }
  }

  protected abstract getEmptyCache(): T;

  protected doFlush(): void {
    try {
      atomicWriteJson(this.filePath, this.serialize(this.cache!));
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      try { process.stderr.write(`[CachedJsonStore] Failed to flush ${path.basename(this.filePath)}: ${err}\n`); } catch { /* EPIPE */ }
      throw e;
    }
  }

  protected scheduledFlush(): void {
    if (this.flushTimer !== null) return;
    this.dirty = true;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      if (this.dirty) {
        this.dirty = false;
        this.doFlush();
      }
    }, this.flushIntervalMs);
  }

  shutdown(): void {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.dirty) {
      this.dirty = false;
      this.doFlush();
    }
  }
}

/**
 * Append-only log store (journal/audit log pattern).
 * Writes are sequential and immutable; reads may be batched.
 */
export abstract class AppendOnlyLog<T> {
  protected readonly filePath: string;
  protected readonly maxEntriesPerBatch: number;
  protected entries: T[] = [];

  constructor(filePath: string, maxEntriesPerBatch = 100) {
    this.filePath = filePath;
    this.maxEntriesPerBatch = maxEntriesPerBatch;
    this.load();
  }

  protected abstract load(): void;
  protected abstract formatEntry(entry: T): string;
  protected abstract parseEntry(line: string): T | null;

  append(entry: T): void {
    this.entries.push(entry);
    this.entries = this.entries.slice(-this.maxEntriesPerBatch);
    try {
      const line = this.formatEntry(entry) + '\n';
      fs.appendFileSync(this.filePath, line);
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      try { process.stderr.write(`[AppendOnlyLog] Failed to append to ${path.basename(this.filePath)}: ${err}\n`); } catch { /* EPIPE */ }
    }
  }

  getAll(): T[] {
    return this.entries.map(e => ({ ...e }));
  }

  count(): number {
    return this.entries.length;
  }
}
