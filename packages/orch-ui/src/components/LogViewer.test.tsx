import React from 'react';
import { render, screen, act } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { LogViewer } from './LogViewer.js';

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
    render(<LogViewer jobId="whatsapp-10h" />);

    // Only the header should say "Connecting..." - not the body
    expect(screen.getAllByText('Connecting...')).toHaveLength(1);
    // Body should be empty (no duplicate)
    const pre = document.querySelector('pre');
    expect(pre?.textContent?.trim()).toBe('');
  });

  it('shows "N lines" in header and log content after lines arrive', () => {
    vi.stubGlobal('EventSource', MockEventSource);
    render(<LogViewer jobId="j1" />);
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
    render(<LogViewer jobId="j1" />);
    const es = MockEventSource.instance!;

    act(() => { es.onopen!(); });

    expect(screen.getByText('No log output yet')).toBeInTheDocument();
    expect(screen.queryByText('Connecting...')).toBeNull();
  });

  it('shows "Connecting..." again after connection error', () => {
    vi.stubGlobal('EventSource', MockEventSource);
    render(<LogViewer jobId="j1" />);
    const es = MockEventSource.instance!;

    act(() => { es.onopen!(); });
    expect(screen.queryByText('Connecting...')).toBeNull();

    act(() => { es.onerror!(); });
    expect(screen.getByText('Connecting...')).toBeInTheDocument();
  });
});
