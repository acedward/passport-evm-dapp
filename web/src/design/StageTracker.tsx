// The vertical stage tracker for long jobs (opening an account, a bridge transfer): done stages
// in navy with a tick, the current one ringed in gold, the rest waiting in grey.
//
//   <StageTracker label="Deposit 25.00 stkA" stages={[
//     { key: 'sent', title: 'Tokens sent', state: 'done', time: '14:06',
//       detail: <>25.00 stkA <Hash value={tx} /></> },
//     { key: 'final', title: 'Sepolia finality', state: 'current', detail: 'about 12 min' },
//     { key: 'done', title: 'Completed', state: 'pending' },
//   ]} />
//
// <Hash value="0x63bd…606f full hash" /> shows a shortened hash with a Copy action (and a link
// when `href` is given); the full value stays in `title` and `data-value`.

import { useEffect, useState, type HTMLAttributes, type ReactNode } from 'react';

import { copyText } from './Field.js';
import { cx, shortHex } from './format.js';

export type StageState = 'done' | 'current' | 'pending' | 'failed';

export interface TrackerStage {
  key: string;
  title: ReactNode;
  state: StageState;
  time?: ReactNode;
  detail?: ReactNode;
  /** Extra attributes for the stage's <li>: `{ testid: 'job-stage', stage: 'proving' }` gives
   *  data-testid="job-stage" data-stage="proving". */
  data?: Readonly<Record<string, string>>;
}

const dataAttrs = (data: Readonly<Record<string, string>> | undefined) =>
  Object.fromEntries(Object.entries(data ?? {}).map(([k, v]) => [`data-${k}`, v]));

function Tick() {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" focusable="false">
      <path d="M3 8.5l3 3 7-7" fill="none" stroke="currentColor" strokeWidth="2.2" />
    </svg>
  );
}
function Cross() {
  return (
    <svg viewBox="0 0 16 16" width="10" height="10" aria-hidden="true" focusable="false">
      <path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" strokeWidth="2.2" />
    </svg>
  );
}

const STATE_WORD: Record<StageState, string> = {
  done: 'done',
  current: 'in progress',
  pending: 'not started',
  failed: 'failed',
};

export function StageTracker({
  stages,
  label,
  className,
  ...rest
}: Omit<HTMLAttributes<HTMLOListElement>, 'children'> & { stages: ReadonlyArray<TrackerStage>; label?: string }) {
  return (
    <ol className={cx('stage-tracker', className)} aria-label={label} {...rest}>
      {stages.map((s) => (
        <li
          key={s.key}
          className={cx('stage', s.state)}
          aria-current={s.state === 'current' ? 'step' : undefined}
          {...dataAttrs(s.data)}
        >
          <span className="marker" aria-hidden="true">
            {s.state === 'done' ? <Tick /> : s.state === 'failed' ? <Cross /> : null}
          </span>
          <div className="head">
            <span className="title">
              {s.title}
              <span className="sr-only"> ({STATE_WORD[s.state]})</span>
            </span>
            {s.time ? <span className="time num">{s.time}</span> : null}
          </div>
          {s.detail ? <div className="detail">{s.detail}</div> : null}
        </li>
      ))}
    </ol>
  );
}

export function Hash({
  value,
  head = 6,
  tail = 4,
  href,
  copy = true,
  className,
  ...rest
}: Omit<HTMLAttributes<HTMLSpanElement>, 'children'> & {
  value: string;
  head?: number;
  tail?: number;
  /** An explorer link for the full value. */
  href?: string;
  copy?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(t);
  }, [copied]);
  const text = shortHex(value, head, tail);
  return (
    <span className={cx('hash', className)} data-value={value} {...rest}>
      {href ? (
        <a className="mono" href={href} title={value} target="_blank" rel="noreferrer noopener">
          {text}
        </a>
      ) : (
        <span className="mono" title={value}>
          {text}
        </span>
      )}
      {copy ? (
        <button
          type="button"
          className="hash-copy"
          aria-label={`Copy ${value}`}
          onClick={() => void copyText(value).then(setCopied)}
        >
          {copied ? 'copied' : 'copy'}
        </button>
      ) : null}
    </span>
  );
}
