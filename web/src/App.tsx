// The application shell: brand, wallet connection and the five sections. The layout and styling
// are deliberately plain; the MN Bank design (P1.5) replaces them once the owner approves the
// mockup (question Q16). Local data and Markets are complete; the other three arrive with the lanes.

import { useEffect, useState } from 'react';

import type { NetworkProfile } from '@mnbank/core';

import { loadSiteConfig, type SiteConfig } from './config.js';
import { MarketProvider } from './market/MarketContext.js';
import { LocalData } from './pages/LocalData.js';
import { Markets } from './pages/Markets.js';
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

function WalletArea() {
  const w = useWallet();
  const [choosing, setChoosing] = useState(false);
  if (w.status === 'connected' && w.address) {
    return (
      <div className="wallet" data-testid="wallet-connected">
        <span data-testid="wallet-address" title={w.address}>
          {w.address.slice(0, 6)}…{w.address.slice(-4)}
        </span>
        {w.onRightChain ? (
          <span className="badge" data-testid="wallet-chain">
            Sepolia
          </span>
        ) : (
          <button type="button" data-testid="switch-network" onClick={() => void w.switchNetwork()}>
            Switch to Sepolia
          </button>
        )}
        <button type="button" className="link" onClick={w.disconnect}>
          Disconnect
        </button>
      </div>
    );
  }
  return (
    <div className="wallet">
      <button
        type="button"
        data-testid="connect"
        disabled={w.status === 'connecting'}
        onClick={() => setChoosing((c) => !c)}
      >
        {w.status === 'connecting' ? 'Connecting…' : 'Connect wallet'}
      </button>
      {choosing && (
        <div className="menu" role="menu" data-testid="wallet-menu">
          {w.options.length === 0 ? (
            <p>No wallet found in this browser. Install MetaMask or another EVM wallet, then reload.</p>
          ) : (
            w.options.map((o) => (
              <button
                type="button"
                role="menuitem"
                key={o.id}
                data-testid="wallet-option"
                onClick={() => {
                  setChoosing(false);
                  void w.connect(o);
                }}
              >
                {o.icon && <img src={o.icon} alt="" width={20} height={20} />} {o.name}
              </button>
            ))
          )}
        </div>
      )}
      {w.error && (
        <p role="alert" className="notice error" data-testid="wallet-error">
          {w.error}
        </p>
      )}
    </div>
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

function Shell({ network }: { network: NetworkProfile }) {
  const [section, setSection] = useState<SectionId>(sectionFromHash);
  useEffect(() => {
    const on = () => setSection(sectionFromHash());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  const { status } = useStore();
  return (
    <>
      <header className="masthead">
        <div>
          <h1>MN Bank</h1>
          <span className="network" data-testid="network-name">
            Midnight {network.name} · {network.evm.chainName}
          </span>
        </div>
        <WalletArea />
      </header>
      {status !== 'ok' && (
        <div role="alert" className="notice error" data-testid="storage-banner">
          This browser is not letting MN Bank keep data, so you cannot open or use an account here.
        </div>
      )}
      <nav aria-label="Sections">
        {SECTIONS.map((s) => (
          <a
            key={s.id}
            href={`#${s.id}`}
            aria-current={section === s.id ? 'page' : undefined}
            data-testid={`tab-${s.id}`}
          >
            {s.label}
          </a>
        ))}
      </nav>
      <main>
        {section === 'local' ? (
          <LocalData network={network.name} />
        ) : section === 'markets' ? (
          <Markets />
        ) : (
          <section data-testid={`section-${section}`}>
            <h2>{SECTIONS.find((s) => s.id === section)?.label}</h2>
            <p>This section is being built. Your records are under Local data.</p>
          </section>
        )}
      </main>
      <ProfileRecorder network={network.name} />
    </>
  );
}

export function App() {
  const [config, setConfig] = useState<SiteConfig | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    loadSiteConfig().then(setConfig, (e: unknown) => setFailed(e instanceof Error ? e.message : 'configuration error'));
  }, []);
  if (failed) return <p role="alert">MN Bank could not start: {failed}</p>;
  if (!config) return <p>Loading…</p>;
  return (
    <StoreProvider>
      <WalletProvider network={config.network}>
        <MarketProvider network={config.network} tokens={config.tokens}>
          <Shell network={config.network} />
        </MarketProvider>
      </WalletProvider>
    </StoreProvider>
  );
}
