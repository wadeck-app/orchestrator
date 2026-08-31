import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { IdleTimer } from './idle-timer.js';

describe('IdleTimer', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('fires onIdle after timeout when no SSE connections', () => {
    const onIdle = vi.fn();
    const timer = new IdleTimer(1000, onIdle);
    timer.reset();
    vi.advanceTimersByTime(999);
    expect(onIdle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onIdle).toHaveBeenCalledOnce();
    timer.stop();
  });

  it('does not fire while SSE connection is active', () => {
    const onIdle = vi.fn();
    const timer = new IdleTimer(1000, onIdle);
    timer.addSseConnection();
    timer.reset(); // should be no-op while SSE active
    vi.advanceTimersByTime(5000);
    expect(onIdle).not.toHaveBeenCalled();
    timer.stop();
  });

  it('fires after SSE connection is removed', () => {
    const onIdle = vi.fn();
    const timer = new IdleTimer(1000, onIdle);
    timer.addSseConnection();
    vi.advanceTimersByTime(2000);
    expect(onIdle).not.toHaveBeenCalled();
    timer.removeSseConnection();
    vi.advanceTimersByTime(1000);
    expect(onIdle).toHaveBeenCalledOnce();
    timer.stop();
  });

  it('resets the timer on reset() call', () => {
    const onIdle = vi.fn();
    const timer = new IdleTimer(1000, onIdle);
    timer.reset();
    vi.advanceTimersByTime(800);
    timer.reset(); // restart
    vi.advanceTimersByTime(800);
    expect(onIdle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(200);
    expect(onIdle).toHaveBeenCalledOnce();
    timer.stop();
  });

  it('does not fire after stop()', () => {
    const onIdle = vi.fn();
    const timer = new IdleTimer(1000, onIdle);
    timer.reset();
    timer.stop();
    vi.advanceTimersByTime(5000);
    expect(onIdle).not.toHaveBeenCalled();
  });
});
