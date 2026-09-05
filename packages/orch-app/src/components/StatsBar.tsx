import React from 'react';

export interface StatsBarData { total: number; running: number; failed: number; }

// @formatter:off
const BAR_CLS = 'flex items-center gap-4 px-4 py-1 border-b border-border bg-surface text-xs text-muted';
// @formatter:on

export function StatsBar({ data }: { data: StatsBarData }): React.ReactElement {
  return (
    // violations-suppress: tailwind/no-raw-color-class count colors have no semantic token equivalents
    <div className={BAR_CLS}>
      <span>{data.total} jobs</span>
      {data.running > 0 && <span className="text-primary">{data.running} running</span>}
      {data.failed > 0  && <span className="text-danger">{data.failed} failed</span>}
      {data.running === 0 && data.failed === 0 && <span className="text-success">All OK</span>}
    </div>
  );
}
