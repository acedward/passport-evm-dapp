// The statement's top strip of summary figures, and the Pending box's items.
//
//   <Figures>
//     <Figure main label="Total value, priced holdings" value={<Money raw={…} decimals={6} unit="USDC" />}
//             note="Stocks are valued at the best bid…" />
//     <Figure label="Ethereum (Sepolia)" value={<Money … />} />
//   </Figures>
//   <PendingItem what="Deposit 25.00 stkA to wStkA" badge={<Badge tone="gold">5 of 7</Badge>}
//                state="Waiting for Sepolia finality" meta={<>request <Hash value={id} /></>} />

import type { HTMLAttributes, ReactNode } from 'react';

import { cx } from './format.js';

export function Figures({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cx('figures', className)} {...rest} />;
}

export function Figure({
  label,
  value,
  note,
  main = false,
  className,
  ...rest
}: Omit<HTMLAttributes<HTMLDivElement>, 'children'> & {
  label: ReactNode;
  value: ReactNode;
  note?: ReactNode;
  main?: boolean;
}) {
  return (
    <div className={cx('figure', main && 'figure-main', className)} {...rest}>
      <span className="eyebrow">{label}</span>
      <span className="figure-value">{value}</span>
      {note ? <span className="figure-note">{note}</span> : null}
    </div>
  );
}

export function PendingItem({
  what,
  badge,
  state,
  meta,
  progress,
  children,
  className,
  ...rest
}: HTMLAttributes<HTMLDivElement> & {
  what: ReactNode;
  badge?: ReactNode;
  state?: ReactNode;
  meta?: ReactNode;
  /** 0–1, drawn as a thin bar (omit when the duration is unknown). */
  progress?: number;
}) {
  return (
    <div className={cx('pending-item', className)} {...rest}>
      <div className="line1">
        <span className="what">{what}</span>
        {badge}
      </div>
      {state ? <p className="state">{state}</p> : null}
      {progress !== undefined ? (
        <div className="progress" aria-hidden="true">
          <span style={{ width: `${Math.round(Math.min(1, Math.max(0, progress)) * 100)}%` }} />
        </div>
      ) : null}
      {meta ? <p className="meta">{meta}</p> : null}
      {children ? <div className="actions">{children}</div> : null}
    </div>
  );
}
