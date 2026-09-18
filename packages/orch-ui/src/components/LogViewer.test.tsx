import React from 'react';
import { render, screen, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { LogViewer } from './LogViewer.js';

const renderInRouter = (ui: React.ReactElement) =>
  render(<MemoryRouter>{ui}</MemoryRouter>);

class MockEventSource {
  static instance: MockEventSource | null = null;
  onopen:   (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror:   (() => void) | null = null;
  constructor(public url: string) { MockEventSource.instance = this; }
  close() {}
}

describe('LogViewer', () => {
  afterEach(() => {
    MockEventSource.instance = null;
    vi.unstubAllGlobals();
  });

  it('shows "Connecting..." once in the header before connection opens', () => {
    vi.stubGlobal('EventSource', MockEventSource);
    renderInRouter(<LogViewer jobId="whatsapp-10h" />);

    // Only the header should say "Connecting..." - not the body
    expect(screen.getAllByText('Connecting...')).toHaveLength(1);
    // Body should be empty (no duplicate)
    const pre = document.querySelector('pre');
    expect(pre?.textContent?.trim()).toBe('');
  });

  // The widget keeps its dark terminal palette in both app themes, so it must
  // not inherit the app's color-scheme: in light theme that paints a white
  // scrollbar over the near-black pane. It pins the dark scheme on the root and
  // lets the scroll pane and the toolbar's native controls inherit it.
  //
  // Asserted on the class name, not getComputedStyle: Tailwind never runs in the
  // test pipeline, so jsdom resolves no stylesheet and a computed-style check
  // would pass against an empty cascade. Real rendering is verified in-browser.
  it('pins a dark color-scheme covering the scroll pane and toolbar controls', () => {
    vi.stubGlobal('EventSource', MockEventSource);
    const { container } = renderInRouter(<LogViewer jobId="j1" />);

    const root = container.firstElementChild as HTMLElement;
    // Asserted as "the pane is in a dark theme scope", not as a particular utility class. It used
    // to require the literal `[color-scheme:dark]`, which broke when dsl-ui's ThemeScope took over
    // the job - the behaviour was identical and only the mechanism moved, so the test was pinning
    // the wrong thing.
    expect(root.getAttribute('data-theme-scope')).toBe('dark');

    // The terminal palette has to come with it, or the scheme is right and the surfaces are not.
    expect(root.style.getPropertyValue('--color-bg')).toBe('#111827');

    // The scroll container must sit inside that subtree for inheritance to reach it.
    const pre = root.querySelector('pre');
    expect(pre).not.toBeNull();
    expect(pre!.className).toMatch(/overflow-auto/);
  });

  // The 75vh cap is a fallback for hosts that give the widget no height: without
  // it `h-full` resolves to auto, the pane never overflows and follow-tail
  // silently does nothing. A host that does manage the height must be able to
  // drop the cap, otherwise the pane cannot use the space the host reserved.
  it('caps its height at 75vh by default', () => {
    vi.stubGlobal('EventSource', MockEventSource);
    const { container } = renderInRouter(<LogViewer jobId="j1" />);

    expect((container.firstElementChild as HTMLElement).className).toMatch(/max-h-\[75vh\]/);
  });

  // DSL pages stack sections in a plain space-y container, not a flex column, so
  // flex-1 would collapse. fill claims the viewport height minus the page chrome
  // instead, which is what lets the pane use the space a compact header frees up.
  it('claims the viewport height instead of the 75vh cap when fill is set', () => {
    vi.stubGlobal('EventSource', MockEventSource);
    const { container } = renderInRouter(<LogViewer jobId="j1" fill />);

    const cls = (container.firstElementChild as HTMLElement).className;
    expect(cls).not.toMatch(/max-h-\[75vh\]/);
    expect(cls).toMatch(/h-\[calc\(100vh-/);
    // min-h-0 is what lets the pane shrink and scroll rather than grow forever.
    expect(cls).toMatch(/min-h-0/);
  });

  it('shows "N lines" in header and log content after lines arrive', () => {
    vi.stubGlobal('EventSource', MockEventSource);
    renderInRouter(<LogViewer jobId="j1" />);
    const es = MockEventSource.instance!;

    act(() => {
      es.onopen!();
      es.onmessage!({ data: '[info] started' });
      es.onmessage!({ data: '[info] done' });
    });

    expect(screen.getByText('2 lines')).toBeInTheDocument();
    expect(screen.getByText(/\[info\] started/)).toBeInTheDocument();
    expect(screen.queryByText('Connecting...')).toBeNull();
  });

  it('shows "No log output yet" when connected but no lines received', () => {
    vi.stubGlobal('EventSource', MockEventSource);
    renderInRouter(<LogViewer jobId="j1" />);
    const es = MockEventSource.instance!;

    act(() => { es.onopen!(); });

    expect(screen.getByText('No log output yet')).toBeInTheDocument();
    expect(screen.queryByText('Connecting...')).toBeNull();
  });

  it('shows "Connecting..." again after connection error', () => {
    vi.stubGlobal('EventSource', MockEventSource);
    renderInRouter(<LogViewer jobId="j1" />);
    const es = MockEventSource.instance!;

    act(() => { es.onopen!(); });
    expect(screen.queryByText('Connecting...')).toBeNull();

    act(() => { es.onerror!(); });
    expect(screen.getByText('Connecting...')).toBeInTheDocument();
  });

  // Reported as "I have to click twice". Following the tail was held in three places -- the Auto
  // button's flag, a `paused` badge derived from the scroll position, and a ref that silently
  // vetoed the flag -- so scrolling up changed the badge and the veto while the button still
  // claimed following was on. The first click then only cleared that contradiction.
  describe('follow-tail toggle', () => {
    // jsdom gives every element zero height, so scroll position has to be imposed directly.
    function scrollPaneTo(atBottom: boolean): HTMLElement {
      const pane = document.querySelector('pre')!;
      Object.defineProperty(pane, 'scrollHeight', { value: 1000, configurable: true });
      Object.defineProperty(pane, 'clientHeight', { value: 200, configurable: true });
      // 800 is exactly the bottom; 100 is well above it.
      pane.scrollTop = atBottom ? 800 : 100;
      act(() => { pane.dispatchEvent(new Event('scroll')); });
      return pane;
    }

    function autoButton(): HTMLElement {
      return screen.getByRole('button', { name: /Auto/ });
    }

    it('follows by default, with no Paused badge', () => {
      vi.stubGlobal('EventSource', MockEventSource);
      renderInRouter(<LogViewer jobId="j1" />);

      expect(screen.queryByText('Paused')).toBeNull();
      expect(autoButton().getAttribute('aria-pressed')).toBe('true');
    });

    it('scrolling up pauses, and the button agrees rather than still claiming to follow', () => {
      vi.stubGlobal('EventSource', MockEventSource);
      renderInRouter(<LogViewer jobId="j1" />);

      scrollPaneTo(false);

      expect(screen.getByText('Paused')).toBeInTheDocument();
      // The whole defect: this used to still read "true" while the badge said Paused.
      expect(autoButton().getAttribute('aria-pressed')).toBe('false');
    });

    it('resumes on the FIRST click after scrolling up', () => {
      vi.stubGlobal('EventSource', MockEventSource);
      renderInRouter(<LogViewer jobId="j1" />);

      const pane = scrollPaneTo(false);
      expect(screen.getByText('Paused')).toBeInTheDocument();

      act(() => { autoButton().click(); });

      expect(screen.queryByText('Paused')).toBeNull();
      expect(autoButton().getAttribute('aria-pressed')).toBe('true');
      // And it actually jumped to the tail, rather than only flipping a flag.
      expect(pane.scrollTop).toBe(pane.scrollHeight);
    });

    it('scrolling back to the bottom resumes on its own', () => {
      vi.stubGlobal('EventSource', MockEventSource);
      renderInRouter(<LogViewer jobId="j1" />);

      scrollPaneTo(false);
      expect(screen.getByText('Paused')).toBeInTheDocument();

      scrollPaneTo(true);
      expect(screen.queryByText('Paused')).toBeNull();
      expect(autoButton().getAttribute('aria-pressed')).toBe('true');
    });

    it('one click pauses from the following state', () => {
      vi.stubGlobal('EventSource', MockEventSource);
      renderInRouter(<LogViewer jobId="j1" />);

      act(() => { autoButton().click(); });

      expect(screen.getByText('Paused')).toBeInTheDocument();
      expect(autoButton().getAttribute('aria-pressed')).toBe('false');
    });

    it('badge and button never disagree across a sequence of interactions', () => {
      vi.stubGlobal('EventSource', MockEventSource);
      renderInRouter(<LogViewer jobId="j1" />);

      const check = (label: string): void => {
        const paused = screen.queryByText('Paused') !== null;
        const pressed = autoButton().getAttribute('aria-pressed') === 'true';
        expect(paused, `${label}: badge says paused=${paused} while button says following=${pressed}`)
          .toBe(!pressed);
      };

      check('initial');
      act(() => { autoButton().click(); });   check('after click 1');
      scrollPaneTo(false);                    check('after scrolling up');
      act(() => { autoButton().click(); });   check('after click 2');
      scrollPaneTo(true);                     check('after scrolling to bottom');
      act(() => { autoButton().click(); });   check('after click 3');
    });
  });
});
