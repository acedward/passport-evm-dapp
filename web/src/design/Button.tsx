// Buttons, at least 44 px tall (the small size grows to 44 px on touch screens).
//
//   <Button onClick={…}>Open account</Button>                       primary (navy)
//   <Button variant="secondary" size="small">Refresh</Button>
//   <Button variant="danger">CLEAR ALL</Button>
//   <Button variant="link">Close</Button>                           an inline text action
//   <ButtonLink href="#trade?offer=…" size="small">Take</ButtonLink> a link that looks like a button
//   <ButtonRow stretch>…</ButtonRow>                                 full width on a phone

import type { AnchorHTMLAttributes, ButtonHTMLAttributes, HTMLAttributes } from 'react';

import { cx } from './format.js';

export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'inverse' | 'link';
export type ButtonSize = 'normal' | 'small';

export function buttonClass(variant: ButtonVariant = 'primary', size: ButtonSize = 'normal', extra?: string): string {
  if (variant === 'link') return cx('btn-link', extra);
  return cx('btn', variant !== 'primary' && `btn-${variant}`, size === 'small' && 'btn-small', extra);
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

export function Button({ variant, size, className, type = 'button', ...rest }: ButtonProps) {
  return <button type={type} className={buttonClass(variant, size, className)} {...rest} />;
}

export interface ButtonLinkProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

export function ButtonLink({ variant = 'secondary', size, className, ...rest }: ButtonLinkProps) {
  return <a className={buttonClass(variant, size, className)} {...rest} />;
}

export function ButtonRow({
  stretch = false,
  className,
  ...rest
}: HTMLAttributes<HTMLDivElement> & { stretch?: boolean }) {
  return <div className={cx('btn-row', stretch && 'stretch', className)} {...rest} />;
}
