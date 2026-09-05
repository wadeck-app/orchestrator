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
  // violations-suppress: ts/no-err-message-direct this IS the canonical getErrorMessage implementation
  return e instanceof Error ? e.message : String(e);
}

/**
 * Clean up a job tmp directory.
 * - Removes entries older than maxAgeDays (by mtime).
 * - Then, if total size still exceeds maxSizeMb, removes oldest entries first.
 * Safe to call even if the directory doesn't exist yet.
 */
export function cleanTmpDir(tmpDir: string, opts: { maxAgeDays: number; maxSizeMb: number }): void {
  if (!fs.existsSync(tmpDir)) return;

  const nowMs = Date.now();
  const maxAgeMs = opts.maxAgeDays * 24 * 60 * 60 * 1000;
  const maxSizeBytes = opts.maxSizeMb * 1024 * 1024;

  let entries: Array<{ full: string; mtime: number; size: number }>;
  try {
    entries = fs.readdirSync(tmpDir).map((name) => {
      const full = path.join(tmpDir, name);
      try {
        const st = fs.statSync(full);
        return { full, mtime: st.mtimeMs, size: st.size };
      } catch {
        return { full, mtime: 0, size: 0 };
      }
    });
  } catch {
    return;
  }

  // Age-based pass
  entries = entries.filter((e) => {
    if (nowMs - e.mtime > maxAgeMs) {
      try { fs.rmSync(e.full, { recursive: true, force: true }); } catch { /* ignore */ }
      return false;
    }
    return true;
  });

  // Size-based pass: remove oldest first until under limit
  const totalBytes = entries.reduce((s, e) => s + e.size, 0);
  if (totalBytes > maxSizeBytes) {
    entries.sort((a, b) => a.mtime - b.mtime);
    let remaining = totalBytes;
    for (const e of entries) {
      if (remaining <= maxSizeBytes) break;
      try { fs.rmSync(e.full, { recursive: true, force: true }); } catch { /* ignore */ }
      remaining -= e.size;
    }
  }
}

// Resolve and create the tmp directory under configDir; returns its path.
export function ensureTmpDir(configDir: string): string {
  const tmpDir = path.join(configDir, 'tmp');
  fs.mkdirSync(tmpDir, { recursive: true });
  return tmpDir;
}

