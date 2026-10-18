import { describe, it, expect } from 'vitest';
import {
  LOG_PAGE_CHROME_PX,
  logPageChromePx,
  logFillHeightClass,
  LOG_FILL_HEIGHT_CLASS,
} from './log-fill-height.js';

/*
 * Reported: on /jobs/:id/logs the page itself grew a scrollbar, when only the log should scroll.
 *
 * Measured in the browser at 1440x900 before the fix: document scrollHeight 916 against a 900
 * viewport, so the page overflowed by exactly 16px - the container's bottom padding, which the
 * pane's height calc never subtracted.
 *
 * jsdom does no layout, so these tests hold the arithmetic rather than the rendering. That is the
 * part that was wrong: the number was hand-summed and one term was simply absent.
 */

describe('log pane fill height', () => {
  // The regression itself. The pane sits above this padding, so a height that ignores it makes the
  // document taller than the viewport by precisely this much.
  it('subtracts the container padding below the pane, not only above it', () => {
    expect(LOG_PAGE_CHROME_PX.contentPaddingBottom).toBe(16);
    expect(LOG_PAGE_CHROME_PX.contentPaddingTop).toBe(16);
  });

  it('sums to the measured chrome of the log page', () => {
    // 40 navbar + 16 top padding + 52 breadcrumb row and gap + 16 bottom padding.
    expect(logPageChromePx()).toBe(124);
  });

  it('leaves no overflow at the viewport height the bug was measured at', () => {
    const viewport = 900;
    const paneTop = LOG_PAGE_CHROME_PX.navBar
      + LOG_PAGE_CHROME_PX.contentPaddingTop
      + LOG_PAGE_CHROME_PX.breadcrumbRowAndGap;
    const paneHeight = viewport - logPageChromePx();

    // What the document ends up being: everything above the pane, the pane, and the padding after.
    const documentHeight = paneTop + paneHeight + LOG_PAGE_CHROME_PX.contentPaddingBottom;

    expect(documentHeight).toBe(viewport);
  });

  // The old value, kept as a named regression. 6.75rem is 108px, which is the chrome ABOVE the
  // pane and nothing else - it is what "forgot the bottom padding" looks like as a number.
  it('is not the old 6.75rem, which was the top chrome alone', () => {
    expect(logPageChromePx()).not.toBe(108);
    expect(logFillHeightClass()).not.toContain('6.75rem');
  });

  it('renders a Tailwind arbitrary height built from the sum', () => {
    expect(logFillHeightClass()).toBe('h-[calc(100vh-7.75rem)]');
  });

  // The literal the component actually uses has to match the arithmetic. It cannot be generated:
  // Tailwind scans source text, so a runtime-assembled class produces no CSS rule and the pane
  // would have no height whatsoever. This test is what keeps the two in step.
  it('keeps the literal the component uses equal to the derived one', () => {
    expect(LOG_FILL_HEIGHT_CLASS).toBe(logFillHeightClass());
  });

  // Guards the guard: a breakdown that silently lost a key would still sum to something, and every
  // assertion above would keep passing on a smaller total.
  it('names every contributor, so a dropped term is visible', () => {
    expect(Object.keys(LOG_PAGE_CHROME_PX)).toEqual([
      'navBar',
      'contentPaddingTop',
      'breadcrumbRowAndGap',
      'contentPaddingBottom',
    ]);
    expect(Object.values(LOG_PAGE_CHROME_PX).every(px => px > 0)).toBe(true);
  });
});
