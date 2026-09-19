import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { JobFilterChips } from './JobFilterChips.js';

describe('JobFilterChips', () => {
  it('offers Past once beside the type filters', () => {
    render(<JobFilterChips />);
    for (const label of ['All', 'Cron', 'Startup', 'Once', 'Failed', 'Past once']) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });

  it('reports the selected filter, past-once included', () => {
    const onChange = vi.fn();
    render(<JobFilterChips onChange={onChange} />);
    screen.getByText('Past once').click();
    expect(onChange).toHaveBeenCalledWith('past-once');
  });
});
