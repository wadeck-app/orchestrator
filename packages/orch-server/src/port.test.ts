import { describe, it, expect } from 'vitest';
import * as net from 'node:net';
import { findFreePort } from './port.js';

function occupyPort(port: number): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(port, '127.0.0.1', () => resolve(server));
    server.on('error', reject);
  });
}

describe('findFreePort', () => {
  it('returns base port when it is free', async () => {
    const port = await findFreePort(49100);
    expect(port).toBe(49100);
  });

  it('skips occupied ports and returns next free one', async () => {
    const server = await occupyPort(49200);
    try {
      const port = await findFreePort(49200);
      expect(port).toBe(49201);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
