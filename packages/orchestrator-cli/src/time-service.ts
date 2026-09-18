/**
 * The passage of time, as a dependency.
 *
 * The scheduler is almost entirely about when things happen, and it measured that with the real
 * clock and the real timers. So testing it meant waiting: the resource-monitor tests slept for
 * hundreds of milliseconds each, the peaks test allowed itself 20 seconds, and both failed on a
 * loaded CI runner - twice in one afternoon - because the machine, not the code, decided the timing.
 * A test that can be wrong about the thing it asserts because the host was busy is not a test of the
 * code.
 *
 * `now` alone was already injectable. That covers "what time is it" and not "time has passed", which
 * is the half the scheduler actually turns on.
 *
 * A timer cancels itself rather than being handed back to a clearTimeout, so there is no handle type
 * to reconcile between the real implementation and the fake, and no way to cancel the wrong one.
 */
export interface Timer {
  cancel(): void;
}

export interface TimeService {
  /** Milliseconds since the epoch. */
  now(): number;
  /** Runs `fn` once, after `ms`. */
  after(ms: number, fn: () => void): Timer;
  /** Runs `fn` every `ms`, until cancelled. */
  every(ms: number, fn: () => void): Timer;
}

/** The real clock. */
export const systemTime: TimeService = {
  now: () => Date.now(),
  after(ms, fn) {
    const handle = setTimeout(fn, ms);
    return { cancel: () => clearTimeout(handle) };
  },
  every(ms, fn) {
    const handle = setInterval(fn, ms);
    return { cancel: () => clearInterval(handle) };
  },
};

interface Scheduled {
  id: number;
  dueAt: number;
  everyMs: number | null;
  fn: () => void;
  cancelled: boolean;
}

/**
 * A clock the test drives.
 *
 * `advance` moves time forward and runs whatever came due, in due order, so a test states the
 * elapsed time it means instead of sleeping for it. Repeating timers re-arm as many times as fit in
 * the span, which is what makes "the monitor sampled four times" expressible.
 */
export class FakeTime implements TimeService {
  private _now: number;
  private _nextId = 1;
  private _scheduled: Scheduled[] = [];

  constructor(startMs = Date.UTC(2026, 0, 1)) {
    this._now = startMs;
  }

  now(): number {
    return this._now;
  }

  after(ms: number, fn: () => void): Timer {
    return this._add(ms, null, fn);
  }

  every(ms: number, fn: () => void): Timer {
    return this._add(ms, ms, fn);
  }

  /** How many timers are armed. A leak shows up here rather than as a slow test. */
  get pending(): number {
    return this._scheduled.filter(s => !s.cancelled).length;
  }

  /**
   * Moves time forward by `ms`, running due callbacks in order.
   *
   * Callbacks may schedule more work; anything that falls inside the same span runs in this call, so
   * a chain of timeouts resolves in one advance rather than needing one per link. The guard is
   * against a timer that re-arms at zero and would otherwise spin forever.
   */
  advance(ms: number): void {
    const target = this._now + ms;
    let iterations = 0;
    for (;;) {
      const due = this._scheduled
        .filter(s => !s.cancelled && s.dueAt <= target)
        .sort((a, b) => a.dueAt - b.dueAt || a.id - b.id)[0];
      if (!due) {
        break;
      }
      if (++iterations > 100_000) {
        throw new Error('FakeTime.advance: a timer keeps re-arming inside the same span');
      }
      this._now = due.dueAt;
      if (due.everyMs === null) {
        due.cancelled = true;
        this._scheduled = this._scheduled.filter(s => s !== due);
      } else {
        due.dueAt = this._now + due.everyMs;
      }
      due.fn();
    }
    this._now = target;
  }

  /**
   * Advances in steps, yielding to the microtask queue between them.
   *
   * The scheduler's timer callbacks are async: they start a promise and the work lands in a later
   * microtask. Advancing in one jump would run every callback before any of their promises settled,
   * so state the next tick depends on would not be there yet. Awaiting between steps is what lets an
   * async chain keep up with the clock.
   */
  async advanceAsync(ms: number, stepMs = ms): Promise<void> {
    let remaining = ms;
    while (remaining > 0) {
      const step = Math.min(stepMs, remaining);
      this.advance(step);
      remaining -= step;
      await Promise.resolve();
      await new Promise(resolve => setImmediate(resolve));
    }
  }

  private _add(ms: number, everyMs: number | null, fn: () => void): Timer {
    const entry: Scheduled = {
      id: this._nextId++,
      // Negative and NaN delays are "as soon as possible" for the real timers, and a NaN due time
      // would compare false against everything and never run.
      dueAt: this._now + (Number.isFinite(ms) && ms > 0 ? ms : 0),
      everyMs,
      fn,
      cancelled: false,
    };
    this._scheduled.push(entry);
    return {
      cancel: () => {
        entry.cancelled = true;
        this._scheduled = this._scheduled.filter(s => s !== entry);
      },
    };
  }
}
