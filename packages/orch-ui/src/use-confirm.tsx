import React, { useCallback, useState } from 'react';
import { ConfirmDialog } from '@wadeck-app/dsl-ui';

export interface ConfirmRequest {
  title: string;
  message: React.ReactNode;
  confirmLabel?: string;
  confirmVariant?: 'danger' | 'primary';
  onConfirm: () => void;
}

export interface UseConfirm {
  /** Opens the dialog for one action. A second call replaces the first. */
  ask: (request: ConfirmRequest) => void;
  /** Render this somewhere in the component. Null while nothing is being asked. */
  dialog: React.ReactElement | null;
}

/**
 * Confirmation for a destructive action, in the app's own dialog.
 *
 * Five call sites used the browser's native `confirm()` -- killing a running job in three places and
 * deleting jobs in bulk. It blocks the whole page, cannot be styled, and looks nothing like the
 * dashboard; on a kill prompt the stakes are exactly when the reader should be able to tell they are
 * still in the app they think they are in.
 *
 * dsl-ui's ConfirmDialog is controlled, so each site would otherwise grow its own `open` state, a
 * dialog element and somewhere to keep the pending action. This is that boilerplate once.
 *
 * The pending action lives in state rather than a ref so a second `ask` replaces the first: a stale
 * action surviving behind a new dialog is how a reader confirms "delete 3 jobs" and gets a kill, which
 * is the one outcome a confirmation exists to prevent.
 */
export function useConfirm(): UseConfirm {
  const [request, setRequest] = useState<ConfirmRequest | null>(null);

  const ask = useCallback((next: ConfirmRequest) => {
    setRequest(next);
  }, []);

  const dialog = request === null ? null : (
    <ConfirmDialog
      open
      // Closing for any reason -- Cancel, Escape, the overlay -- drops the pending action rather than
      // leaving it armed for the next dialog.
      onOpenChange={(open) => { if (!open) { setRequest(null); } }}
      title={request.title}
      message={request.message}
      confirmLabel={request.confirmLabel}
      confirmVariant={request.confirmVariant ?? 'danger'}
      onConfirm={() => {
        // Cleared first, so the action cannot be confirmed twice by a double click.
        setRequest(null);
        request.onConfirm();
      }}
    />
  );

  return { ask, dialog };
}
