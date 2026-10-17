import type { FastifyInstance } from 'fastify';
import type { ModuleContext, ModuleRouteHandler } from '@wadeck-app/app-core-sdk';

/** `METHOD /path`, exactly as the route file registers it, e.g. `POST /api/jobs/:id/kill`. */
export type RouteKey = `${'GET' | 'POST' | 'PUT' | 'DELETE'} ${string}`;

type Verb = 'get' | 'post' | 'put' | 'delete';
const VERBS: readonly Verb[] = ['get', 'post', 'put', 'delete'];

export interface RouteAdapter {
  /** Stands in for the Fastify instance the route files expect; only get/post/put/delete exist. */
  app: FastifyInstance;
  /** Routes the route files tried to register that the allow-list does not cover. */
  skipped: string[];
  /**
   * Throws if an allowed route was never registered. Without it, a route renamed in orch-server
   * would simply vanish from the module and the page using it would 404 with no hint why.
   */
  assertAllRegistered: () => void;
}

/**
 * Lets orch-server's Fastify route files run inside an app-core module, where the only thing on
 * offer is `ctx.registerRoute(method, subPath, handler)`.
 *
 * It is a shim and deliberately not a fake Fastify: anything beyond the four verbs (hooks,
 * plugins, decorators) throws, because a module cannot honour it and silently ignoring it would
 * hide a route file that depends on it.
 *
 * `allowed` is an allow-list, not a deny-list: the dashboard server also exposes secrets and
 * exec, which no page needs, and a new route added there should not appear in the module
 * until someone decides it should.
 */
export function createRouteAdapter(
  ctx: Pick<ModuleContext, 'registerRoute'>,
  allowed: readonly RouteKey[],
): RouteAdapter {
  const allowedSet = new Set<string>(allowed);
  const registered = new Set<string>();
  const skipped: string[] = [];

  const target: Record<string, unknown> = {};
  for (const verb of VERBS) {
    target[verb] = (path: string, ...rest: unknown[]): void => {
      const handler = rest[rest.length - 1] as ModuleRouteHandler;
      const key = `${verb.toUpperCase()} ${path}`;
      if (!allowedSet.has(key)) {
        skipped.push(key);
        return;
      }
      registered.add(key);
      ctx.registerRoute(verb.toUpperCase(), path, handler);
    };
  }

  const app = new Proxy(target, {
    get(obj, prop) {
      if (typeof prop === 'string' && prop in obj) {
        return obj[prop];
      }
      if (typeof prop === 'symbol' || prop === 'then') {
        return undefined;
      }
      return () => {
        throw new Error(
          `app-module-orchestrator: fastify.${prop}() is not supported in a module (only ${VERBS.join('/')} exist), and a route file called it. ` +
          'Extend createRouteAdapter if this is intended, instead of ignoring the call.',
        );
      };
    },
  }) as unknown as FastifyInstance;

  return {
    app,
    skipped,
    assertAllRegistered: () => {
      const missing = allowed.filter(key => !registered.has(key));
      if (missing.length > 0) {
        throw new Error(
          `app-module-orchestrator: ${missing.length} allowed route(s) were never registered by orch-server's route files: ${missing.join(', ')}. ` +
          'They were probably renamed or removed there; update ALLOWED_ROUTES.',
        );
      }
    },
  };
}
