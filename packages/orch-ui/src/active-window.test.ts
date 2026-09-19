import { describe, it, expect } from 'vitest';
import { windowStateAt, msUntilStart, msUntilEnd } from './active-window.js';

/*
 * These three functions mirror orchestrator-cli/src/active-window.ts, which orch-ui cannot import
 * (no dependency, by design -- see the note at the top of types.ts). The semantics must match exactly,
 * because the daemon decides when a job actually fires and the card only describes that decision:
 * if the card said "active" where the daemon says "expired", the dashboard would be lying about a job
 * the daemon has already disabled.
 *
 * The bound behaviour is the part worth pinning: inclusive at the start, exclusive at the end.
 */

const FROM = '2026-09-19T09:00:00.000Z';
const UNTIL = '2026-09-19T10:00:00.000Z';
const ms = (iso: string): number => Date.parse(iso);

describe('windowStateAt', () => {
  it('a job with no window is always active', () => {
    expect(windowStateAt({}, ms('2000-01-01T00:00:00.000Z'))).toBe('active');
  });

  it('pending before the window opens', () => {
    expect(windowStateAt({ activeFrom: FROM }, ms('2026-09-19T08:59:59.999Z'))).toBe('pending');
  });

  // Inclusive at the start: a job active "from 09:00" fires at 09:00.
  it('active exactly at the start', () => {
    expect(windowStateAt({ activeFrom: FROM }, ms(FROM))).toBe('active');
  });

  // Exclusive at the end: two windows that meet cannot both claim the same instant.
  it('expired exactly at the end', () => {
    expect(windowStateAt({ activeUntil: UNTIL }, ms(UNTIL))).toBe('expired');
  });

  it('active just before the end', () => {
    expect(windowStateAt({ activeUntil: UNTIL }, ms('2026-09-19T09:59:59.999Z'))).toBe('active');
  });

  // An unparseable timestamp must not read as epoch zero, which would silently make the window
  // unbounded in whichever direction it was meant to close.
  it('an unparseable bound is treated as absent, not as epoch zero', () => {
    expect(windowStateAt({ activeFrom: 'not a date' }, ms('2026-09-19T09:00:00.000Z'))).toBe('active');
    expect(windowStateAt({ activeUntil: 'not a date' }, ms('2026-09-19T09:00:00.000Z'))).toBe('active');
  });

  it('pending wins over expired when both bounds are in play and now precedes the start', () => {
    expect(windowStateAt({ activeFrom: FROM, activeUntil: UNTIL }, ms('2026-09-19T08:00:00.000Z'))).toBe('pending');
  });
});

describe('msUntilStart', () => {
  it('counts down to an unopened window', () => {
    expect(msUntilStart({ activeFrom: FROM }, ms('2026-09-19T08:00:00.000Z'))).toBe(3_600_000);
  });

  it('null once the window is open, so a caller cannot render a countdown to the past', () => {
    expect(msUntilStart({ activeFrom: FROM }, ms('2026-09-19T09:30:00.000Z'))).toBeNull();
  });

  it('null when there is no start bound', () => {
    expect(msUntilStart({}, ms(FROM))).toBeNull();
  });
});

describe('msUntilEnd', () => {
  it('counts down to the close', () => {
    expect(msUntilEnd({ activeUntil: UNTIL }, ms('2026-09-19T09:00:00.000Z'))).toBe(3_600_000);
  });

  it('null once the window has closed', () => {
    expect(msUntilEnd({ activeUntil: UNTIL }, ms('2026-09-19T10:00:00.000Z'))).toBeNull();
  });

  it('null when there is no end bound', () => {
    expect(msUntilEnd({}, ms(FROM))).toBeNull();
  });
});
