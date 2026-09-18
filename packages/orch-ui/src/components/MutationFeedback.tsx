import React from 'react';
import { useToast } from '@wadeck-app/dsl-ui';

/**
 * Where a success message waits while the browser navigates.
 *
 * The DSL's navigate brain assigns `window.location.href`, which is a FULL page load: React state,
 * and any toast in it, is destroyed. So a "saved" toast raised before the redirect can never be
 * seen. sessionStorage carries it across the load, and the next page that mounts this component
 * shows it - the ordinary flash-message pattern, for exactly the ordinary reason.
 */
const FLASH_KEY = 'orch.flash';
/**
 * A flash older than this is dropped instead of shown.
 *
 * Without it, a success that did NOT navigate (or a navigation that failed) would leave a message
 * in storage to be announced on some unrelated page minutes later, describing something the user
 * has long forgotten doing.
 */
const FLASH_MAX_AGE_MS = 10_000;

interface Flash {
  message: string;
  at: number;
}

function readFlash(): string | null {
  let raw: string | null = null;
  try {
    raw = sessionStorage.getItem(FLASH_KEY);
    sessionStorage.removeItem(FLASH_KEY);
  } catch {
    return null;   // storage disabled or unavailable; nothing to show
  }
  if (!raw) {
    return null;
  }
  try {
    const flash = JSON.parse(raw) as Flash;
    if (typeof flash.message !== 'string' || typeof flash.at !== 'number') {
      return null;
    }
    return Date.now() - flash.at <= FLASH_MAX_AGE_MS ? flash.message : null;
  } catch {
    return null;
  }
}

function writeFlash(message: string): void {
  try {
    sessionStorage.setItem(FLASH_KEY, JSON.stringify({ message, at: Date.now() } satisfies Flash));
  } catch {
    // Storage unavailable. The redirect still happens; only the confirmation is lost.
  }
}

export interface MutationFeedbackProps {
  /** `$brains.<id>.$pending` - true while the request is in flight. */
  pending?: boolean;
  /** `$brains.<id>.$error` - the failure message, or null. */
  error?: string | null;
  /** Announced once the mutation completes without error. */
  successMessage?: string;
}

/**
 * Turns a brain's progress into something the user can actually see.
 *
 * Renders nothing. It exists because a DSL page had no way to react to its own mutations: the brain
 * owns the request, so a rejection reached only the console and a success was indistinguishable from
 * a click that did nothing at all. dsl-renderer now publishes `$pending` and `$error` per brain, and
 * this is what a page binds them to.
 *
 * Generic rather than orchestrator-specific - nothing here knows what a job is - so it belongs in
 * dsl-ui once a second consumer wants it. Kept local until then, deliberately.
 *
 * @registryCategory composite
 * @registryTags toast feedback mutation notification
 */
export function MutationFeedback({ pending, error, successMessage }: MutationFeedbackProps): null {
  const toast = useToast();
  // Refs, not state: these drive an effect and must never themselves cause a render.
  const wasPending = React.useRef(false);
  const reportedError = React.useRef<string | null>(null);

  // A message left by the page we navigated away from.
  React.useEffect(() => {
    const flash = readFlash();
    if (flash) {
      toast.success(flash);
    }
    // Once, on mount. `toast` is rebuilt every render by its provider, so depending on it would
    // re-announce the flash on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  React.useEffect(() => {
    if (error && error !== reportedError.current) {
      // No navigation happens on failure, so this toast is seen where it is raised.
      reportedError.current = error;
      toast.error(error);
    }
    if (!error) {
      reportedError.current = null;
    }

    // The completion edge, not the pending state: firing on `!pending` alone would announce success
    // on first mount, before anything had been submitted.
    const justFinished = wasPending.current && pending === false;
    wasPending.current = pending === true;
    if (justFinished && !error && successMessage) {
      writeFlash(successMessage);
    }
  }, [pending, error, successMessage, toast]);

  return null;
}
