export interface OrchUiConfig {
  /**
   * Prefix put in front of every `/api/...` call. Empty means same origin, as in orch-app. The
   * app-core module bundle sets it to its own route prefix, since there the API is not at `/api`.
   */
  apiBase?: string;
  /**
   * Prefix put in front of every in-app link and navigation (`/jobs/...`). Empty means the pages
   * are mounted at the root, as in orch-app. Inside an app-core module they live under
   * `/modules/<id>`.
   */
  routeBase?: string;
}

let apiBase = '';
let routeBase = '';

/**
 * A prefix is either empty or an absolute path with no trailing slash, because every caller appends
 * its own leading-slash path. Anything else is refused rather than repaired: a silently normalised
 * prefix hides the misconfiguration until a request or a link goes to the wrong place.
 */
function checkBase(name: string, value: string, example: string): void {
  if (value !== '' && !value.startsWith('/')) {
    throw new Error(`orch-ui ${name} must start with "/" (got "${value}"); use e.g. "${example}".`);
  }
  if (value.endsWith('/')) {
    throw new Error(`orch-ui ${name} must not end with a trailing slash (got "${value}"), callers append their own "/path".`);
  }
}

/**
 * Sets the process-wide defaults. Meant to be called once, by whatever bundles orch-ui for a host
 * that is not orch-app. A bundle carries its own copy of this module, so configuring one host never
 * leaks into another.
 *
 * Validates everything before applying anything, so a rejected call leaves the config untouched.
 */
export function configureOrchUi(config: OrchUiConfig): void {
  if (config.apiBase !== undefined) {
    checkBase('apiBase', config.apiBase, '/api/modules/orchestrator');
  }
  if (config.routeBase !== undefined) {
    checkBase('routeBase', config.routeBase, '/modules/orchestrator');
  }
  if (config.apiBase !== undefined) {
    apiBase = config.apiBase;
  }
  if (config.routeBase !== undefined) {
    routeBase = config.routeBase;
  }
}

/** The configured prefix for `/api/...` calls; `''` when nothing was configured. */
export function getApiBase(): string {
  return apiBase;
}

/** The configured prefix for in-app links and navigations; `''` when nothing was configured. */
export function getRouteBase(): string {
  return routeBase;
}

/** An in-app path (`/jobs/j1`) with the configured route prefix in front of it. */
export function appPath(path: string): string {
  return `${routeBase}${path}`;
}

/** Back to the defaults. For tests: the config is module state and would otherwise leak between them. */
export function resetOrchUiConfig(): void {
  apiBase = '';
  routeBase = '';
}
