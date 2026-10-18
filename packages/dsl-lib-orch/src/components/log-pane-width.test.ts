import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { readWidePane, setWidePane, useWidePane, widthClass, NARROW_CLASS, WIDE_CLASS } from './log-pane-width.js';

describe('the log page width preference', () => {
  beforeEach(() => { localStorage.clear(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('starts on the narrow reading column, as the page was before the toggle', () => {
    expect(readWidePane()).toBe(false);
    expect(widthClass(false)).toBe(NARROW_CLASS);
  });

  it('remembers the choice across mounts, which is the whole point', () => {
    const first = renderHook(() => useWidePane());
    act(() => { first.result.current[1](); });
    expect(first.result.current[0]).toBe(true);
    first.unmount();

    // A fresh mount reads storage, not a leftover module variable.
    const second = renderHook(() => useWidePane());
    expect(second.result.current[0]).toBe(true);
    expect(widthClass(second.result.current[0])).toBe(WIDE_CLASS);
  });

  // The breadcrumb row and the pane are siblings on the DSL page, so neither can own the state for
  // the other. If they did not update together, flipping the toggle would align one and not the other.
  it('moves every subscriber at once, so siblings cannot disagree', () => {
    const pane      = renderHook(() => useWidePane());
    const breadcrumb = renderHook(() => useWidePane());

    act(() => { pane.result.current[1](); });

    expect(pane.result.current[0]).toBe(true);
    expect(breadcrumb.result.current[0]).toBe(true);
  });

  // Safari private mode and blocked third-party contexts throw on access rather than returning null.
  // A layout preference must never be the reason a log pane fails to render.
  it('survives a localStorage that throws', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new Error('denied'); },
      setItem: () => { throw new Error('denied'); },
    });

    expect(readWidePane()).toBe(false);
    // Still applies for this visit, and does not throw out of the setter.
    const { result } = renderHook(() => useWidePane());
    act(() => { result.current[1](); });
    expect(result.current[0]).toBe(true);
  });

  afterEach(() => { setWidePane(false); });
});
