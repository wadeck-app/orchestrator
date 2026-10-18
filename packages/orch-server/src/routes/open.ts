import * as fs from 'node:fs';
import { execFile } from 'node:child_process';
import type { FastifyInstance } from 'fastify';
import type { IdleTimer } from '../idle-timer.js';

/**
 * Lets the dashboard open a file or a localhost page with the OS default handler. Chrome will not
 * follow a file:// link from an http:// page, so the log viewer asks the server to do it.
 *
 * That makes it the one route in this server that starts something on the machine, so it is held to
 * being a way to LOOK at a file:
 *
 * - Only documents and folders. Opening an .exe or a .bat is running it, and the reader of a log has
 *   no use for that.
 * - No shell. The old version was `cmd.exe /c start "" <path>`, which let a second command through after
 *   an ampersand because only the beginning of the path was checked. The opener below takes the target as one
 *   argument, and the shell metacharacters are refused as well in case that ever changes.
 * - Not from another site. This is a GET, and a web page can send a GET to 127.0.0.1 from the user's own
 *   browser; CORS only keeps the page from reading the answer. Browsers say where a request came from in
 *   Sec-Fetch-Site, and anything that is not the dashboard itself is refused.
 * - Decoded once. The path used to be run through decodeURIComponent after Fastify had already decoded
 *   it, so `%2526` became `&` after the check.
 * - Local only: no UNC path (opening one sends the user's credentials to another machine), no remote
 *   host, and "localhost" means the host, not the start of a string (`localhost.evil.example`).
 */

/** What a reader can usefully be shown. Deliberately a list of what is allowed, not of what is not. */
const OPENABLE_EXTENSIONS = new Set([
  'log', 'txt', 'json', 'ndjson', 'md', 'csv', 'tsv', 'xml', 'yml', 'yaml', 'html', 'htm',
  'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'pdf',
]);

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Characters a shell reads as syntax, plus control characters. None belongs in a path worth opening. */
// eslint-disable-next-line no-control-regex
const FORBIDDEN_IN_PATH = /[&|^%<>"`\u0000-\u001f]/;

export interface FsProbe {
  isDirectory: (path: string) => boolean;
}

export type OpenDecision =
  | { ok: true; target: string }
  | { ok: false; reason: string };

const refuse = (reason: string): OpenDecision => ({ ok: false, reason });

function extensionOf(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? '';
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase();
}

function toFileHref(path: string): string {
  const posixy = path.replace(/\\/g, '/').replace(/#/g, '%23').replace(/\?/g, '%3F');
  return new URL(/^[A-Za-z]:/.test(posixy) ? `file:///${posixy}` : `file://${posixy}`).href;
}

/**
 * Decides whether a path or URL may be opened, and what to hand to the OS if so. Pure: the one thing it
 * needs from the machine (is this a folder) comes in as `probe`, so a test never touches the disk.
 */
export function resolveOpenTarget(raw: string, probe: FsProbe): OpenDecision {
  const input = raw.trim();
  if (input === '') {
    return refuse('path required');
  }

  if (/^https?:\/\//i.test(input)) {
    let url: URL;
    try {
      url = new URL(input);
    } catch {
      return refuse(`"${input}" is not a valid URL`);
    }
    if (!LOCAL_HOSTS.has(url.hostname) || url.username !== '' || url.password !== '') {
      return refuse('only local files and localhost pages can be opened, not a remote address');
    }
    return { ok: true, target: url.href };
  }

  let path = input;
  if (/^file:/i.test(input)) {
    if (!/^file:\/\/\//i.test(input)) {
      return refuse('only local files can be opened: a file URL with a host names another machine');
    }
    const rest = input.slice('file:///'.length);
    try {
      // Decoded exactly once, here, and the result is what gets checked below.
      path = decodeURIComponent(rest);
    } catch {
      return refuse('the file URL is not validly encoded');
    }
    path = /^[A-Za-z]:[\\/]/.test(path) ? path : `/${path}`;
  }

  if (/^(\\\\|\/\/)/.test(path)) {
    return refuse('a network path (UNC) cannot be opened: doing so would hand the user\'s credentials to another machine');
  }
  if (!/^([A-Za-z]:[\\/]|\/)/.test(path)) {
    return refuse('only an absolute local path can be opened');
  }
  if (FORBIDDEN_IN_PATH.test(path)) {
    return refuse('the path contains a character a shell treats as a command (one of & | ^ % < > " `, or a control character), so it is not opened');
  }

  if (!probe.isDirectory(path)) {
    const ext = extensionOf(path);
    if (!OPENABLE_EXTENSIONS.has(ext)) {
      return refuse(ext === ''
        ? 'a file with no extension is not opened: it cannot be told apart from a program'
        : `".${ext}" files are not opened: opening one may run it. Only documents (${[...OPENABLE_EXTENSIONS].slice(0, 6).join(', ')}, ...) and folders can be opened.`);
    }
  }
  return { ok: true, target: toFileHref(path) };
}

export interface OpenRouteDeps {
  idleTimer: Pick<IdleTimer, 'reset'>;
  /** Hands a target to the OS. Replaceable so a test opens nothing. */
  open?: (target: string) => Promise<void>;
  fs?: FsProbe;
}

const realFs: FsProbe = {
  isDirectory: (path) => {
    try {
      return fs.statSync(path).isDirectory();
    } catch {
      return false;
    }
  },
};

/**
 * The OS default handler, started without a shell. rundll32's FileProtocolHandler on Windows because it
 * takes the target as a single argument that nothing re-parses; cmd.exe would.
 */
export function openWithOs(target: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = (err: Error | null): void => (err ? reject(err) : resolve());
    if (process.platform === 'win32') {
      // windowsHide is explicitly false, not merely absent: this endpoint exists to reveal a file or
      // URL to the user, so the handler it launches has to be allowed to show itself.
      // violations-suppress: cli/daemon-spawn-no-windows-hide,cli/no-spawn-without-windows-hide opening something for the user IS the feature
      execFile('rundll32.exe', ['url.dll,FileProtocolHandler', target], { windowsHide: false }, done);
    } else if (process.platform === 'darwin') {
      // violations-suppress: cli/daemon-spawn-no-windows-hide,cli/no-spawn-without-windows-hide windowsHide has no meaning off Windows
      execFile('open', [target], done);
    } else {
      // violations-suppress: cli/daemon-spawn-no-windows-hide,cli/no-spawn-without-windows-hide windowsHide has no meaning off Windows
      execFile('xdg-open', [target], done);
    }
  });
}

function describeError(err: unknown): string {
  if (err instanceof Error) {
    // violations-suppress: ts/no-err-message-direct instanceof-guarded accessor, the one place in this file where .message is correct
    return err.message;
  }
  return String(err);
}

export async function openRoute(fastify: FastifyInstance, opts: OpenRouteDeps): Promise<void> {
  const { idleTimer, open = openWithOs, fs: probe = realFs } = opts;

  fastify.get('/api/open', async (req, reply) => {
    const site = req.headers['sec-fetch-site'];
    if (typeof site === 'string' && site !== 'same-origin' && site !== 'none') {
      return reply.code(403).send({ error: `refused: this request came from another site (Sec-Fetch-Site: ${site}); only the dashboard itself may open files` });
    }
    const { path: rawPath } = req.query as { path?: string };
    if (!rawPath) {
      return reply.code(400).send({ error: 'path required' });
    }
    idleTimer.reset();

    const decision = resolveOpenTarget(rawPath, probe);
    if (!decision.ok) {
      return reply.code(403).send({ error: decision.reason });
    }
    try {
      await open(decision.target);
    } catch (err) {
      return reply.code(500).send({ error: `could not open ${decision.target}: ${describeError(err)}` });
    }
    return reply.code(204).send();
  });
}
