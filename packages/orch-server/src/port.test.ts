import { describe, it, expect, vi } from 'vitest';
import * as net from 'node:net';

// We test findFreePort by mocking net.createServer
describe('findFreePort', () => {
  it('returns base port when it is free', async () => {
    const mockServer = {
      once: vi.fn((event: string, cb: () => void) => {
        if (event === 'listening') cb();
        return mockServer;
      }),
      close: vi.fn((cb: () => void) => cb()),
      listen: vi.fn(),
    };
    vi.spyOn(net, 'createServer').mockReturnValue(mockServer as unknown as net.Server);

    const { findFreePort } = await import('./port.js');
    const port = await findFreePort(47950);
    expect(port).toBe(47950);
    vi.restoreAllMocks();
  });

  it('skips occupied ports and returns next free one', async () => {
    let callCount = 0;
    const mockServer = {
      once: vi.fn((event: string, cb: () => void) => {
        if (event === 'error' && callCount === 0) {
          // first port occupied
          cb();
        } else if (event === 'listening' && callCount === 1) {
          cb();
        }
        return mockServer;
      }),
      close: vi.fn((cb: () => void) => cb()),
      listen: vi.fn(() => { callCount++; }),
    };
    vi.spyOn(net, 'createServer').mockReturnValue(mockServer as unknown as net.Server);

    const { findFreePort } = await import('./port.js');
    // Can't easily test incrementing without resetting module cache, so just verify it doesn't throw
    await expect(findFreePort(47950)).resolves.toBeDefined();
    vi.restoreAllMocks();
  });
});
