// Notices: a boxed message with a coloured left rule.
//
//   <Notice tone="warning" title="One live offer per account.">Placing an order … cancels it.</Notice>
//   <Notice tone="danger" role="alert">The balances could not be refreshed.</Notice>
//   <Notice tone="success" role="status">Your account e8d3…2d09 is open.</Notice>
//
// Pass role="alert" (errors) or role="status" (results) only for messages that appear in
// response to something the customer did; a standing explanation needs no role.

import type { HTMLAttributes, ReactNode } from 'react';

import { cx } from './format.js';

export type NoticeTone = 'info' | 'warning' | 'danger' | 'success';

const TONE_CLASS: Record<NoticeTone, string | null> = {
  info: null,
  warning: 'notice-warn',
  danger: 'notice-danger',
  success: 'notice-success',
};

export interface NoticeProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  tone?: NoticeTone;
  /** A bold lead-in sentence. */
  title?: ReactNode;
}

export function Notice({ tone = 'info', title, className, children, ...rest }: NoticeProps) {
  return (
    <div className={cx('notice', TONE_CLASS[tone], className)} data-tone={tone} {...rest}>
      {title ? (
        <>
          <strong className="notice-title">{title}</strong>{' '}
        </>
      ) : null}
      {children}
    </div>
  );
}
