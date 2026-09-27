// Form fields: a label, the control, a hint and an error, in the bank's 44 px field style.
//
//   <Field label="Amount" htmlFor="dep-amount" hint="In your wallet: 989,880.00 stkB">
//     <UnitInput id="dep-amount" unit="stkB" inputMode="decimal" value={…} onChange={…} />
//   </Field>
//   <Field label="Token" htmlFor="dep-token"><Select id="dep-token">…</Select></Field>
//   <CopyField value={depositAddress} data-testid="deposit-address" />
//   <KeyValueList items={[{ term: 'Midnight fees', value: 'paid by the bank' }]} />
//   <Segmented label="Side" options={[{ value: 'buy', label: 'Buy' }, …]} value={side} onChange={setSide} />

import {
  useEffect,
  useId,
  useState,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type Ref,
  type SelectHTMLAttributes,
} from 'react';

import { Button } from './Button.js';
import { cx } from './format.js';

export interface FieldProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  label: ReactNode;
  /** The id of the control the label names. */
  htmlFor?: string;
  hint?: ReactNode;
  error?: ReactNode;
  children: ReactNode;
}

export function Field({ label, htmlFor, hint, error, children, className, ...rest }: FieldProps) {
  return (
    <div className={cx('field', className)} {...rest}>
      {htmlFor ? (
        <label className="field-label" htmlFor={htmlFor}>
          {label}
        </label>
      ) : (
        <span className="field-label">{label}</span>
      )}
      {children}
      {hint ? <span className="field-hint">{hint}</span> : null}
      {error ? (
        <span className="field-error" role="alert">
          {error}
        </span>
      ) : null}
    </div>
  );
}

export function TextInput({
  className,
  ref,
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & { ref?: Ref<HTMLInputElement> }) {
  return <input ref={ref} className={cx('input', className)} {...rest} />;
}

export function Select({
  className,
  ref,
  ...rest
}: SelectHTMLAttributes<HTMLSelectElement> & { ref?: Ref<HTMLSelectElement> }) {
  return <select ref={ref} className={cx('input', className)} {...rest} />;
}

/** A number input with its unit as a suffix ("50.00 [stkB]"); the unit is announced with it. */
export function UnitInput({
  unit,
  className,
  ref,
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & { unit: ReactNode; ref?: Ref<HTMLInputElement> }) {
  const unitId = useId();
  const describedBy = [rest['aria-describedby'], unitId].filter(Boolean).join(' ');
  return (
    <div className={cx('input-unit', className)}>
      <input ref={ref} className="input" {...rest} aria-describedby={describedBy} />
      <span className="unit" id={unitId}>
        {unit}
      </span>
    </div>
  );
}

/** Copy `text` to the clipboard; resolves false when the browser refuses. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** A value to copy whole (a deposit address): it wraps anywhere and has a Copy button. */
export function CopyField({ value, ...rest }: Omit<HTMLAttributes<HTMLElement>, 'children'> & { value: string }) {
  const [copied, setCopied] = useState<'no' | 'yes' | 'failed'>('no');
  useEffect(() => {
    if (copied === 'no') return;
    const t = setTimeout(() => setCopied('no'), 2000);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <div className="copy-field">
      <code {...rest}>{value}</code>
      <Button
        variant="secondary"
        size="small"
        onClick={() => void copyText(value).then((ok) => setCopied(ok ? 'yes' : 'failed'))}
      >
        {copied === 'yes' ? 'Copied' : copied === 'failed' ? 'Copy failed' : 'Copy'}
      </Button>
    </div>
  );
}

export interface KeyValueItem {
  term: ReactNode;
  value: ReactNode;
  /** Extra attributes for the value (for example a data-testid). */
  valueProps?: HTMLAttributes<HTMLElement> & { 'data-testid'?: string };
}

export function KeyValueList({
  items,
  className,
  ...rest
}: HTMLAttributes<HTMLDListElement> & { items: ReadonlyArray<KeyValueItem> }) {
  return (
    <dl className={cx('kv', className)} {...rest}>
      {items.map((it, i) => (
        <KeyValueRow key={i} item={it} />
      ))}
    </dl>
  );
}

function KeyValueRow({ item }: { item: KeyValueItem }) {
  return (
    <>
      <dt>{item.term}</dt>
      <dd {...item.valueProps}>{item.value}</dd>
    </>
  );
}

export interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
  /** A test id for this choice's button. */
  testId?: string;
}

/** Two or three mutually exclusive choices (Buy | Sell): a radio group drawn as joined buttons.
 *  The arrow keys move the choice, as in a native radio group. */
export function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
  disabled,
}: {
  label: string;
  options: ReadonlyArray<SegmentedOption<T>>;
  value: T;
  onChange(value: T): void;
  disabled?: boolean;
}) {
  const move = (from: number, step: number) => {
    const next = options[(from + step + options.length) % options.length];
    if (next) onChange(next.value);
  };
  return (
    <div className="seg" role="radiogroup" aria-label={label}>
      {options.map((o, i) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          tabIndex={o.value === value ? 0 : -1}
          disabled={disabled}
          data-testid={o.testId}
          onClick={() => onChange(o.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
              e.preventDefault();
              move(i, 1);
            } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
              e.preventDefault();
              move(i, -1);
            }
          }}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
