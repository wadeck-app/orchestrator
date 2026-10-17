import { ConfigDir } from '@wadeck-app/shared-cli/ConfigDir';

/**
 * The orchestrator config dir the daemon and the CLI use, so the module reads the same port file,
 * health token and logs. ORCH_CONFIG_DIR is the override the CLI already honours.
 */
export function getOrchConfigDir(): string {
  return process.env['ORCH_CONFIG_DIR'] ?? ConfigDir.get('orchestrator');
}
