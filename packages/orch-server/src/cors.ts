// The dashboard is a local-only tool, so only loopback origins are allowed.
// URL.hostname keeps the brackets around an IPv6 literal, so '[::1]' is the
// form actually compared - the bare '::1' spelling never reaches this set.
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

/**
 * True when `origin` may read the dashboard API cross-origin.
 *
 * A missing origin means the request is same-origin (or not a browser), which
 * the browser never labels - those are always allowed.
 *
 * The host is compared exactly rather than by prefix: a prefix test against
 * 'http://localhost' also accepts 'http://localhost.evil.com', an
 * attacker-controlled domain that can resolve to the loopback interface.
 */
export function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) return true;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  return ALLOWED_PROTOCOLS.has(url.protocol) && LOOPBACK_HOSTS.has(url.hostname);
}
