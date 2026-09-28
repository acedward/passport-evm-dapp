// Page structure: the page head, panels and cards.
//
//   <PageHead eyebrow="Statement" title="Accounts" lede="…" actions={<Button …>Refresh</Button>} />
//   <Panel title="Ethereum (Sepolia)" meta={<>Wallet <span className="mono">0x4847…e56b</span></>}>…</Panel>
//   <Panel tone="quiet" as="aside" title="Pending">…</Panel>      the ivory-grey side box
//   <Card title="Open your Passport account">…</Card>               a panel with the gold top rule
//
// Headings: the masthead's "MN Bank" is the page's h1, a page title is an h2, a panel title an h3.

import { useId, type HTMLAttributes, type ReactNode } from 'react';

import { cx } from './format.js';

export function PageHead({
  eyebrow,
  title,
  titleId,
  lede,
  actions,
  className,
  ...rest
}: Omit<HTMLAttributes<HTMLDivElement>, 'title'> & {
  eyebrow?: ReactNode;
  title: ReactNode;
  titleId?: string;
  lede?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className={cx('page-head', className)} {...rest}>
      <div>
        {eyebrow ? <p className="eyebrow">{eyebrow}</p> : null}
        <h2 className="page-title" id={titleId}>
          {title}
        </h2>
        {lede ? <p className="lede">{lede}</p> : null}
      </div>
      {actions ? <div className="page-head-actions">{actions}</div> : null}
    </div>
  );
}

export type PanelTone = 'default' | 'quiet' | 'accent';
type PanelElement = 'section' | 'div' | 'aside' | 'form';

export interface PanelProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
  title?: ReactNode;
  /** Right-hand side of the panel's head: a caption, a status, a small action. */
  meta?: ReactNode;
  tone?: PanelTone;
  as?: PanelElement;
  headingLevel?: 3 | 4;
  /** For a form panel. */
  noValidate?: boolean;
}

export function Panel({
  title,
  meta,
  tone = 'default',
  as: Tag = 'section',
  headingLevel = 3,
  className,
  children,
  ...rest
}: PanelProps) {
  const id = useId();
  const H = headingLevel === 3 ? 'h3' : 'h4';
  const labelled = title && !rest['aria-label'] && !rest['aria-labelledby'] ? { 'aria-labelledby': id } : {};
  return (
    <Tag className={cx('panel', tone !== 'default' && `panel-${tone}`, className)} {...labelled} {...rest}>
      {title || meta ? (
        <div className="panel-head">
          {title ? (
            <H id={id} className="panel-title">
              {title}
            </H>
          ) : (
            <span />
          )}
          {meta ? <div className="panel-meta">{meta}</div> : null}
        </div>
      ) : null}
      {children}
    </Tag>
  );
}

/** A panel with the gold top rule, for the one card that invites an action. */
export function Card(props: Omit<PanelProps, 'tone'>) {
  return <Panel tone="accent" {...props} />;
}
