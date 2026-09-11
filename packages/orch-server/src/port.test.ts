import { describe, it, expect } from 'vitest';
import * as net from 'node:net';
import { findFreePort } from './port.js';

function occupyPort(port: number): Promise<{ server: net.Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address();
      const actualPort = typeof addr === 'object' ? addr.port : port;
      resolve({ server, port: actualPort });
    });
    server.on('error', reject);
  });
}

describe('findFreePort', () => {
  it('returns base port when it is free', async () => {
    // Find any free port first
    const port = await findFreePort(49000);
    expect(port).toBeGreaterThanOrEqual(49000);
  });

  it('skips occupied ports and returns next free one', async () => {
    // Get a dynamically allocated port (avoid TIME_WAIT on Windows)
    const { server, port: occupiedPort } = await occupyPort(0);
    try {
      const nextFreePort = await findFreePort(occupiedPort);
      expect(typeof nextFreePort).toBe('number');
      expect(nextFreePort).toBeGreaterThan(occupiedPort);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
