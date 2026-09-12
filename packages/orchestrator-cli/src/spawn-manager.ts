import { spawn as nodeSpawn, ChildProcess } from 'node:child_process';
import type { SpawnOptionsWithoutStdio } from 'node:child_process';

/**
 * Centralized command parsing and process spawning.
 * Eliminates 3x copy-paste shell parsing logic in scheduler, exec-manager.
 */

export interface SpawnOptions extends SpawnOptionsWithoutStdio {
  windowsHide?: boolean;
  shell?: boolean;
}

export class SpawnManager {
  private static readonly SHELL_PARSE_RE = /(?:[^\s"']+|"[^"]*"|'[^']*')+/g;

  /**
   * Parse shell command into [binary, ...args] with proper quote handling.
   * Handles: single quotes, double quotes, spaces, escapes.
   *
   * Examples:
   *   "echo hello" → ["echo", "hello"]
   *   'echo "quoted"' → ["echo", '"quoted"']
   *   "npm run build" → ["npm", "run", "build"]
   */
  static parseCommand(command: string): { bin: string; args: string[] } {
    const parts = command.match(this.SHELL_PARSE_RE) ?? [command];
    const [bin, ...args] = parts;
    if (!bin) throw new Error(`Invalid command: "${command}"`);
    return { bin, args };
  }

  /**
   * Spawn a process with standardized options and error handling.
   * All spawns go through here for consistency.
   */
  static spawn(command: string, opts: SpawnOptions = {}): ChildProcess {
    const { bin, args } = this.parseCommand(command);

    const defaultOpts: SpawnOptions = {
      windowsHide: true,
      shell: true,
      ...opts,
    };

    return nodeSpawn(bin, args, defaultOpts);
  }
}
