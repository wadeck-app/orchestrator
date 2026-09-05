import React from 'react';
import { AuditEntryRow } from './AuditEntryRow.js';
import type { AuditEntry } from './AuditEntryRow.js';

export type { AuditEntry };

export interface AuditEntryListProps {
  entries?: AuditEntry[];
}

/**
 * @registryCategory composite
 * @registryTags audit list entries timeline
 */
export function AuditEntryList({ entries = [] }: AuditEntryListProps): React.ReactElement {
  if (entries.length === 0) {
    return <p className="text-muted text-center py-12">No audit events yet.</p>;
  }
  return (
    <div className="space-y-0.5">
      {entries.map((e, i) => (
        <AuditEntryRow key={i} entry={e} />
      ))}
    </div>
  );
}
