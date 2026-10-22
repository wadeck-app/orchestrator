import React, { useState } from 'react';
import type { ResourceHistoryRun } from '../types.js';
import { formatSpan, niceMax } from './RunTelemetryChart.js';

/*
 * The picture and the words around it, apart from the component that fetches the data: nothing here touches
 * the network, so it is drawn from the daemon's answer alone. Same helpers and palette as RunTelemetryChart.
 */

const TOOLTIP_CLS = 'pointer-events-none absolute top-0 z-10 w-72 rounded border border-border bg-surface p-2 text-xs text-content shadow';

/** Who ended the run: the monitor (red), a timeout or a person (grey), or nobody (the base tone). */
export type RunKind = 'resource-limit' | 'stopped' | 'normal';

export function runKind(run: ResourceHistoryRun): RunKind {
  if (run.endReason === 'resource-limit') {
    return 'resource-limit';
  }
  return run.endReason === 'timeout' || run.endReason === 'manual-kill' ? 'stopped' : 'normal';
}

/** Tailwind text colour of a bar; the bar draws in currentColor, so the palette stays the theme's. */
const KIND_TONE: Record<RunKind, string> = {
  'resource-limit': 'text-danger',
  stopped: 'text-muted',
  normal: 'text-primary',
};

/**
 * Index ranges of consecutive present values: [[0, 1], [3]] for [1, 2, null, 3]. A limit line is drawn per
 * range, so a run that had no limit leaves a gap instead of a line joining the runs around it.
 */
export function stepSegments(values: Array<number | null>): number[][] {
  const segments: number[][] = [];
  let current: number[] = [];
  values.forEach((value, index) => {
    if (value === null) {
      if (current.length > 0) {
        segments.push(current);
        current = [];
      }
    } else {
      current.push(index);
    }
  });
  if (current.length > 0) {
    segments.push(current);
  }
  return segments;
}

const fmt = (n: number): string => (Number.isInteger(n) ? String(n) : n.toFixed(1));

function describeEnd(run: ResourceHistoryRun): string {
  switch (run.endReason) {
    case undefined: return 'finished on its own';
    case 'timeout': return 'stopped: timeout';
    case 'manual-kill': return 'stopped by the user';
    case 'resource-limit': return 'stopped: over its resource budget';
    default: return `ended: ${String(run.endReason)}`;
  }
}

/** The lines of a run's tooltip. */
export function describeRun(run: ResourceHistoryRun): string[] {
  const measured = (value: number | null, unit: string): string => (value === null ? 'not measured' : `${fmt(value)}${unit}`);
  return [
    // violations-suppress: ts/no-locale-date display-only time in a tooltip, locale acceptable
    new Date(run.startedAt).toLocaleString(),
    `Duration ${formatSpan(run.durationMs)}, ${run.exitCode === null ? 'no exit code' : `exit ${run.exitCode}`}, ${describeEnd(run)}`,
    `Peak CPU ${measured(run.peakCpuPct, '%')}, Peak RAM ${measured(run.peakRamMb, ' MB')}`,
    `Average CPU ${measured(run.avgCpuPct, '%')}, Average RAM ${measured(run.avgRamMb, ' MB')}`,
    `Limits ${run.enforce === 'kill' ? 'enforced' : run.enforce === 'warn' ? 'reported only (warn)' : 'off'}`,
  ];
}

/** What a screen reader hears instead of the picture. `runs` is oldest first. */
export function summarizeHistory(runs: ResourceHistoryRun[]): string {
  const peaks = (pick: (r: ResourceHistoryRun) => number | null): number | null => {
    const values = runs.map(pick).filter((v): v is number => v !== null);
    return values.length === 0 ? null : Math.max(...values);
  };
  const cpu = peaks(r => r.peakCpuPct);
  const ram = peaks(r => r.peakRamMb);
  const killed = runs.filter(r => runKind(r) === 'resource-limit').length;
  return `Peak and average CPU and RAM of ${runs.length} runs, oldest to newest: `
    + `peak CPU ${cpu === null ? 'not measured' : `${fmt(cpu)}%`}, peak RAM ${ram === null ? 'not measured' : `${fmt(ram)} MB`}`
    + (killed > 0 ? `, ${killed} ended by the resource limit` : '') + '.';
}

const W = 640;
const LEFT = 52;
const RIGHT = 16;
const PANEL_H = 84;
const PANEL_GAP = 34;
const TOP = 22;
const AXIS_H = 44;
const H = TOP + PANEL_H * 2 + PANEL_GAP + AXIS_H;
const PLOT_W = W - LEFT - RIGHT;

interface PanelSpec {
  title: string;
  peak: (r: ResourceHistoryRun) => number | null;
  avg: (r: ResourceHistoryRun) => number | null;
  soft: (r: ResourceHistoryRun) => number | null;
  hard: (r: ResourceHistoryRun) => number | null;
}

const PANELS: PanelSpec[] = [
  { title: 'CPU (%)', peak: r => r.peakCpuPct, avg: r => r.avgCpuPct, soft: r => r.soft?.cpuPct ?? null, hard: r => r.hard?.cpuPct ?? null },
  { title: 'RAM (MB)', peak: r => r.peakRamMb, avg: r => r.avgRamMb, soft: r => r.soft?.ramMb ?? null, hard: r => r.hard?.ramMb ?? null },
];

/** `runs` is oldest first: the axis is the run index. */
export function ResourceHistoryChart({ runs }: { runs: ResourceHistoryRun[] }): React.ReactElement {
  const [hovered, setHovered] = useState<number | null>(null);
  const band = PLOT_W / runs.length;
  const barW = Math.max(1, Math.min(band * 0.7, 24));
  const centre = (i: number): number => LEFT + band * (i + 0.5);
  // About five labelled runs whatever the count, always including the first and the last.
  const labelStep = Math.max(1, Math.ceil(runs.length / 5));
  const labelled = runs.map((_, i) => i).filter(i => i % labelStep === 0 || i === runs.length - 1);
  const hoveredRun = hovered === null ? null : runs[hovered];

  return (
    <div className="relative">
      {/* violations-suppress: react/no-inline-svg a chart drawn from data, not an icon or asset; there is nothing static to extract */}
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto text-muted" role="img" aria-label={summarizeHistory(runs)}>
        {PANELS.map((panel, index) => {
          const top = TOP + index * (PANEL_H + PANEL_GAP);
          const soft = runs.map(panel.soft);
          const hard = runs.map(panel.hard);
          const all = [...runs.map(panel.peak), ...runs.map(panel.avg), ...soft, ...hard].filter((v): v is number => v !== null);
          const yMax = niceMax(Math.max(0, ...all) * 1.05);
          const y = (v: number): number => top + PANEL_H - (v / yMax) * PANEL_H;
          /* A limit holds for the whole band of its run, so the line is flat across the band and steps between runs. */
          const stepPath = (values: Array<number | null>): string => stepSegments(values).map(segment => segment.map((i, n) => {
            const left = LEFT + band * i;
            const right = left + band;
            return `${n === 0 ? 'M' : 'L'}${left.toFixed(1)},${y(values[i]!).toFixed(1)} L${right.toFixed(1)},${y(values[i]!).toFixed(1)}`;
          }).join(' ')).join(' ');
          const avgSegments = stepSegments(runs.map(panel.avg));
          const avgPath = avgSegments.map(segment => segment.map((i, n) => `${n === 0 ? 'M' : 'L'}${centre(i).toFixed(1)},${y(panel.avg(runs[i]!)!).toFixed(1)}`).join(' ')).join(' ');
          return (
            <g key={panel.title}>
              <text x={LEFT} y={top - 8} fontSize="11" fill="currentColor" className="font-medium">{panel.title}</text>
              <rect x={LEFT} y={top} width={PLOT_W} height={PANEL_H} fill="none" stroke="currentColor" strokeOpacity="0.25" />
              {[0, 1].map(frac => (
                <text key={frac} x={LEFT - 6} y={y(frac * yMax) + 4} fontSize="10" textAnchor="end" fill="currentColor">{fmt(frac * yMax)}</text>
              ))}
              {runs.map((run, i) => {
                const value = panel.peak(run);
                if (value === null) {
                  return null;
                }
                const kind = runKind(run);
                return (
                  <rect
                    key={run.startedAt}
                    data-testid={`bar-${index}-${i}`}
                    data-kind={kind}
                    className={KIND_TONE[kind]}
                    x={centre(i) - barW / 2}
                    y={y(value)}
                    width={barW}
                    height={top + PANEL_H - y(value)}
                    fill="currentColor"
                    fillOpacity={hovered === i ? 0.9 : 0.55}
                  />
                );
              })}
              {stepSegments(soft).length > 0 && (
                <g className="text-warning">
                  <path data-testid={`soft-${index}`} d={stepPath(soft)} fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray="4 3" />
                </g>
              )}
              {stepSegments(hard).length > 0 && (
                <g className="text-danger">
                  <path data-testid={`hard-${index}`} d={stepPath(hard)} fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray="9 4" />
                </g>
              )}
              {avgSegments.length > 0 && (
                <g className="text-content">
                  <path data-testid={`avg-${index}`} d={avgPath} fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
                  {runs.length <= 40 && runs.map((run, i) => (panel.avg(run) === null ? null : (
                    <circle key={run.startedAt} cx={centre(i)} cy={y(panel.avg(run)!)} r="2" fill="currentColor" />
                  )))}
                </g>
              )}
            </g>
          );
        })}
        {labelled.map(i => (
          <text key={i} x={centre(i)} y={TOP + PANEL_H * 2 + PANEL_GAP + 14} fontSize="10" textAnchor="middle" fill="currentColor">{i + 1}</text>
        ))}
        <text x={LEFT + PLOT_W / 2} y={TOP + PANEL_H * 2 + PANEL_GAP + 28} fontSize="10" textAnchor="middle" fill="currentColor">
          Runs, oldest to newest
        </text>
        {/* Over everything, so a hover or a focus lands on a run whatever is drawn under it; one per run, measured or not. */}
        {runs.map((run, i) => (
          <rect
            key={run.startedAt}
            data-testid={`hover-${i}`}
            x={LEFT + band * i}
            y={TOP}
            width={band}
            height={PANEL_H * 2 + PANEL_GAP}
            fill="transparent"
            tabIndex={0}
            aria-label={describeRun(run).join('. ')}
            onMouseEnter={() => setHovered(i)}
            onMouseLeave={() => setHovered(null)}
            onFocus={() => setHovered(i)}
            onBlur={() => setHovered(null)}
          />
        ))}
      </svg>
      {hoveredRun && hovered !== null && (
        <div
          role="tooltip"
          className={TOOLTIP_CLS}
          // Beside the run, flipped to the left half of the chart so it never leaves the container.
          style={{ left: `${(centre(hovered) / W) * 100}%`, transform: hovered > runs.length / 2 ? 'translateX(calc(-100% - 8px))' : 'translateX(8px)' }}
        >
          {describeRun(hoveredRun).map((line, n) => <p key={n} className={n === 0 ? 'font-medium' : undefined}>{line}</p>)}
        </div>
      )}
    </div>
  );
}
