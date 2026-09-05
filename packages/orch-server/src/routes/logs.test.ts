import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { findLatestLogFile } from './logs.js';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'orch-logs-test-'));
}

describe('findLatestLogFile', () => {
  let dir: string;

  beforeEach(() => { dir = tmpDir(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('returns null when directory does not exist', () => {
    expect(findLatestLogFile(path.join(dir, 'nonexistent'), 'job-a')).toBeNull();
  });

  it('returns null when no matching log files exist', () => {
    const jobDir = path.join(dir, 'job-a');
    fs.mkdirSync(jobDir);
    fs.writeFileSync(path.join(jobDir, 'other.log'), '');
    expect(findLatestLogFile(jobDir, 'job-a')).toBeNull();
  });

  it('returns the single matching log file', () => {
    const jobDir = path.join(dir, 'job-a');
    fs.mkdirSync(jobDir);
    fs.writeFileSync(path.join(jobDir, 'job-a-2026-09-01.log'), 'line1');
    expect(findLatestLogFile(jobDir, 'job-a')).toBe(path.join(jobDir, 'job-a-2026-09-01.log'));
  });

  it('returns the most recent when multiple dated files exist', () => {
    const jobDir = path.join(dir, 'job-a');
    fs.mkdirSync(jobDir);
    fs.writeFileSync(path.join(jobDir, 'job-a-2026-08-30.log'), '');
    fs.writeFileSync(path.join(jobDir, 'job-a-2026-09-01.log'), '');
    fs.writeFileSync(path.join(jobDir, 'job-a-2026-08-31.log'), '');
    expect(findLatestLogFile(jobDir, 'job-a')).toBe(path.join(jobDir, 'job-a-2026-09-01.log'));
  });

  it('does not match log files for a different job id', () => {
    const jobDir = path.join(dir, 'job-a');
    fs.mkdirSync(jobDir);
    fs.writeFileSync(path.join(jobDir, 'job-b-2026-09-01.log'), '');
    expect(findLatestLogFile(jobDir, 'job-a')).toBeNull();
  });

  it('handles job ids with hyphens correctly', () => {
    const jobDir = path.join(dir, 'my-job');
    fs.mkdirSync(jobDir);
    fs.writeFileSync(path.join(jobDir, 'my-job-2026-09-01.log'), 'data');
    expect(findLatestLogFile(jobDir, 'my-job')).toBe(path.join(jobDir, 'my-job-2026-09-01.log'));
  });
});
