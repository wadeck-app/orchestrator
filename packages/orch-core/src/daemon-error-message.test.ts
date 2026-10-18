import { describe, it, expect } from 'vitest';
import { daemonErrorMessage } from './daemon-proxy.js';

/*
 * This string reaches the user. Brains publish it as `$error` and the dashboard announces it in a
 * toast, so whatever comes out of here is the entire explanation of why a save failed.
 *
 * Before: deleting a job and then saving an open edit form produced
 *   Daemon RPC error 500: {"error":"Command failed: Job not found: \"verify-err\""}
 * - raw JSON, escaped quotes and a transport detail, to say that a job does not exist.
 */

function response(status: number, body: string) {
  return { status, text: () => Promise.resolve(body) };
}

describe('daemonErrorMessage', () => {
  it('reports the daemon reason as a sentence', async () => {
    const message = await daemonErrorMessage(
      response(500, JSON.stringify({ error: 'Command failed: Job not found: "verify-err"' })),
    );

    expect(message).toBe('Job not found: "verify-err"');
  });

  // The prefix is the CLI describing its own plumbing.
  it('drops the "Command failed" prefix', async () => {
    const message = await daemonErrorMessage(
      response(500, JSON.stringify({ error: 'Command failed: Invalid cron schedule: "x"' })),
    );

    expect(message).not.toContain('Command failed');
    expect(message).toBe('Invalid cron schedule: "x"');
  });

  it('keeps a reason that has no prefix', async () => {
    expect(await daemonErrorMessage(response(500, JSON.stringify({ error: 'Job id must be a non-empty string' }))))
      .toBe('Job id must be a non-empty string');
  });

  it('leaks no JSON punctuation or transport detail', async () => {
    const message = await daemonErrorMessage(
      response(500, JSON.stringify({ error: 'Command failed: Job not found' })),
    );

    expect(message).not.toMatch(/[{}"]/);
    expect(message).not.toContain('RPC');
    expect(message).not.toContain('500');
  });

  // Reports what was actually said rather than inventing a shape that was not there.
  it('passes through a non-JSON body', async () => {
    expect(await daemonErrorMessage(response(502, 'upstream exploded'))).toBe('upstream exploded');
  });

  it('falls back to a plain sentence when the body is empty', async () => {
    const message = await daemonErrorMessage(response(503, '   '));

    expect(message).toContain('503');
    expect(message).toMatch(/refused/);
  });

  it('falls back when the JSON carries no error field', async () => {
    const message = await daemonErrorMessage(response(500, JSON.stringify({ ok: false })));

    // The body itself is the only information available, so it is what gets reported.
    expect(message).toContain('ok');
  });
});
