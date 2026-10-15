import React, { useCallback, useEffect, useRef } from 'react';

/**
 * In-app replacement for `window.confirm`.
 *
 * WHY this exists rather than the one-liner: `window.confirm` BLOCKS the renderer's
 * main thread until the browser process has run a native modal. While blocked the
 * renderer services nothing at all -- no streaming chunks, no IPC replies, no
 * repaint -- and if the modal cannot be presented (a window in a bad state, a
 * reload landing mid-dialog) the thread stays parked with zero CPU and no way out.
 * That is exactly the shape KiroLex was seen frozen in: `CrRendererMain` sitting in
 * `mach_msg2_trap` for every sample of a macOS hang report while nothing burned CPU.
 * A React overlay cannot do that: the handler returns immediately and the decision
 * arrives later as a normal state update.
 *
 * Secondary reasons: a native dialog cannot be styled to match the app, shows the
 * Electron binary's name to the user, and cannot carry the multi-line explanation
 * that a destructive action deserves.
 *
 * The markup reuses `.overlay` / `.permission-dialog` / `.actions` / `.btn`, the same
 * classes as the existing project-delete confirmation, so there is one visual
 * language for "are you sure" and no new CSS.
 */
export interface ConfirmRequest {
  /** Short heading, e.g. '🗑 丢弃草稿'. */
  title: string;
  /** Body text. Newlines are preserved, so a consequence can go on its own line. */
  message: string;
  /** Label of the button that performs the action. Defaults to '确定'. */
  confirmLabel?: string;
  /** Label of the dismissing button. Defaults to '取消'. */
  cancelLabel?: string;
  /** Paint the confirm button red. Use for anything irreversible. */
  destructive?: boolean;
  /** Run when confirmed. The dialog closes first, so this may itself open another. */
  onConfirm: () => void;
}

interface ConfirmDialogProps {
  /** The pending question, or null when nothing is being asked. */
  request: ConfirmRequest | null;
  /** Clear the pending question. Called for cancel, Esc, overlay click and confirm. */
  onClose: () => void;
}

export const ConfirmDialog: React.FC<ConfirmDialogProps> = ({ request, onClose }) => {
  const confirmRef = useRef<HTMLButtonElement | null>(null);

  const accept = useCallback(() => {
    const run = request?.onConfirm;
    // Close FIRST: the action may replace this dialog with another one, and it must
    // not be torn down by our own onClose afterwards.
    onClose();
    run?.();
  }, [request, onClose]);

  // Keyboard: Esc cancels, Enter confirms. Bound on the document because the dialog
  // is mounted next to the tree it interrupts, not inside it.
  useEffect(() => {
    if (!request) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); }
      else if (e.key === 'Enter') { e.preventDefault(); accept(); }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [request, accept, onClose]);

  // Focus the confirming button so Space/Enter work without a click, and so focus is
  // not left behind in the element that opened the dialog.
  useEffect(() => {
    if (request) requestAnimationFrame(() => confirmRef.current?.focus());
  }, [request]);

  if (!request) return null;
  return (
    <>
      <div className="overlay" onClick={onClose} />
      <div className="permission-dialog" role="dialog" aria-modal="true" aria-label={request.title}>
        <h3>{request.title}</h3>
        {/* pre-wrap so the caller can put the consequence on its own line. */}
        <p style={{ whiteSpace: 'pre-wrap' }}>{request.message}</p>
        <div className="actions">
          <button className="btn deny" onClick={onClose}>
            {request.cancelLabel || '取消'}
          </button>
          <button
            ref={confirmRef}
            className="btn allow"
            onClick={accept}
            style={request.destructive ? { background: '#ef5350' } : undefined}
          >
            {request.confirmLabel || '确定'}
          </button>
        </div>
      </div>
    </>
  );
};

export default ConfirmDialog;
