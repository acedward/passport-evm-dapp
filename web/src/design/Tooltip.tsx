// A control that says why it is greyed out, on hover, keyboard focus and tap (AA 00044): an
// order-book Buy or Sell the account cannot pay.
//
//   <Tooltip id={`nt-${offerId}`} text="Not enough wStkA. You hold 100.00 wStkA.">
//     <Button size="small" variant="secondary" disabled aria-describedby={`nt-${offerId}`}>Sell</Button>
//   </Tooltip>
//
// A disabled button takes no focus, and some browsers send it no pointer events, so the WRAPPER is
// focusable and receives the hover and the tap (a disabled control inside it lets pointer events
// through, components.css). The control's aria-describedby names `id`, a visually hidden copy of
// the text, so a screen reader reads the same sentence; the visible bubble is aria-hidden. The
// bubble stays open while the pointer is on it, and Escape hides it (WCAG 1.4.13).

import { useEffect, useState, type HTMLAttributes, type ReactNode } from 'react';

import { cx } from './format.js';

export interface TooltipProps extends Omit<HTMLAttributes<HTMLSpanElement>, 'children' | 'id'> {
  /** The id of the visually hidden text: the control inside names it in its aria-describedby. */
  id: string;
  text: string;
  children: ReactNode;
}

export function Tooltip({ id, text, children, className, ...rest }: TooltipProps) {
  const [hover, setHover] = useState(false);
  const [focus, setFocus] = useState(false);
  const [tapped, setTapped] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const shown = (hover || focus || tapped) && !dismissed;

  // Escape hides it wherever the keyboard focus is (a hovered wrapper may not have it).
  useEffect(() => {
    if (!shown) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setDismissed(true);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [shown]);

  return (
    <span
      {...rest}
      className={cx('tip', shown && 'tip-open', className)}
      tabIndex={0}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => {
        setHover(false);
        setTapped(false);
        setDismissed(false);
      }}
      onFocus={() => setFocus(true)}
      onBlur={() => {
        setFocus(false);
        setTapped(false);
        setDismissed(false);
      }}
      onClick={() => {
        setTapped(true);
        setDismissed(false);
      }}
    >
      {children}
      <span className="sr-only" id={id}>
        {text}
      </span>
      <span className="tip-bubble" aria-hidden="true" data-testid="tooltip">
        {text}
      </span>
    </span>
  );
}
