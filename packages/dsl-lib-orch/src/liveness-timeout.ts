// The daemon's rules for liveness.timeoutSeconds (orchestrator-cli registry.ts, types.ts), copied because the form cannot import
// the CLI. test/liveness-timeout-parity.test.ts compares the two: change both together.
export const LIVENESS_TIMEOUT_MIN_SECONDS = 1;
export const LIVENESS_TIMEOUT_MAX_SECONDS = 3600;
export const LIVENESS_TIMEOUT_DEFAULT_SECONDS = 30;

/** The daemon's refusal of liveness.timeoutSeconds, in its words, for what was typed; null when it is empty or valid. */
export function livenessTimeoutError(text: string): string | null {
  if (text.trim() === '') {
    return null;
  }
  const n = Number(text);
  if (Number.isInteger(n) && n >= LIVENESS_TIMEOUT_MIN_SECONDS && n <= LIVENESS_TIMEOUT_MAX_SECONDS) {
    return null;
  }
  return `liveness.timeoutSeconds must be a whole number of seconds from ${LIVENESS_TIMEOUT_MIN_SECONDS} to ${LIVENESS_TIMEOUT_MAX_SECONDS}, got ${text.trim()}. Fix it, or empty the box for the default of ${LIVENESS_TIMEOUT_DEFAULT_SECONDS} s`;
}
