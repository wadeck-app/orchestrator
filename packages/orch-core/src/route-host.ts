/*
 * The seam between the shared route logic and whoever serves it.
 *
 * orch-server registers these routes on a Fastify instance; app-module-orchestrator registers them
 * through app-core's `ctx.registerRoute`. Both hand over something shaped like the types below, which
 * are a structural subset of Fastify's request, reply and instance. Nothing here imports Fastify: a
 * real FastifyInstance satisfies RouteHost, and so does the module's adapter.
 *
 * Deliberately only what the route files use. Widening it is a decision, because every controller then
 * has to be able to honour the new capability.
 */

export interface RouteRequest {
  params: unknown;
  query: unknown;
  body: unknown;
  headers: Record<string, string | string[] | undefined>;
  ip: string;
  /** The underlying Node request; only its `close` event is used (a stream reader going away). */
  raw: { on(event: 'close', listener: () => void): unknown };
}

export interface RouteReply {
  code(statusCode: number): RouteReply;
  header(name: string, value: string): RouteReply;
  send(payload?: unknown): RouteReply;
  /** Takes the response away from the framework, for the handler that streams (SSE) on `raw`. */
  hijack(): unknown;
  /** The underlying Node response; only used after `hijack()`. */
  raw: {
    writeHead(statusCode: number, headers: Record<string, string>): unknown;
    write(chunk: string): unknown;
  };
}

export type RouteHandler = (req: RouteRequest, reply: RouteReply) => Promise<unknown>;

/** Registration of one route. The path syntax is Fastify's (`/api/jobs/:id`). */
export type RouteRegistrar = (path: string, handler: RouteHandler) => unknown;

export interface RouteHost {
  get: RouteRegistrar;
  post: RouteRegistrar;
  put: RouteRegistrar;
  delete: RouteRegistrar;
}

/**
 * What the routes need of a dashboard's idle exit. The dashboard server passes its real IdleTimer; a
 * host with no idle exit (an app-core module) passes no-ops.
 */
export interface IdleSignal {
  reset(): void;
  addSseConnection(): void;
  removeSseConnection(): void;
}
