/**
 * Where the module lives in app-core. One definition, because the id appears in three places that must
 * agree: the prefix of every component type, the module's API, and the module's pages. The daemon
 * registers the module under this same id.
 */
export const MODULE_ID = 'orchestrator';

/** Prefix of the module's backend routes (`/api/modules/<id>`), where app-core mounts registerRoute. */
export const API_BASE = `/api/modules/${MODULE_ID}`;

/** Prefix of the module's pages (`/modules/<id>`), where the shell mounts its extension points. */
export const ROUTE_BASE = `/modules/${MODULE_ID}`;
