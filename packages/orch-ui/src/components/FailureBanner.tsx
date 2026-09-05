import React from 'react';
import type { RuntimeEntry } from '../types.js';

export interface FailureEntry {
  jobId: string;
  entry: RuntimeEntry;
  jobLabel?: string;
}

export interface FailureBannerProps {
  failures: FailureEntry[];
  onAcknowledge: (jobId: string) => void;
  onAcknowledgeAll: () => void;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}

// @formatter:off
const PANEL_CLS      = 'fixed bottom-4 right-4 z-50 flex flex-col gap-2 w-72';
const CARD_CLS       = 'bg-surface border border-border rounded-lg shadow-lg overflow-hidden';
const HEADER_CLS     = 'flex items-center gap-2 px-3 py-2 bg-muted-bg border-b border-border';
const BODY_CLS       = 'flex items-center justify-between px-3 py-2';
const ACK_BTN_CLS    = 'text-xs px-2 py-1 rounded border border-border text-content hover:bg-muted-bg transition-colors';
const ACK_ALL_CLS    = 'self-end text-xs px-3 py-1.5 rounded border border-border bg-surface text-muted hover:bg-muted-bg transition-colors shadow';
// @formatter:on

export function FailureBanner({ failures, onAcknowledge, onAcknowledgeAll }: FailureBannerProps): React.ReactElement | null {
  if (failures.length === 0) return null;

  return (
    <div className={PANEL_CLS} role="alert" aria-live="polite">
      {failures.map(f => {
        const time = f.entry.startedAt ? formatTime(f.entry.startedAt) : '';
        return (
          <div key={f.jobId} className={CARD_CLS}>
            <div className={HEADER_CLS}>
              {/* violations-suppress: tailwind/no-raw-color-class no semantic token for status dot */}
              <span className="w-2 h-2 rounded-full bg-red-500 shrink-0" />
              <span className="text-sm font-medium text-content truncate flex-1">
                {f.jobLabel ?? f.jobId}
              </span>
              <span className="text-xs text-muted shrink-0">{time}</span>
            </div>
            <div className={BODY_CLS}>
              <span className="text-xs text-muted">exit {f.entry.exitCode ?? '?'}</span>
              {/* violations-suppress: react/no-raw-button toast acknowledge button - Button component doesn't fit compact toast pattern */}
              <button onClick={() => onAcknowledge(f.jobId)} className={ACK_BTN_CLS}>
                Acknowledge
              </button>
            </div>
          </div>
        );
      })}
      {failures.length > 1 && (
        // violations-suppress: react/no-raw-button toast acknowledge-all button - Button component doesn't fit compact toast pattern
        <button onClick={onAcknowledgeAll} className={ACK_ALL_CLS}>
          Acknowledge all ({failures.length})
        </button>
      )}
    </div>
  );
}
