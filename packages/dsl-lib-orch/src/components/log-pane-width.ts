import { useEffect, useState } from 'react';

/*
 * How wide the log page runs: the default reading column, or the whole viewport.
 *
 * A log line is long and a terminal pane is the one place on this dashboard where the reading-column
 * width works against the reader - but it is still a preference, not a rule, so it is remembered.
 *
 * Shared through a module-level store rather than owned by the pane, because two sibling sections
 * (the breadcrumb row and the pane) have to agree on the width. Passing it down is not an option:
 * the DSL page lists them as siblings, so neither can hold the state for the other, and a width kept
 * in one of them would leave the other misaligned.
 */

const STORAGE_KEY = 'orch.logs.widePane';

type Listener = (wide: boolean) => void;

const listeners = new Set<Listener>();

/**
 * Reads the stored preference.
 *
 * localStorage throws rather than returning null in a few real cases - Safari private mode, a
 * blocked third-party context - and a log pane must not fail to render over a layout preference.
 * The default is the narrow column, which is what the page did before the toggle existed.
 */
export function readWidePane(): boolean {
  try {
    return globalThis.localStorage?.getItem(STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

/** Stores the preference and tells every mounted subscriber, so siblings stay aligned. */
export function setWidePane(wide: boolean): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, String(wide));
  } catch {
    // A preference that cannot be persisted still applies for this visit.
  }
  for (const l of listeners) l(wide);
}

/** The width preference, and a way to flip it. Every caller re-renders together. */
export function useWidePane(): [boolean, () => void] {
  const [wide, setWide] = useState<boolean>(readWidePane);

  useEffect(() => {
    listeners.add(setWide);
    return () => { listeners.delete(setWide); };
  }, []);

  return [wide, () => { setWidePane(!wide); }];
}

// The narrow column matches PageContent's own default (xl / max-w-6xl), so turning the toggle off
// restores exactly the page that existed before it. The page itself is set to `full` and delegates
// the decision here - two places claiming the width is how they would drift.
export const NARROW_CLASS = 'mx-auto w-full max-w-6xl';
export const WIDE_CLASS   = 'w-full';

/** The container class for the current preference. */
export function widthClass(wide: boolean): string {
  return wide ? WIDE_CLASS : NARROW_CLASS;
}
