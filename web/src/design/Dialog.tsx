// Dialogs, on the native <dialog> element opened with showModal(): the page behind becomes
// inert, focus moves into the dialog and stays there, and Escape closes it (as Cancel does).
//
//   <Dialog open={open} title="Leave this page?" onClose={() => setOpen(false)}
//           actions={<><Button variant="secondary" onClick={…}>Stay</Button><Button onClick={…}>Leave</Button></>}>
//     <p>…</p>
//   </Dialog>
//
//   <TypedConfirmDialog open={confirming} tone="danger" title="Clear all MN Bank data from this browser?"
//     phrase="CLEAR ALL" warning={<>Without an export you cannot spend these funds again.</>}
//     onExportFirst={exportMine} confirmLabel="Clear all data" onConfirm={clearAll} onCancel={close}
//     testIdPrefix="clear">…</TypedConfirmDialog>
//   gives data-testid clear-dialog, clear-export-first, clear-confirm-input, clear-confirm, clear-cancel.

import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

import { Button } from './Button.js';
import { TextInput } from './Field.js';
import { cx } from './format.js';
import { Notice } from './Notice.js';

export interface DialogProps {
  open: boolean;
  title: ReactNode;
  /** Escape, or the page's Cancel. */
  onClose(): void;
  tone?: 'default' | 'danger';
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
  testId?: string;
}

export function Dialog({ open, title, onClose, tone = 'default', actions, children, className, testId }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useLayoutEffect(() => {
    const d = ref.current;
    if (!d || !open) return;
    if (!d.open) d.showModal();
    return () => {
      if (d.open) d.close();
    };
  }, [open]);
  if (!open) return null;
  return (
    <dialog
      ref={ref}
      className={cx('mnb-dialog', tone === 'danger' && 'tone-danger', className)}
      aria-labelledby={titleId}
      data-testid={testId}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <h2 id={titleId} className="dialog-title">
        {title}
      </h2>
      <div className="dialog-body">{children}</div>
      {actions ? <div className="dialog-actions">{actions}</div> : null}
    </dialog>
  );
}

export interface TypedConfirmDialogProps {
  open: boolean;
  title: ReactNode;
  /** What must be typed, exactly, before the confirm button works. */
  phrase: string;
  /** The consequences, in a danger notice. */
  warning?: ReactNode;
  /** When given, step 1 offers to save a copy first. */
  onExportFirst?: () => void;
  exportLabel?: string;
  confirmLabel: string;
  onConfirm(): void;
  onCancel(): void;
  tone?: 'default' | 'danger';
  /** data-testid prefix: <p>-dialog, <p>-export-first, <p>-confirm-input, <p>-confirm, <p>-cancel. */
  testIdPrefix?: string;
  children?: ReactNode;
}

export function TypedConfirmDialog(props: TypedConfirmDialogProps) {
  if (!props.open) return null;
  // Mounted only while open, so the typed text starts empty every time.
  return <TypedConfirmBody {...props} />;
}

function TypedConfirmBody({
  open,
  title,
  phrase,
  warning,
  onExportFirst,
  exportLabel = 'Export first',
  confirmLabel,
  onConfirm,
  onCancel,
  tone = 'danger',
  testIdPrefix = 'confirm',
  children,
}: TypedConfirmDialogProps) {
  const [typed, setTyped] = useState('');
  const inputId = useId();
  const matches = typed === phrase;
  const t = (s: string) => `${testIdPrefix}-${s}`;
  return (
    <Dialog
      open={open}
      title={title}
      tone={tone}
      onClose={onCancel}
      testId={t('dialog')}
      actions={
        <>
          <Button variant="secondary" data-testid={t('cancel')} onClick={onCancel}>
            Cancel
          </Button>
          <Button
            variant="danger"
            data-testid={t('confirm')}
            disabled={!matches}
            onClick={() => {
              if (matches) onConfirm();
            }}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      {children}
      {warning ? (
        <Notice tone="danger" className="dialog-notice">
          {warning}
        </Notice>
      ) : null}
      <div className="confirm-steps">
        {onExportFirst ? (
          <>
            <p className="stepline">
              <strong>1.</strong> Save a copy first.
            </p>
            <Button data-testid={t('export-first')} onClick={onExportFirst}>
              {exportLabel}
            </Button>
          </>
        ) : null}
        <p className="stepline">
          {onExportFirst ? <strong>2. </strong> : null}
          <label htmlFor={inputId}>
            Type <strong>{phrase}</strong> to confirm.
          </label>
        </p>
        <TextInput
          id={inputId}
          data-testid={t('confirm-input')}
          autoComplete="off"
          spellCheck={false}
          placeholder={phrase}
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
        />
      </div>
    </Dialog>
  );
}
