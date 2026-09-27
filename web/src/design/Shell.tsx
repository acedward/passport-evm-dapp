// The frame every page sits in: the navy masthead (the "MN" monogram, "MN Bank", "Private
// accounts on Midnight", and the customer's identity on the right), the white tab bar, and the
// testnet footer.
//
//   <Masthead>
//     <IdentityChip label="Wallet" value={<span title={addr}>0x4847…e56b</span>} badge={<NetworkBadge network="sepolia" />} />
//     <IdentityChip label="Passport account" value="e8d3…2d09" badge={<NetworkBadge network="midnight">Midnight stagenet</NetworkBadge>} />
//   </Masthead>
//   <TabNav items={[{ id: 'accounts', label: 'Accounts' }, …]} current="accounts" />
//   <SiteFooter />

import type { HTMLAttributes, ReactNode } from 'react';

import { cx } from './format.js';

export function Masthead({ homeHref = '#accounts', children }: { homeHref?: string; children?: ReactNode }) {
  return (
    <header className="masthead">
      <div className="wrap masthead-inner">
        <h1 className="brand">
          <a href={homeHref}>
            <span className="monogram" aria-hidden="true">
              MN
            </span>
            <span>
              <span className="brand-name">MN Bank</span>{' '}
              <span className="brand-tagline">Private accounts on Midnight</span>
            </span>
          </a>
        </h1>
        {children ? <div className="identity">{children}</div> : null}
      </div>
    </header>
  );
}

export function IdentityChip({
  label,
  value,
  badge,
  className,
  children,
  ...rest
}: Omit<HTMLAttributes<HTMLDivElement>, 'title'> & { label: ReactNode; value?: ReactNode; badge?: ReactNode }) {
  return (
    <div className={cx('id-chip', className)} {...rest}>
      <span className="id-label">{label}</span>
      {value}
      {badge}
      {children}
    </div>
  );
}

export interface TabItem {
  id: string;
  label: ReactNode;
}

export function TabNav({
  items,
  current,
  label = 'Sections',
}: {
  items: ReadonlyArray<TabItem>;
  current: string;
  label?: string;
}) {
  return (
    <nav className="tabs" aria-label={label}>
      <div className="wrap">
        <ul>
          {items.map((t) => (
            <li key={t.id}>
              <a href={`#${t.id}`} aria-current={current === t.id ? 'page' : undefined} data-testid={`tab-${t.id}`}>
                {t.label}
              </a>
            </li>
          ))}
        </ul>
      </div>
    </nav>
  );
}

export function SiteFooter({ networkName = 'Midnight stagenet', evmName = 'Ethereum Sepolia' }) {
  return (
    <footer className="site-foot">
      <div className="wrap">
        <p className="testnet" data-testid="testnet-notice">
          Testnet only — {networkName} and {evmName}. Tokens have no real value.
        </p>
        <p>
          Test tokens are sent by MN Bank on request; there is no faucet. This app never asks for your wallet&apos;s
          seed or private key.
        </p>
      </div>
    </footer>
  );
}
