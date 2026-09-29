// Statement tables: hairline-ruled rows, a navy rule under the head, a double-ruled subtotal.
// At 640 px and below a stacking table turns every row into label / value lines (each Cell's
// `label` is shown before its value), so nothing scrolls sideways on a phone.
//
//   <StatementTable columns={[{ label: 'Asset' }, { label: 'Quantity', align: 'right' },
//                             { label: 'Price', sub: 'USDC, best bid', align: 'right' }]}
//                   foot={<SubtotalRow label="Subtotal, priced holdings" span={2} valueLabel="USDC">…</SubtotalRow>}>
//     <tr>
//       <AssetCell symbol="wStkA" name="Stock A" origin={<>bridged from Sepolia <span className="mono">0x2Ab7…FB52</span></>} />
//       <Cell label="Quantity" align="right"><Money raw={…} decimals={6} /></Cell>
//       <Cell label="Price" align="right">1.02</Cell>
//     </tr>
//   </StatementTable>
//
// variant="book" is the compact order-book table: it stays a table at phone width.

import type { HTMLAttributes, ReactNode, TableHTMLAttributes, TdHTMLAttributes } from 'react';

import { cx } from './format.js';

export interface Column {
  label: ReactNode;
  /** A second, smaller line under the label (the unit). */
  sub?: ReactNode;
  align?: 'left' | 'right';
  /** Keep the label for screen readers only (an action column). */
  srOnly?: boolean;
}

export interface StatementTableProps extends TableHTMLAttributes<HTMLTableElement> {
  columns: ReadonlyArray<Column>;
  /** Rows for <tfoot>: usually one SubtotalRow. */
  foot?: ReactNode;
  /** Stack into label / value lines at phone width (default true; ignored for books). */
  stack?: boolean;
  variant?: 'ledger' | 'book';
  /** A caption read by screen readers (the visible title is usually the panel's). */
  caption?: ReactNode;
  /** The children are <tbody> row groups themselves (one per book line), not rows: they are not
   *  wrapped in one <tbody>. */
  groups?: boolean;
}

export function StatementTable({
  columns,
  foot,
  stack = true,
  variant = 'ledger',
  caption,
  groups = false,
  className,
  children,
  ...rest
}: StatementTableProps) {
  const right = variant === 'ledger' ? 'r' : undefined;
  return (
    <table className={cx(variant, variant === 'ledger' && stack && 'stack', className)} {...rest}>
      {caption ? <caption className="sr-only">{caption}</caption> : null}
      <thead>
        <tr>
          {columns.map((c, i) => (
            <th key={i} scope="col" className={c.align === 'right' ? right : undefined}>
              {c.srOnly ? <span className="sr-only">{c.label}</span> : c.label}
              {c.sub ? <span className="th-sub">{c.sub}</span> : null}
            </th>
          ))}
        </tr>
      </thead>
      {groups ? children : <tbody>{children}</tbody>}
      {foot ? <tfoot>{foot}</tfoot> : null}
    </table>
  );
}

export interface CellProps extends TdHTMLAttributes<HTMLTableCellElement> {
  /** The column's name, shown before the value when the table stacks on a phone. */
  label?: string;
  align?: 'left' | 'right';
  /** Tabular numerals, no wrapping. */
  num?: boolean;
  /** A cell that stands alone when stacked (no label), for example a date or a record name. */
  block?: boolean;
}

export function Cell({ label, align, num, block, className, ...rest }: CellProps) {
  return (
    <td
      data-label={label}
      className={cx(align === 'right' && 'r', num && 'num', block && 'cell-block', className) || undefined}
      {...rest}
    />
  );
}

/** The first cell of a holdings or market row: symbol, plain name, and where the token comes from. */
export function AssetCell({
  symbol,
  name,
  origin,
  children,
  className,
  ...rest
}: Omit<TdHTMLAttributes<HTMLTableCellElement>, 'children'> & {
  symbol: ReactNode;
  name?: ReactNode;
  origin?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <td className={cx('cell-asset', className)} {...rest}>
      <span className="sym">{symbol}</span>
      {name ? <span className="name">{name}</span> : null}
      {origin ? <span className="origin">{origin}</span> : null}
      {children}
    </td>
  );
}

/** A second line under a value ("largest single payment 60.00", "face value", a time). */
export function Sub({ className, multiline, ...rest }: HTMLAttributes<HTMLSpanElement> & { multiline?: boolean }) {
  return <span className={cx('sub', multiline && 'multiline', className)} {...rest} />;
}

/** The double-ruled subtotal line. `span` is how many columns the label covers. */
export function SubtotalRow({
  label,
  note,
  span,
  valueLabel,
  valueTestId,
  valueProps,
  children,
}: {
  label: ReactNode;
  note?: ReactNode;
  span: number;
  /** Shown before the value when stacked ("USDC"). */
  valueLabel?: string;
  valueTestId?: string;
  valueProps?: TdHTMLAttributes<HTMLTableCellElement>;
  children: ReactNode;
}) {
  return (
    <tr>
      <td className="cell-block" colSpan={span}>
        {label}
        {note ? <span className="foot-note">{note}</span> : null}
      </td>
      <td className="r num" data-label={valueLabel} data-testid={valueTestId} {...valueProps}>
        {children}
      </td>
    </tr>
  );
}
