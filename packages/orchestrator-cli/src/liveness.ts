import fs   from 'node:fs';
import path from 'node:path';
import os   from 'node:os';
import { exec } from 'node:child_process';
import type { Job } from './types.js';

function expandTilde(p: string): string {
  return p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p;
}

function orchConfigDir(): string {
  const xdg = process.env['XDG_CONFIG_HOME'];
  return process.env['ORCH_CONFIG_DIR']
    ?? (xdg ? path.join(xdg, 'orchestrator') : path.join(os.homedir(), '.config', 'orchestrator'));
}

function isPidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function readPidFromPortFile(filePath: string): number | null {
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8')) as { pid?: unknown };
  return typeof data.pid === 'number' ? data.pid : null;
}

async function checkPortFile(portFile: string): Promise<boolean> {
  try {
    const pid = readPidFromPortFile(expandTilde(portFile));
    return pid !== null && isPidAlive(pid);
  } catch { return false; }
}

async function checkPidFile(jobId: string): Promise<boolean> {
  try {
    const raw = fs.readFileSync(path.join(orchConfigDir(), 'pids', `${jobId}.pid`), 'utf8').trim();
    const pid = parseInt(raw, 10);
    return Number.isFinite(pid) && isPidAlive(pid);
  } catch { return false; }
}

async function checkCommand(command: string): Promise<boolean> {
  return new Promise((resolve) => {
    exec(command, { windowsHide: true }, (err) => resolve(err === null));
  });
}

export async function checkLiveness(job: Pick<Job, 'id' | 'liveness'>): Promise<boolean> {
  try {
    const liveness = job.liveness;
    if (!liveness || liveness.strategy === 'none') return false;
    switch (liveness.strategy) {
      case 'portFile': return await checkPortFile(liveness.portFile ?? '');
      case 'pidFile':  return await checkPidFile(job.id);
      case 'command':  return await checkCommand(liveness.command ?? '');
      default:         return false;
    }
  } catch { return false; }
}
