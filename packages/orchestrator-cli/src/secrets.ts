import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function deriveKey(): Buffer {
  // Machine-unique key based on hostname (simple, non-HSM approach)
  const seed = os.hostname();
  return crypto.createHash('sha256').update(seed).update('orch-secrets-v1').digest();
}

function encrypt(value: string, key: Buffer): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString('base64');
}

function decrypt(encoded: string, key: Buffer): string | null {
  try {
    const buf = Buffer.from(encoded, 'base64');
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const encrypted = buf.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return decipher.update(encrypted) + decipher.final('utf8');
  } catch { return null; }
}

export class SecretsManager {
  private readonly _file: string;
  private readonly _key: Buffer;

  constructor(configDir: string) {
    this._file = path.join(configDir, 'secrets.json');
    this._key = deriveKey();
  }

  private _load(): Record<string, string> {
    if (!fs.existsSync(this._file)) return {};
    try { return JSON.parse(fs.readFileSync(this._file, 'utf8')) as Record<string, string>; }
    catch { return {}; }
  }

  private _save(data: Record<string, string>): void {
    fs.writeFileSync(this._file, JSON.stringify(data, null, 2), { mode: 0o600 });
  }

  set(name: string, value: string): void {
    const data = this._load();
    data[name] = encrypt(value, this._key);
    this._save(data);
  }

  get(name: string): string | null {
    const data = this._load();
    if (!data[name]) return null;
    return decrypt(data[name]!, this._key);
  }

  list(): string[] {
    return Object.keys(this._load());
  }

  delete(name: string): void {
    const data = this._load();
    delete data[name];
    this._save(data);
  }

  /** Resolve secret names to env var key=value pairs for job injection. */
  resolveForJob(names: string[]): Record<string, string> {
    const result: Record<string, string> = {};
    for (const name of names) {
      const val = this.get(name);
      if (val !== null) result[name] = val;
    }
    return result;
  }
}
