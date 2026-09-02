import fs   from 'node:fs';
import path from 'node:path';

export function atomicWriteJson(filePath: string, data: unknown): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: 'utf8', flag: 'w', mode: 0o600 });
  fs.renameSync(tmp, filePath);
}

export function readJsonFile<T>(filePath: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
  } catch {
    return null;
  }
}

export function getErrorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
