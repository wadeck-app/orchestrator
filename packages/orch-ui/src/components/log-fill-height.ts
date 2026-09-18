/**
 * How tall the log pane may be when it fills the log page.
 *
 * The pane claims the viewport minus the page chrome. That subtraction used to be a single
 * hand-summed magic number, `calc(100vh - 6.75rem)`, and it was wrong: it accounted for the
 * chrome ABOVE the pane but not the container's padding BELOW it, so the pane ended flush with
 * the bottom of the viewport and the page itself gained a 16px scrollbar - on a page whose whole
 * point is that only the log scrolls.
 *
 * The comment defending that number was wrong too, in a way that partly hid the error: it
 * attributed 2.25rem to the breadcrumb row, which actually occupies 52px with its gap, and 2rem
 * to "top and bottom p-4" while only the top one was really being subtracted. Two mistakes that
 * nearly cancelled.
 *
 * So the terms are named and summed here instead. A term that is forgotten is now a term that is
 * missing from a list, which a test can see - rather than a digit in a string that looks as
 * plausible as any other.
 *
 * Every value is measured in the browser at a 1440x900 viewport, against the real page.
 */

/** Contributors to the space the log pane cannot have, in pixels. */
export const LOG_PAGE_CHROME_PX = {
  /** NavBar, fixed height. */
  navBar: 40,
  /** PageContent's `p-4`, above the sections. */
  contentPaddingTop: 16,
  /** The LogPageBreadcrumb row plus the `space-y-4` gap that follows it. */
  breadcrumbRowAndGap: 52,
  /**
   * PageContent's `p-4`, below the sections.
   *
   * This is the one that was missing. It is not optional: the padding is still laid out after the
   * pane, so a pane sized without it pushes the document past the viewport by exactly this much.
   */
  contentPaddingBottom: 16,
} as const;

/** Root font size Tailwind's rem units resolve against. */
const REM_PX = 16;

export function logPageChromePx(): number {
  return Object.values(LOG_PAGE_CHROME_PX).reduce((sum, px) => sum + px, 0);
}

/**
 * The class that sizes the filling pane, derived from the sum above.
 *
 * NOT what the component uses. Tailwind scans source text for class names, so a class assembled at
 * runtime is a class Tailwind never sees and never emits - the element would carry an attribute
 * with no rule behind it, and the pane would silently have no height at all. This exists only so a
 * test can compare it against the literal below.
 */
export function logFillHeightClass(): string {
  return `h-[calc(100vh-${logPageChromePx() / REM_PX}rem)]`;
}

/**
 * The literal the component uses, written out so Tailwind generates the rule.
 *
 * Kept honest by a test asserting it equals `logFillHeightClass()`: change a term in the breakdown
 * without updating this, and the test fails rather than the layout.
 */
export const LOG_FILL_HEIGHT_CLASS = 'h-[calc(100vh-7.75rem)]';
