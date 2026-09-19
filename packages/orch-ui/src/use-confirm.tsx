import React, { useCallback, useState } from 'react';
import { ButtonAction, ConfirmDialog, Dialog } from '@wadeck-app/dsl-ui';

export interface ConfirmRequest {
  title: string;
  message: React.ReactNode;
  confirmLabel?: string;
  confirmVariant?: 'danger' | 'primary';
  onConfirm: () => void;
}

export interface NoticeRequest {
  title: string;
  message: React.ReactNode;
  /** Defaults to "OK". */
  dismissLabel?: string;
}

export interface UseConfirm {
  /** Opens the dialog for one action. A second call replaces the first. */
  ask: (request: ConfirmRequest) => void;
  /** States something the reader has to acknowledge. No choice, so a single button. */
  notify: (request: NoticeRequest) => void;
  /** Render this somewhere in the component. Null while nothing is being asked or said. */
  dialog: React.ReactElement | null;
}

/** What is currently on screen. One at a time, so an ask and a notice cannot stack. */
type Pending =
  | { kind: 'confirm'; request: ConfirmRequest }
  | { kind: 'notice'; request: NoticeRequest };

/**
 * Confirmation for a destructive action, and acknowledgement of a failure, in the app's own dialog.
 *
 * Five call sites used the browser's native `confirm()` -- killing a running job in three places and
 * deleting jobs in bulk -- and four used `alert()` to report a kill that failed. Both block the whole
 * page, cannot be styled, and look nothing like the dashboard; on a kill prompt the stakes are exactly
 * when the reader should be able to tell they are still in the app they think they are in.
 *
 * dsl-ui's ConfirmDialog is controlled, so each site would otherwise grow its own `open` state, a
 * dialog element and somewhere to keep the pending action. This is that boilerplate once.
 *
 * `notify` lives here rather than in a second hook so a component has ONE `dialog` to render. Two
 * hooks would mean two slots and two independent `open` states, which is how a confirmation and an
 * error end up on screen at the same time arguing with each other.
 *
 * Deliberately not dsl-ui's Toast: `useToast` throws without a `ToastProvider`, which these
 * components are rendered without in their own tests, and a kill that failed is not something to
 * retract after four seconds.
 *
 * The pending item lives in state rather than a ref so a second call replaces the first: a stale
 * action surviving behind a new dialog is how a reader confirms "delete 3 jobs" and gets a kill, which
 * is the one outcome a confirmation exists to prevent.
 */
export function useConfirm(): UseConfirm {
  const [pending, setPending] = useState<Pending | null>(null);

  const ask = useCallback((request: ConfirmRequest) => {
    setPending({ kind: 'confirm', request });
  }, []);

  const notify = useCallback((request: NoticeRequest) => {
    setPending({ kind: 'notice', request });
  }, []);

  const close = useCallback(() => { setPending(null); }, []);

  let dialog: React.ReactElement | null = null;
  if (pending?.kind === 'confirm') {
    const { request } = pending;
    dialog = (
      <ConfirmDialog
        open
        // Closing for any reason -- Cancel, Escape, the overlay -- drops the pending action rather than
        // leaving it armed for the next dialog.
        onOpenChange={(open) => { if (!open) { close(); } }}
        title={request.title}
        message={request.message}
        confirmLabel={request.confirmLabel}
        confirmVariant={request.confirmVariant ?? 'danger'}
        onConfirm={() => {
          // Cleared first, so the action cannot be confirmed twice by a double click.
          close();
          request.onConfirm();
        }}
      />
    );
  } else if (pending?.kind === 'notice') {
    const { request } = pending;
    dialog = (
      <Dialog
        open
        size="sm"
        onOpenChange={(open) => { if (!open) { close(); } }}
        title={request.title}
        actions={<ButtonAction label={request.dismissLabel ?? 'OK'} variant="secondary" onClick={close} />}
      >
        <p className="text-sm text-muted">{request.message}</p>
      </Dialog>
    );
  }

  return { ask, notify, dialog };
}
