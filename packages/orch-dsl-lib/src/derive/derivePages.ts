export interface DeriveOptions {
  /** The module id app-core prefixes component types with: `<moduleId>:<Name>`. */
  moduleId: string;
  /** Where the module's pages are mounted, e.g. `/modules/orchestrator`. No trailing slash. */
  routePrefix: string;
  /** Where the module's API is mounted, e.g. `/api/modules/orchestrator`. No trailing slash. */
  apiPrefix: string;
  /** Component types that live in the module's dsl-lib; every other type is a dsl-ui built-in. */
  orchTypes: ReadonlySet<string>;
}

const URL_LINE = /^(\s*url:\s*)(GET|POST|PUT|DELETE|PATCH)\s+(\S+)(.*)$/;
const NAV_LINE = /^(\s*(?:to|route):\s*)(\S+)(.*)$/;
const TYPE_RE = /(\$type:\s*)(\w+)/g;

/**
 * Rewrites one of orch-app's page files for where the module mounts it.
 *
 * Textual on purpose. Parsing and re-dumping the YAML would drop the comments, and those say why a
 * page is shaped the way it is (why Run now is posted by the component, why a brain cannot read a
 * refusal). Every rule is a line pattern, and a line it cannot place throws: a call left unprefixed
 * would reach app-core's own server and a link left unprefixed would leave the module, both
 * without any error to point at the page.
 */
export function derivePage(yaml: string, opts: DeriveOptions): string {
  const lines = yaml.replace(/\r\n/g, '\n').split('\n');

  const routeIdx = lines.findIndex(line => line.trim() !== '' && !line.trimStart().startsWith('#'));
  if (routeIdx === -1 || !lines[routeIdx]!.startsWith('$route:')) {
    throw new Error('derivePage: the page does not start with a $route line, so it is not one of orch-app\'s routed pages.');
  }
  lines.splice(routeIdx, lines[routeIdx + 1]?.trim() === '' ? 2 : 1);

  return lines
    .map((line, i) => rewriteLine(line, i + 1, opts))
    .join('\n');
}

function rewriteLine(line: string, lineNo: number, opts: DeriveOptions): string {
  const url = URL_LINE.exec(line);
  if (url) {
    const [, head, method, target, rest] = url;
    if (!target!.startsWith('/api/')) {
      throw new Error(`derivePage: line ${lineNo}: cannot place "url: ${method} ${target}", only /api/... paths belong to the module's API. Line: ${line.trim()}`);
    }
    return `${head}${method} ${opts.apiPrefix}${target}${rest}`;
  }

  const nav = NAV_LINE.exec(line);
  if (nav) {
    const [, head, target, rest] = nav;
    if (!target!.startsWith('/')) {
      throw new Error(`derivePage: line ${lineNo}: cannot place the navigation target "${target}" (to:/route:), it must be an absolute path. Line: ${line.trim()}`);
    }
    return `${head}${opts.routePrefix}${target}${rest}`;
  }

  return line.replace(TYPE_RE, (whole, head: string, name: string) =>
    opts.orchTypes.has(name) ? `${head}${opts.moduleId}:${name}` : whole);
}
