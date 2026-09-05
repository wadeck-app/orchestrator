import React from 'react';
import type { TriggerSource } from '../types.js';

interface Props { source?: TriggerSource; }

/**
 * @registryCategory atomic
 * @registryTags badge trigger source manual cron
 */
export function TriggerBadge({ source }: Props): React.ReactElement {
  const s = source ?? { kind: 'cron' };
  if (s.kind === 'cron') {
    return <span className="text-xs px-1.5 py-0.5 rounded bg-muted/20 text-muted">cron</span>;
  }
  const label = s.ip ? `manual - ${s.ip}` : 'manual';
  return <span className="text-xs px-1.5 py-0.5 rounded bg-primary/10 text-primary" title={s.userAgent}>{label}</span>;
}
