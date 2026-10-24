import type { ProgressConfidence, ProgressEstimate } from './types.js';

/** Pieces shared by the strategies. */

export function noEstimate(strategyId: string, now: Date, reason: string, detail?: Record<string, unknown>): ProgressEstimate {
  return {
    strategyId, progress: null, etaAt: null, confidence: 'none', confidenceScore: 0,
    reason, serverNow: now.toISOString(), ...(detail ? { detail } : {}),
  };
}

export function levelOfScore(score: number): ProgressConfidence {
  return score >= 0.8 ? 'high' : score >= 0.5 ? 'medium' : 'low';
}

export function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}

/** "12 s", "5 min": how long ago something happened, for a reason string. */
export function agoText(ms: number): string {
  const sec = Math.max(0, Math.round(ms / 1000));
  return sec < 60 ? `${sec} s` : `${Math.round(sec / 60)} min`;
}

/** Truncated to one line for a reason string. */
export function brief(text: string, max = 80): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 3)}...` : t;
}

/** A sample of the run: at time `t` (ms since the epoch) it was `f` (0..1) of the way. */
export interface Sample {
  t: number;
  f: number;
}

/** A rate whose segments differ by more than this (std / mean) is not trusted to extrapolate. */
const MAX_RATE_CV = 0.75;
/** Log timestamps have a one-second resolution: a span shorter than this says nothing about a rate. */
const MIN_SPAN_MS = 1000;

export interface RateResult {
  /** Fraction per millisecond; null when there is not enough to compute one. */
  rate: number | null;
  /** Segments of the window that make the rate (0 when none). */
  segments: number;
  stable: boolean;
}

/** Rate over the window: first to last sample, with the spread of the consecutive segments as its stability. */
export function rateOf(samples: readonly Sample[]): RateResult {
  const first = samples[0];
  const last = samples[samples.length - 1];
  if (!first || !last || last.t - first.t < MIN_SPAN_MS || last.f <= first.f) {
    return { rate: null, segments: 0, stable: true };
  }
  const rates: number[] = [];
  for (let i = 1; i < samples.length; i++) {
    const dt = samples[i]!.t - samples[i - 1]!.t;
    const df = samples[i]!.f - samples[i - 1]!.f;
    if (dt > 0 && df > 0) {
      rates.push(df / dt);
    }
  }
  const rate = (last.f - first.f) / (last.t - first.t);
  if (rates.length < 2) {
    return { rate, segments: rates.length, stable: true };
  }
  const mean = rates.reduce((a, b) => a + b, 0) / rates.length;
  const std = Math.sqrt(rates.reduce((a, b) => a + (b - mean) ** 2, 0) / rates.length);
  return { rate, segments: rates.length, stable: std / mean <= MAX_RATE_CV };
}

/** Median gap between consecutive samples, or `fallback`. */
export function medianGapMs(samples: readonly Sample[], fallback: number): number {
  const gaps: number[] = [];
  for (let i = 1; i < samples.length; i++) {
    gaps.push(samples[i]!.t - samples[i - 1]!.t);
  }
  if (gaps.length === 0) {
    return fallback;
  }
  gaps.sort((a, b) => a - b);
  return Math.max(1000, gaps[Math.floor(gaps.length / 2)]!);
}

/** 1 while the last report is recent compared to the usual gap, decaying to 0.2 as it ages. */
export function freshness(ageMs: number, gapMs: number): number {
  const grace = 3 * gapMs + 5000;
  return ageMs <= grace ? 1 : Math.max(0.2, 1 - (ageMs - grace) / (10 * gapMs));
}

export type EndMethod = 'rate' | 'history' | 'since-start' | 'none';

export interface EndProjection {
  method: EndMethod;
  /** Absolute ms, or null. May be in the past: the caller turns that into "overdue". */
  endMs: number | null;
  /** Confidence before the freshness of the reports is applied. */
  base: number;
}

/**
 * Where a run that reports its own progress will end. A steady rate wins; an unsteady one falls back to the
 * usual duration of the job when there is one; with too few reports the pace since the start is used.
 */
export function projectEnd(input: { startMs: number; samples: readonly Sample[]; usualMs: number | null }): EndProjection {
  const last = input.samples[input.samples.length - 1]!;
  if (last.f >= 1) {
    return { method: 'rate', endMs: last.t, base: 0.9 };
  }
  const r = rateOf(input.samples);
  if (r.rate !== null && r.stable) {
    return { method: 'rate', endMs: last.t + (1 - last.f) / r.rate, base: r.segments >= 2 ? 0.9 : 0.7 };
  }
  const sinceStart = (): EndProjection => (last.f > 0 && last.t > input.startMs
    ? { method: 'since-start', endMs: input.startMs + (last.t - input.startMs) / last.f, base: 0.5 }
    : { method: 'none', endMs: null, base: 0.3 });
  if (r.rate !== null && !r.stable) {
    return input.usualMs !== null ? { method: 'history', endMs: input.startMs + input.usualMs, base: 0.4 } : sinceStart();
  }
  return sinceStart();
}
