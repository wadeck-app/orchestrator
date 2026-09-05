import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteJson, readJsonFile } from './fsUtil.js';

export interface WebhookConfig {
  id: string;
  url: string;
  events: string[];
  enabled: boolean;
  headers?: Record<string, string>;
}

const WEBHOOK_EVENTS = [
  'job.failed',
  'job.recovered',
  'job.completed',
  'job.started',
  'job.timed_out',
  'job.anomaly',
  'alert.consecutive_failures',
] as const;

export { WEBHOOK_EVENTS };

function webhookFile(configDir: string): string {
  return path.join(configDir, 'config.webhooks.json');
}

export class WebhookManager {
  private readonly _configDir: string;

  constructor(configDir: string) {
    this._configDir = configDir;
  }

  load(): WebhookConfig[] {
    try {
      const raw = readJsonFile<{ webhooks: WebhookConfig[] }>(webhookFile(this._configDir));
      return raw?.webhooks ?? [];
    } catch {
      return [];
    }
  }

  private _save(webhooks: WebhookConfig[]): void {
    atomicWriteJson(webhookFile(this._configDir), { webhooks });
  }

  add(wh: WebhookConfig): void {
    const list = this.load();
    list.push(wh);
    this._save(list);
    void this._registerWithQueue(wh);
  }

  remove(id: string): void {
    const list = this.load().filter(w => w.id !== id);
    this._save(list);
  }

  toggle(id: string): WebhookConfig | null {
    const list = this.load();
    const wh = list.find(w => w.id === id);
    if (!wh) return null;
    wh.enabled = !wh.enabled;
    this._save(list);
    return wh;
  }

  // Register all enabled webhooks as subscribers in the queue daemon (fire-and-forget)
  registerAll(): void {
    for (const wh of this.load().filter(w => w.enabled)) {
      void this._registerWithQueue(wh);
    }
  }

  private async _registerWithQueue(wh: WebhookConfig): Promise<void> {
    if (!wh.enabled) return;
    try {
      for (const event of wh.events) {
        await fetch('http://localhost:47910/subscribers', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            subscriberId: `webhook-${wh.id}-${event}`,
            event,
            type: 'http',
            url: wh.url,
            method: 'POST',
            headers: wh.headers ?? {},
            retries: 3,
            timeoutMs: 10000,
            backoff: 'exponential',
          }),
          signal: AbortSignal.timeout(3000),
        });
      }
    } catch {
      // Queue not running - silent fail
    }
  }
}
