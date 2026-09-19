import React from 'react';
import { Spinner } from '@wadeck-app/dsl-ui';
import { AuditEntryRow, type AuditEntry } from './AuditEntryRow.js';

export interface AuditListProps {
  entries?: AuditEntry[];
}

/**
 * @registryCategory composite
 * @registryTags audit list entries icons
 */
export function AuditList({ entries }: AuditListProps): React.ReactElement {
  // dsl-ui's Spinner rather than a hand-rolled div: the raw one had no role and no accessible name,
  // so a screen reader was told nothing at all while the page was loading.
  if (!entries) {
    return (
      <div className="flex justify-center py-12">
        <Spinner size="lg" />
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
