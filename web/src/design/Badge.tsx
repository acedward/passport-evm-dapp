// Badges and pills: short labels that classify a row or a value.
//
//   <Badge tone="green">Two-sided</Badge>            a market's status
//   <NetworkBadge network="sepolia" />               "SEPOLIA" (on the masthead, or onLight)
//   <StatusPill status="live">Live</StatusPill>      an offer's or transfer's state, with a dot
//   <NoValue>no liquidity</NoValue>                  a value that is deliberately absent
//   <YoursBadge />                                   the account's own offer in a book
//   <NotTakeable reason="needs a single 12.00 wUSDC coin; your largest is 11.00." />

import type { HTMLAttributes, ReactNode } from 'react';

import { cx } from './format.js';

export type BadgeTone = 'navy' | 'gold' | 'grey' | 'green' | 'red';

export function Badge({ tone = 'grey', className, ...rest }: HTMLAttributes<HTMLSpanElement> & { tone?: BadgeTone }) {
  return <span className={cx('tag', `tag-${tone}`, className)} {...rest} />;
}

export function NetworkBadge({
  network,
  onLight = false,
  children,
  className,
  ...rest
}: HTMLAttributes<HTMLSpanElement> & { network: 'sepolia' | 'midnight'; onLight?: boolean; children?: ReactNode }) {
  return (
    <span className={cx('net', `net-${network}`, onLight && 'net-light', className)} {...rest}>
      {children ?? (network === 'sepolia' ? 'Sepolia' : 'Midnight')}
    </span>
  );
}

export type PillStatus = 'live' | 'filled' | 'done' | 'cancelled' | 'idle' | 'progress' | 'refunded' | 'failed';

export function StatusPill({ status, className, ...rest }: HTMLAttributes<HTMLSpanElement> & { status: PillStatus }) {
  return <span className={cx('status', `st-${status}`, className)} data-status={status} {...rest} />;
}

export function NoValue({ className, ...rest }: HTMLAttributes<HTMLSpanElement>) {
  return <span className={cx('no-value', className)} {...rest} />;
}

export function YoursBadge({ children = 'Your offer', ...rest }: HTMLAttributes<HTMLSpanElement>) {
  return (
    <Badge tone="gold" {...rest}>
      {children}
    </Badge>
  );
}

/** An offer the account cannot take, with the reason in words (one coin must cover it, Q9). */
export function NotTakeable({ reason, ...rest }: HTMLAttributes<HTMLSpanElement> & { reason: ReactNode }) {
  return (
    <span className="not-takeable" {...rest}>
      <Badge tone="grey">Not takeable</Badge> <span className="small muted">{reason}</span>
    </span>
  );
}
