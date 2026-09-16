import { describe, it, expect } from 'vitest';
import { isAllowedOrigin } from './cors.js';

describe('isAllowedOrigin', () => {
  it('allows a missing origin (same-origin / non-CORS requests)', () => {
    expect(isAllowedOrigin(undefined)).toBe(true);
    expect(isAllowedOrigin('')).toBe(true);
  });

  // The dashboard is reachable under every loopback spelling. Rejecting any of
  // them serves a blank page: index.html loads its assets with `crossorigin`,
  // so a rejected origin turns the bundle request into a 500 and React never
  // mounts.
  it.each([
    'http://localhost:47951',
    'http://127.0.0.1:47951',
    'http://[::1]:47951',
    'https://localhost:47951',
    'http://localhost',
    'http://127.0.0.1',
  ])('allows loopback origin %s', (origin) => {
    expect(isAllowedOrigin(origin)).toBe(true);
  });

  // A prefix match on 'http://localhost' also matches 'http://localhost.evil.com',
  // which is an attacker-controlled domain that can be pointed at the loopback
  // interface. The host must be compared exactly, not by prefix.
  it.each([
    'http://localhost.evil.com',
    'http://localhost.evil.com:47951',
    'http://127.0.0.1.evil.com',
    'http://notlocalhost',
    'http://evil.com',
    'https://example.com',
  ])('rejects non-loopback origin %s', (origin) => {
    expect(isAllowedOrigin(origin)).toBe(false);
  });

  it('rejects non-http(s) schemes on a loopback host', () => {
    expect(isAllowedOrigin('ftp://localhost')).toBe(false);
    expect(isAllowedOrigin('file://localhost')).toBe(false);
  });

  it('rejects a malformed origin instead of throwing', () => {
    expect(isAllowedOrigin('not a url')).toBe(false);
    expect(isAllowedOrigin('://')).toBe(false);
  });
});
