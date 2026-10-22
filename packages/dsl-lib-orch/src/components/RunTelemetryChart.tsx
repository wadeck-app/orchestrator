import React from 'react';

/*
 * The picture and the words around it, apart from the component that fetches the data: nothing here
 * touches the network, so it is drawn from a payload alone.
 */
/** A side is null when nothing defines it: an absolute ceiling for the other resource only, and no baseline yet. */
interface Threshold {
  cpuPct: number | null;
  ramMb: number | null;
}

/** The payload of GET /api/jobs/:jobId/telemetry; see orchestrator-cli/src/run-telemetry.ts. */
export interface RunTelemetryData {
  run: string | null;
  available: boolean;
  reason?: string;
  samples: Array<{ t: string; cpuPct: number; ramMb: number }>;
  soft: Threshold | null;
  hard: Threshold | null;
  kill?: { t: string; cpuPct: number; ramMb: number; consecutiveSamples: number };
  end?: { t: string; exitCode: number | null; durationMs: number | null; reason: string | null };
  truncated: boolean;
  bucketSeconds: number | null;
  rawSamples: number;
}

/** "45s", "12m 30s", "1h 05m": a duration read off an axis or a sentence. */
export function formatSpan(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) {
    return `${s}s`;
  }
  const m = Math.floor(s / 60);
  if (m < 60) {
    const rem = s % 60;
    return rem === 0 ? `${m}m` : `${m}m ${String(rem).padStart(2, '0')}s`;
  }
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

/** The end reasons the daemon records, in words. An unknown one is shown as it is rather than hidden. */
function describeReason(reason: string | null): string {
  switch (reason) {
    case null: return 'finished';
    case 'timeout': return 'stopped: timeout';
    case 'manual-kill': return 'stopped by the user';
    case 'resource-limit': return 'stopped: over its resource budget';
    default: return `ended: ${reason}`;
  }
}

/** A round top for an axis, so the ticks read as 0 / 50 / 100 and not 0 / 47.3 / 94.6. */
export function niceMax(value: number): number {
  if (!(value > 0)) {
    return 1;
  }
  const magnitude = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 2, 2.5, 5, 10]) {
    if (value <= step * magnitude) {
      return step * magnitude;
    }
  }
  return 10 * magnitude;
}

const fmt = (n: number): string => (Number.isInteger(n) ? String(n) : n.toFixed(1));

/** What a screen reader hears instead of the picture. */
export function summarize(data: RunTelemetryData): string {
  const peakCpu = Math.max(...data.samples.map(s => s.cpuPct));
  const peakRam = Math.max(...data.samples.map(s => s.ramMb));
  const startMs = Date.parse(data.run ?? data.samples[0]!.t);
  const lastMs = Date.parse(data.samples[data.samples.length - 1]!.t);
  const duration = data.end?.durationMs != null ? formatSpan(data.end.durationMs) : `${formatSpan(lastMs - startMs)} so far`;
  return `CPU and RAM of the run over ${duration}: peak CPU ${fmt(peakCpu)}%, peak RAM ${fmt(peakRam)} MB`
    + (data.kill ? ', the resource monitor killed the run' : '')
    + (data.end ? `, ${describeReason(data.end.reason)}` : ', still running') + '.';
}

const W = 640;
const LEFT = 52;
const RIGHT = 70;
const PANEL_H = 84;
const PANEL_GAP = 34;
const TOP = 22;
const AXIS_H = 44;
const H = TOP + PANEL_H * 2 + PANEL_GAP + AXIS_H;
const PLOT_W = W - LEFT - RIGHT;

interface PanelSpec {
  title: string;
  unit: string;
  pick: (s: { cpuPct: number; ramMb: number }) => number;
  /** Tailwind text colour; the line draws in currentColor, so the palette stays the theme's. */
  tone: string;
  soft: number | null;
  hard: number | null;
}

export function RunTelemetryChart({ data }: { data: RunTelemetryData }): React.ReactElement {
  const startMs = Date.parse(data.run ?? data.samples[0]!.t);
  const lastSampleMs = Date.parse(data.samples[data.samples.length - 1]!.t);
  const endMs = data.end ? Date.parse(data.end.t) : lastSampleMs;
  const spanMs = Math.max(endMs, lastSampleMs, startMs + 1000) - startMs;
  const x = (iso: string): number => LEFT + (Math.min(Math.max(Date.parse(iso) - startMs, 0), spanMs) / spanMs) * PLOT_W;

  const panels: PanelSpec[] = [
    { title: 'CPU (%)', unit: '%', pick: s => s.cpuPct, tone: 'text-primary', soft: data.soft?.cpuPct ?? null, hard: data.hard?.cpuPct ?? null },
    { title: 'RAM (MB)', unit: ' MB', pick: s => s.ramMb, tone: 'text-content', soft: data.soft?.ramMb ?? null, hard: data.hard?.ramMb ?? null },
  ];
  const ticks = [0, 0.25, 0.5, 0.75, 1];

  return (
    // violations-suppress: react/no-inline-svg a chart drawn from data, not an icon or asset; there is nothing static to extract
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto text-muted" role="img" aria-label={summarize(data)}>
      {panels.map((panel, index) => {
        const top = TOP + index * (PANEL_H + PANEL_GAP);
        const values = data.samples.map(panel.pick);
        const yMax = niceMax(Math.max(...values, panel.soft ?? 0, panel.hard ?? 0) * 1.05);
        const y = (v: number): number => top + PANEL_H - (v / yMax) * PANEL_H;
        const path = data.samples.map((s, i) => `${i === 0 ? 'M' : 'L'}${x(s.t).toFixed(1)},${y(panel.pick(s)).toFixed(1)}`).join(' ');
        const killMoment = data.kill ? x(data.kill.t) : null;
        return (
          <g key={panel.title}>
            <text x={LEFT} y={top - 8} fontSize="11" fill="currentColor" className="font-medium">{panel.title}</text>
            <rect x={LEFT} y={top} width={PLOT_W} height={PANEL_H} fill="none" stroke="currentColor" strokeOpacity="0.25" />
            {[0, 1].map(frac => (
              <text key={frac} x={LEFT - 6} y={y(frac * yMax) + 4} fontSize="10" textAnchor="end" fill="currentColor">{fmt(frac * yMax)}</text>
            ))}
            {ticks.map(frac => (
              <line key={frac} x1={LEFT + frac * PLOT_W} x2={LEFT + frac * PLOT_W} y1={top} y2={top + PANEL_H} stroke="currentColor" strokeOpacity="0.1" />
            ))}
            {panel.soft !== null && (
              <g className="text-warning">
                <line data-testid={`soft-${index}`} x1={LEFT} x2={LEFT + PLOT_W} y1={y(panel.soft)} y2={y(panel.soft)} stroke="currentColor" strokeWidth="1.5" strokeDasharray="4 3" />
                <text x={LEFT + PLOT_W + 4} y={y(panel.soft) + 3} fontSize="10" fill="currentColor">soft {fmt(panel.soft)}{panel.unit}</text>
              </g>
            )}
            {panel.hard !== null && (
              <g className="text-danger">
                <line data-testid={`hard-${index}`} x1={LEFT} x2={LEFT + PLOT_W} y1={y(panel.hard)} y2={y(panel.hard)} stroke="currentColor" strokeWidth="1.5" strokeDasharray="9 4" />
                <text x={LEFT + PLOT_W + 4} y={y(panel.hard) + 3} fontSize="10" fill="currentColor">hard {fmt(panel.hard)}{panel.unit}</text>
              </g>
            )}
            <g className={panel.tone}>
              <path d={path} fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
              {data.samples.length === 1 && <circle cx={x(data.samples[0]!.t)} cy={y(panel.pick(data.samples[0]!))} r="3" fill="currentColor" />}
            </g>
            {killMoment !== null && (
              <g className="text-danger">
                <line data-testid={`kill-${index}`} x1={killMoment} x2={killMoment} y1={top} y2={top + PANEL_H} stroke="currentColor" strokeWidth="2" />
                {index === 0 && <text x={killMoment} y={top - 8} fontSize="10" textAnchor="end" fill="currentColor">killed by the monitor</text>}
              </g>
            )}
          </g>
        );
      })}
      {data.end && (
        <g className={data.end.reason === 'resource-limit' || (data.end.exitCode != null && data.end.exitCode !== 0) ? 'text-danger' : 'text-content'}>
          <line data-testid="end-marker" x1={x(data.end.t)} x2={x(data.end.t)} y1={TOP} y2={TOP + PANEL_H * 2 + PANEL_GAP} stroke="currentColor" strokeWidth="1.5" strokeDasharray="2 3" />
          <text x={Math.min(x(data.end.t), W - 4)} y={H - AXIS_H + 4 + 24} fontSize="10" textAnchor="end" fill="currentColor">
            {`end: ${describeReason(data.end.reason)}${data.end.exitCode != null ? ` (exit ${data.end.exitCode})` : ''}`}
          </text>
        </g>
      )}
      {ticks.map(frac => (
        <text key={frac} x={LEFT + frac * PLOT_W} y={TOP + PANEL_H * 2 + PANEL_GAP + 14} fontSize="10" textAnchor="middle" fill="currentColor">
          {formatSpan(frac * spanMs)}
        </text>
      ))}
      <text x={LEFT + PLOT_W / 2} y={TOP + PANEL_H * 2 + PANEL_GAP + 28} fontSize="10" textAnchor="middle" fill="currentColor">
        Elapsed time since the run started
      </text>
    </svg>
  );
}
