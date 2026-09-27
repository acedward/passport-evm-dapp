// Numbered steps for a flow the customer drives in order (fund the deposit address, then start).
//
//   <Steps>
//     <Step title="Send tokens with wallet" done={tokensThere}>
//       <p>Your wallet asks you to approve the transfer.</p>
//       <Button …>Send 50.00 stkB</Button>
//     </Step>
//     <Step title="Start deposit">…</Step>
//   </Steps>

import type { HTMLAttributes, ReactNode } from 'react';

import { cx } from './format.js';

export function Steps({ className, ...rest }: HTMLAttributes<HTMLOListElement>) {
  return <ol className={cx('steps', className)} {...rest} />;
}

export function Step({
  title,
  done = false,
  className,
  children,
  ...rest
}: Omit<HTMLAttributes<HTMLLIElement>, 'title'> & { title: ReactNode; done?: boolean }) {
  return (
    <li className={cx(done && 'done', className)} {...rest}>
      <strong className="step-title">
        {title}
        {done ? <span className="sr-only"> (done)</span> : null}
      </strong>
      {children ? <div className="step-body">{children}</div> : null}
    </li>
  );
}
