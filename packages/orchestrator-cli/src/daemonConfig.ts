import fs   from 'node:fs';
import path from 'node:path';

export interface DaemonConfig {
  autoUpdate?: boolean;
  /** Seconds to wait after daemon start before firing the first catch-up job (default: 300) */
  catchUpInitialDelaySeconds?: number;
  /** Seconds between consecutive catch-up jobs on startup (default: 300) */
  catchUpStaggerSeconds?: number;
}

const DEFAULTS: Required<DaemonConfig> = {
  autoUpdate:                  true,
  catchUpInitialDelaySeconds:  300,
  catchUpStaggerSeconds:       300,
};

/**
 * Reads <configDir>/config.yml into a DaemonConfig object.
 * Only handles simple "key: value" lines - no nested YAML.
 * Missing file or parse errors fall back to defaults silently.
 */
export function loadDaemonConfig(configDir: string): Required<DaemonConfig> {
  const file = path.join(configDir, 'config.yml');
  const result: DaemonConfig = {};
  try {
    const raw = fs.readFileSync(file, 'utf8');
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const colon = trimmed.indexOf(':');
      if (colon < 0) continue;
      const key = trimmed.slice(0, colon).trim();
      const val = trimmed.slice(colon + 1).trim();
      if (key === 'autoUpdate')                  result.autoUpdate = val === 'true';
      if (key === 'catchUpInitialDelaySeconds')   result.catchUpInitialDelaySeconds = Number(val);
      if (key === 'catchUpStaggerSeconds')        result.catchUpStaggerSeconds = Number(val);
    }
  } catch { /* file absent or unreadable - use defaults */ }
  return { ...DEFAULTS, ...result };
}
