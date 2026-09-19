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

/**
 * The longest single timer this codebase arms.
 *
 * Two constraints, and the tighter one wins.
 *
 * The ceiling: a delay above 2^31-1 ms (~24.85 days) is clamped by the runtime to 1ms, so a job
 * asked to wait two months fired on the NEXT TICK - silently, because nothing reports the clamp.
 *
 * The one that actually sets this value: a timer counts monotonic time, which does NOT include time
 * the machine spent suspended. So a slice armed before the lid closes still owes its full remaining
 * time in AWAKE seconds when the machine wakes, and the deadline may have passed days ago. The
 * lateness is therefore bounded by the slice, not by the sleep - and on a laptop, sleeping across a
 * deadline is the normal case, not the edge case. node-cron takes the same approach with a one-day
 * cap, which is fine for a heartbeat it is allowed to miss and not for a job that must fire.
 *
 * One minute is the scheduler's own resolution: cron cannot express anything finer, so a job late by
 * under a minute is indistinguishable from on time, and a job late by up to a day is not. The cost
 * is one closure per minute while a wait is outstanding, against a daemon that already samples
 * running jobs every two seconds.
 */
export const MAX_TIMER_CHUNK_MS = 60_000;

/**
 * The delay a runtime timer cannot exceed: 2^31-1 ms, about 24.85 days.
 *
 * Anything larger is clamped to 1ms and fires at once. FakeTime reproduces that, so a test can fail
 * on it - without it the fake is more capable than the thing it stands in for, and every long wait
 * looks correct in tests and misfires in production.
 */
export const TIMER_CEILING_MS = 2_147_483_647;

/**
 * Runs `fn` at an absolute moment, however far away.
 *
 * Waits in bounded slices and re-derives the remaining time from the clock on every slice, which
 * buys three things a single long timer cannot have:
 *
 *  - Delays beyond a timer's 2^31-1 ms ceiling work, instead of firing immediately.
 *  - A clock that jumps - NTP correction, the machine waking from sleep - is absorbed at the next
 *    slice rather than making the job late by however long the jump was. Timers count elapsed
 *    monotonic time, which does not include time the machine spent suspended.
 *  - The deadline is an absolute moment, which is what the registry persists, so a restart and a
 *    re-arm take the same path.
 *
 * A deadline already in the past fires as soon as possible rather than being skipped: whether that
 * counts as overdue is the caller's question, not the timer's.
 */
export function waitUntil(time: TimeService, deadlineMs: number, fn: () => void): Timer {
  let current: Timer | null = null;
  let cancelled = false;

  const arm = (): void => {
    if (cancelled) return;
    const remaining = deadlineMs - time.now();
    if (remaining <= 0) {
      current = time.after(0, () => { if (!cancelled) fn(); });
      return;
    }
    current = time.after(Math.min(remaining, MAX_TIMER_CHUNK_MS), arm);
  };

  arm();

  return {
    cancel: () => {
      cancelled = true;
      current?.cancel();
      current = null;
    },
  };
}

/** What a runtime timer would actually do with this delay. */
function clampDelay(ms: number): number {
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  return ms > TIMER_CEILING_MS ? 1 : ms;
}

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
   * The machine sleeps: the wall clock moves, the timers do not.
   *
   * `advance` moves both together, which is time passing while awake and cannot express a suspend at
   * all - so a test written with it says nothing about the case it looks like it covers. A real timer
   * counts monotonic time, which excludes the suspend, so every armed timer still owes its full
   * remaining time in awake seconds afterwards: that is why each due time moves forward with the
   * clock here rather than staying put.
   *
   * This is the case that decides how long a slice may be - see MAX_TIMER_CHUNK_MS.
   */
  suspend(ms: number): void {
    if (!Number.isFinite(ms) || ms <= 0) return;
    this._now += ms;
    for (const s of this._scheduled) s.dueAt += ms;
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
      // would compare false against everything and never run. A delay above the runtime's ceiling
      // is clamped to 1ms exactly as the real timer clamps it: a fake that quietly honours a 60-day
      // setTimeout makes every long wait pass in tests and misfire in production.
      dueAt: this._now + clampDelay(ms),
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
