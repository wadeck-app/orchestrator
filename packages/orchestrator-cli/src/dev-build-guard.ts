// A release is stamped by CI as YYYY.M.D-BBB-xxxxxxxx: year, month and day without leading zeros (npm
// rejects them), a zero-padded build number of 3+ digits, and an 8-char lowercase hex commit hash.
// Anything else (0.2.0, the 0.0.0-dev an unbundled updater carries, a "-local-dev" display version) is a
// repo-built dev bundle. Strict on purpose: a false "release" lets a dev build run `npm install -g`, a
// false "dev" only makes an update refuse loudly.
const RELEASE_RE = /^\d{4}\.\d{1,2}\.\d{1,2}-\d{3,}-[0-9a-f]{8}$/;

export function isReleaseVersion(version: unknown): boolean {
  return typeof version === 'string' && RELEASE_RE.test(version);
}

/**
 * Printed (and logged) when a non-release build is asked to update. Such a build is older than every
 * published version, so the updater would always find an "update" and run `npm install -g` over the
 * user's install; an install killed halfway leaves the CLI uninstalled (incident 2026-10-24).
 */
export function devBuildRefusalMessage(version: string): string {
  return `this is a development build (version ${version}): it does not update the global install; `
    + `run it from the repo or install the published package (npm install -g @wadeck-app/orchestrator-cli)`;
}
