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
 * It exists for ONE reason: a delay above 2^31-1 ms (~24.85 days) is clamped by the runtime to 1ms,
 * so a job asked to wait two months fired on the NEXT TICK - silently, because nothing reports the
 * clamp. A day is far below that, and matches what node-cron already does for its own heartbeat
 * (`getDelay`, maxDelay = 86400000), so the project has one waking rule rather than two.
 *
 * It is NOT a sleep detector, and it was briefly set to one minute on the assumption that it had to
 * be. That assumption was wrong on the platforms this ships to, and the sources are worth recording
 * because the mistake is easy to repeat:
 *
 *   Windows  QueryPerformanceCounter (libuv src/win/util.c). Microsoft documents it as returning
 *            "the total number of ticks that have occurred since the Windows operating system was
 *            started, INCLUDING the time when the machine was in a sleep state such as standby,
 *            hibernate, or connected standby". Suspend is counted.
 *   macOS    mach_continuous_time() (libuv src/unix/darwin.c), chosen deliberately in libuv
 *            4685be2 because mach_absolute_time() "can jump backward in time when the machine is
 *            suspended". Suspend is counted.
 *   Linux    CLOCK_MONOTONIC (libuv src/unix/linux.c), which does NOT count suspend. CLOCK_BOOTTIME
 *            would, and libuv uses it only in uv_uptime.
 *
 * So on Windows and macOS a long timer already fires at the right wall-clock moment across a sleep,
 * and Linux - the one platform where it would not - has no native package here (win32-x64,
 * darwin-arm64, darwin-x64). Re-deriving the remaining time once a day is left in because it costs
 * nothing and bounds the error if someone moves the system clock by hand, which no clock source
 * follows.
 */
export const MAX_TIMER_CHUNK_MS = 86_400_000;

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
    if (cancelled) {
      return;
    }
    const remaining = deadlineMs - time.now();
    if (remaining <= 0) {
      current = time.after(0, () => { if (!cancelled) {
        fn();
      } });
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
  if (!Number.isFinite(ms) || ms <= 0) {
    return 0;
  }
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
