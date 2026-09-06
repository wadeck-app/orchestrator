import React from 'react';
import { AuditEntryRow, type AuditEntry } from './AuditEntryRow.js';

export interface AuditListProps {
  entries?: AuditEntry[];
}

/**
 * @registryCategory composite
 * @registryTags audit list entries icons
 */
export function AuditList({ entries }: AuditListProps): React.ReactElement {
  if (!entries) {
    return (
      <div className="flex justify-center py-12">
        <div className="w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }
  if (entries.length === 0) {
    return <p className="text-muted text-center py-12">No audit entries.</p>;
  }
  return (
    <div className="divide-y divide-border">
      {entries.map((entry, i) => <AuditEntryRow key={i} entry={entry} />)}
    </div>
  );
}
