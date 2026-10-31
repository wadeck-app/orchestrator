import { describe, expect, it } from 'vitest';
import { cannotBeReadMessage } from './source-failure.js';

describe('cannotBeReadMessage', () => {
  it('names the stopped daemon and the command that starts it', () => {
    expect(cannotBeReadMessage({ status: 503, message: 'daemon-not-running' })).toBe('Cannot be read: the daemon is not running (orch start)');
  });

  it('gives any other failure its own reason, with the status when there is one', () => {
    expect(cannotBeReadMessage({ status: 500, message: 'boom' })).toBe('Cannot be read: boom (HTTP 500)');
    expect(cannotBeReadMessage({ message: 'network error' })).toBe('Cannot be read: network error');
  });

  // A 503 that is not the stopped daemon (overloaded proxy) must not tell the reader to run orch start.
  it('does not blame the daemon for a 503 that is not daemon-not-running', () => {
    expect(cannotBeReadMessage({ status: 503, message: 'overloaded' })).toBe('Cannot be read: overloaded (HTTP 503)');
  });
});
