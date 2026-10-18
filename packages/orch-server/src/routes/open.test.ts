import fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openRoute, resolveOpenTarget, type FsProbe } from './open.js';

/*
 * /api/open launches whatever the OS associates with a path. It used to be `cmd.exe /c start "" <path>`
 * behind a check that only looked at how the path BEGAN, which let `C:\a & calc.exe` through to cmd; it
 * was a plain GET, which a web page can fire at 127.0.0.1 from the user's own browser (CORS only stops
 * the page from READING the answer); it decoded the path a second time after checking it; and
 * "http://localhost.evil.com" passed for localhost. These tests hold the route to being a way to look at
 * a file, and nothing else.
 */
const fsProbe = (opts: { directories?: string[] } = {}): FsProbe => ({
  isDirectory: (p) => (opts.directories ?? []).includes(p),
});

describe('resolveOpenTarget: what may be opened', () => {
  it.each([
    ['a Windows path to a log', 'C:\\logs\\app.log'],
    ['the same with forward slashes', 'C:/logs/app.log'],
    ['a file URL', 'file:///C:/logs/app.log'],
    ['a text file', 'C:\\data\\notes.TXT'],
    ['a JSON report', 'C:\\data\\report.json'],
    ['a POSIX path', '/var/log/app.log'],
    ['a page on localhost', 'http://localhost:3000/report'],
    ['a page on 127.0.0.1', 'http://127.0.0.1:8080/'],
    ['a page on localhost over https', 'https://localhost/x'],
  ])('allows %s', (_label, raw) => {
    expect(resolveOpenTarget(raw, fsProbe()).ok).toBe(true);
  });

  it('allows a folder, which is how a reader reaches a directory of output', () => {
    expect(resolveOpenTarget('C:\\data\\out', fsProbe({ directories: ['C:\\data\\out'] })).ok).toBe(true);
  });

  it.each([
    ['a remote page', 'https://evil.example/x'],
    ['a host that merely starts with localhost', 'http://localhost.evil.example/x'],
    ['a URL with credentials that makes localhost the user part', 'http://localhost@evil.example/'],
    ['a UNC path, which would send the user\'s credentials to another machine', '\\\\evil\\share\\x.log'],
    ['a file URL with a host', 'file://evil/share/x.log'],
    ['a relative path', 'logs/app.log'],
    ['an empty path', ''],
  ])('refuses %s', (_label, raw) => {
    const decision = resolveOpenTarget(raw, fsProbe());
    expect(decision.ok).toBe(false);
  });

  it.each(['&', '|', '^', '%', '<', '>', '"', '`', '\n', '\r', '\0'])('refuses a path with %j, which a shell reads as a command', (ch) => {
    const decision = resolveOpenTarget(`C:\\logs\\a${ch}calc.exe.log`, fsProbe());
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.reason).toMatch(/character/i);
    }
  });

  it.each(['exe', 'bat', 'cmd', 'com', 'ps1', 'vbs', 'js', 'jar', 'msi', 'lnk', 'scr', 'hta', 'reg', 'dll', 'sh', 'app'])(
    'refuses a .%s file: opening it would run it, not show it',
    (ext) => {
      const decision = resolveOpenTarget(`C:\\Windows\\System32\\thing.${ext}`, fsProbe());
      expect(decision.ok).toBe(false);
      if (!decision.ok) {
        expect(decision.reason).toMatch(/not.*open|run/i);
      }
    },
  );

  it('refuses a file with no extension that is not a folder', () => {
    expect(resolveOpenTarget('C:\\data\\mystery', fsProbe()).ok).toBe(false);
  });

  it('returns what to hand to the OS: a file URL for a path, the URL itself otherwise', () => {
    const win = resolveOpenTarget('C:\\logs\\app.log', fsProbe());
    expect(win.ok && win.target).toBe('file:///C:/logs/app.log');
    const web = resolveOpenTarget('http://localhost:3000/report', fsProbe());
    expect(web.ok && web.target).toBe('http://localhost:3000/report');
  });
});

describe('GET /api/open', () => {
  let app: FastifyInstance;
  let opened: string[];
  let resets: number;

  beforeEach(async () => {
    app = fastify();
    opened = [];
    resets = 0;
    await app.register(openRoute, {
      idleTimer: { reset: () => { resets++; } },
      open: async (target) => { opened.push(target); },
      fs: fsProbe(),
    });
    await app.ready();
  });
  afterEach(async () => { await app.close(); });

  const get = (query: string, headers: Record<string, string> = {}) =>
    app.inject({ method: 'GET', url: `/api/open?path=${encodeURIComponent(query)}`, headers });

  it('opens an allowed file and answers 204', async () => {
    const res = await get('file:///C:/logs/app.log');
    expect(res.statusCode).toBe(204);
    expect(opened).toEqual(['file:///C:/logs/app.log']);
    expect(resets).toBe(1);
  });

  it('answers 400 when no path is given', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/open' });
    expect(res.statusCode).toBe(400);
    expect(opened).toEqual([]);
  });

  it('answers 403 with the reason, and opens nothing, for a path it refuses', async () => {
    const res = await get('C:\\a & calc.exe');
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toMatch(/character/i);
    expect(opened).toEqual([]);
  });

  it('does not decode the path a second time: %26 stays a literal, it does not become &', async () => {
    // Sent as the text "C:\logs\a%26calc.log" (the query carries %2526). Decoded twice it would be
    // "C:\logs\a&calc.log", which a shell would run.
    const res = await get('C:\\logs\\a%26calc.log');
    expect(res.statusCode).toBe(403);
    expect(opened).toEqual([]);
  });

  it.each(['cross-site', 'same-site'])('refuses a request a page on another site made (Sec-Fetch-Site: %s)', async (site) => {
    const res = await get('file:///C:/logs/app.log', { 'sec-fetch-site': site });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toMatch(/another site|cross-site/i);
    expect(opened).toEqual([]);
  });

  it.each(['same-origin', 'none'])('accepts a request that comes from the dashboard itself (Sec-Fetch-Site: %s)', async (site) => {
    const res = await get('file:///C:/logs/app.log', { 'sec-fetch-site': site });
    expect(res.statusCode).toBe(204);
  });

  it('accepts a request with no Sec-Fetch-Site, as a command-line client sends', async () => {
    const res = await get('file:///C:/logs/app.log');
    expect(res.statusCode).toBe(204);
  });
});
