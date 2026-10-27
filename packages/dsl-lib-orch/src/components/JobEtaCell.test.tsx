import React from 'react';
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { JobEtaCell } from './JobEtaCell.js';
import type { ProgressEstimate } from '../types.js';

const NOW = Date.parse('2026-10-20T14:00:00.000Z');

function noEstimate(reason: string): ProgressEstimate {
  return { strategyId: null, progress: null, etaAt: null, confidence: 'none', confidenceScore: 0, reason, serverNow: new Date(NOW).toISOString() };
}

describe('JobEtaCell without an estimate', () => {
  it('shows the reason muted and in italics, with the reason as its tooltip', () => {
    const { container } = render(<JobEtaCell progress={noEstimate('long-running')} nowMs={NOW} />);

    const cell = container.querySelector('[data-progress-state="none"]')!;
    expect(cell.textContent).toBe('long-running');
    expect(cell.getAttribute('title')).toBe('long-running');
    expect(cell.getAttribute('class')).toContain('text-muted');
    expect(cell.getAttribute('class')).toContain('italic');
  });
});
