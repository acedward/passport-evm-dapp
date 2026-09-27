// The application shell: the MN Bank masthead (brand, the connected wallet with its Sepolia
// badge, the Passport account with its "Midnight stagenet" badge), the tab bar, the five
// sections and the testnet footer, in the owner-approved design (plan P1.5, Q16 A). The pieces
// come from ./design; this file only wires them to the wallet and the store. Trade arrives with
// its lane (L-TRD).

import { useEffect, useMemo, useState } from 'react';

import type { NetworkProfile } from '@mnbank/core';

import { TransfersProvider } from './bridge/TransfersContext.js';
import { loadSiteConfig, type SiteConfig } from './config.js';
import {
  Button,
  EmptyState,
  IdentityChip,
  Masthead,
  NetworkBadge,
  Notice,
  PageHead,
  SiteFooter,
  TabNav,
  shortHex,
} from './design/index.js';
import { MarketProvider } from './market/MarketContext.js';
import { Accounts } from './pages/Accounts.js';
import { LocalData } from './pages/LocalData.js';
import { Markets } from './pages/Markets.js';
import { Transfers } from './pages/Transfers.js';
import { findAccount } from './passport/records.js';
import { StoreProvider, useStore } from './store/StoreContext.js';
import { WalletProvider, useWallet } from './wallet/WalletContext.js';

export const SECTIONS = [
  { id: 'accounts', label: 'Accounts' },
  { id: 'markets', label: 'Markets' },
  { id: 'transfers', label: 'Transfers' },
  { id: 'trade', label: 'Trade' },
  { id: 'local', label: 'Local data' },
] as const;
type SectionId = (typeof SECTIONS)[number]['id'];

const sectionFromHash = (): SectionId => {
  const h = window.location.hash.replace(/^#/, '');
  return (SECTIONS.find((s) => s.id === h)?.id ?? 'accounts') as SectionId;
};

/** The right-hand side of the masthead: who is connected, on which networks. */
function Identity({ network }: { network: NetworkProfile }) {
  const w = useWallet();
  const { store, revision } = useStore();
  const [choosing, setChoosing] = useState(false);
  // The Passport account this wallet has in this browser (read-only; `revision` follows writes).
  const account = useMemo(
    () =>
      store && w.status === 'connected' && w.address
        ? findAccount(store, { network: network.name, evmAddress: w.address })
        : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [store, w.status, w.address, network.name, revision],
  );
  const midnight = (
    <NetworkBadge network="midnight" data-testid="network-name">
      Midnight {network.name}
    </NetworkBadge>
  );

  if (w.status === 'connected' && w.address) {
    return (
      <>
        <IdentityChip
          label="Wallet"
          data-testid="wallet-connected"
          value={
            <span className="id-value" data-testid="wallet-address" title={w.address}>
              {shortHex(w.address)}
            </span>
          }
          badge={
            w.onRightChain ? (
              <NetworkBadge network="sepolia" data-testid="wallet-chain">
                {network.evm.chainName}
              </NetworkBadge>
            ) : (
              <Button
                variant="inverse"
                size="small"
                data-testid="switch-network"
                onClick={() => void w.switchNetwork()}
              >
                Switch to {network.evm.chainName}
              </Button>
            )
          }
        >
          <Button variant="link" onClick={w.disconnect}>
            Disconnect
          </Button>
        </IdentityChip>
        <IdentityChip
          label="Passport account"
          value={
            account ? (
              <span className="id-value" title={account.address} data-testid="masthead-account">
                {shortHex(account.address, 4, 4)}
              </span>
            ) : (
              <span className="id-none">none in this browser</span>
            )
          }
          badge={midnight}
        />
      </>
    );
  }
  return (
    <>
      <IdentityChip label="Network" badge={midnight} />
      <div className="wallet-area">
        <Button
          variant="inverse"
          data-testid="connect"
          aria-expanded={choosing}
          aria-haspopup="menu"
          disabled={w.status === 'connecting'}
          onClick={() => setChoosing((c) => !c)}
        >
          {w.status === 'connecting' ? 'Connecting…' : 'Connect wallet'}
        </Button>
        {choosing && (
          <div className="wallet-menu" role="menu" aria-label="Choose a wallet" data-testid="wallet-menu">
            {w.options.length === 0 ? (
              <p className="small">
                No wallet found in this browser. Install MetaMask or another EVM wallet, then reload.
              </p>
            ) : (
              <>
                <p className="wallet-menu-title">Choose a wallet</p>
                {w.options.map((o) => (
                  <Button
                    variant="secondary"
                    role="menuitem"
                    key={o.id}
                    data-testid="wallet-option"
                    onClick={() => {
                      setChoosing(false);
                      void w.connect(o);
                    }}
                  >
                    {o.icon && <img src={o.icon} alt="" width={20} height={20} />} {o.name}
                  </Button>
                ))}
              </>
            )}
          </div>
        )}
      </div>
    </>
  );
}

/** Remember that this wallet has used the bank on this network (its first record here). */
function ProfileRecorder({ network }: { network: string }) {
  const { store } = useStore();
  const { address, status } = useWallet();
  useEffect(() => {
    if (!store || store.readOnly || status !== 'connected' || !address) return;
    const scope = { network, evmAddress: address };
    const existing = store
      .list(scope)
      .find((r) => r.parsed.kind === 'profile' && !r.parsed.scope.global && r.parsed.scope.account === null);
    const firstSeen = (existing?.record?.data as { firstSeen?: number } | undefined)?.firstSeen ?? Date.now();
    store.put(scope, 'profile', { firstSeen, lastSeen: Date.now() });
  }, [store, address, status, network]);
  return null;
}

function Shell({ network, config }: { network: NetworkProfile; config: SiteConfig }) {
  const [section, setSection] = useState<SectionId>(sectionFromHash);
  useEffect(() => {
    const on = () => setSection(sectionFromHash());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  const { status } = useStore();
  const wallet = useWallet();
  const pending = SECTIONS.find((s) => s.id === section)?.label ?? '';
  return (
    <div className="app">
      <Masthead>
        <Identity network={network} />
      </Masthead>
      <TabNav items={SECTIONS} current={section} />
      {(status !== 'ok' || wallet.error) && (
        <div className="wrap app-banner">
          {status !== 'ok' && (
            <Notice tone="danger" role="alert" data-testid="storage-banner">
              This browser is not letting MN Bank keep data, so you cannot open or use an account here.
            </Notice>
          )}
          {wallet.error && (
            <Notice tone="danger" role="alert" data-testid="wallet-error">
              {wallet.error}
            </Notice>
          )}
        </div>
      )}
      <main className="wrap">
        {section === 'local' ? (
          <LocalData network={network.name} />
        ) : section === 'accounts' ? (
          <Accounts network={network} relayUrl={config.relayUrl} />
        ) : section === 'markets' ? (
          <Markets />
        ) : section === 'transfers' ? (
          <Transfers network={network} />
        ) : (
          <section data-testid={`section-${section}`}>
            <PageHead title={pending} />
            <EmptyState title="Coming soon">
              This section is being built. Your records are under <a href="#local">Local data</a>.
            </EmptyState>
          </section>
        )}
      </main>
      <SiteFooter networkName={`Midnight ${network.name}`} evmName={`Ethereum ${network.evm.chainName}`} />
      <ProfileRecorder network={network.name} />
    </div>
  );
}

export function App() {
  const [config, setConfig] = useState<SiteConfig | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    loadSiteConfig().then(setConfig, (e: unknown) => setFailed(e instanceof Error ? e.message : 'configuration error'));
  }, []);
  if (failed)
    return (
      <div className="wrap app-banner">
        <Notice tone="danger" role="alert">
          MN Bank could not start: {failed}
        </Notice>
      </div>
    );
  if (!config)
    return (
      <p className="wrap app-banner muted" role="status">
        Loading…
      </p>
    );
  return (
    <StoreProvider>
      <WalletProvider network={config.network}>
        <MarketProvider network={config.network} tokens={config.tokens}>
          <TransfersProvider network={config.network} relayUrl={config.relayUrl}>
            <Shell network={config.network} config={config} />
          </TransfersProvider>
        </MarketProvider>
      </WalletProvider>
    </StoreProvider>
  );
}
