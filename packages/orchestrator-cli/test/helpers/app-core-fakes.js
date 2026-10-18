'use strict';
import http from 'node:http';
import net from 'node:net';

/** A port nothing listens on: bind an ephemeral one and release it. */
export async function deadPort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

/**
 * A stand-in for app-core's HTTP server: answers with `handler` and records every request it got
 * (method, url, parsed JSON body), so a test can assert on what the daemon actually sent.
 */
export async function fakeAppCore(handler) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, body: body === '' ? undefined : JSON.parse(body) });
      handler(req, res);
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    port: server.address().port,
    seen,
    close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }),
  };
}
