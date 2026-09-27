// The Accounts section (spec US1, US2; plan L-ACC): the Sepolia holdings of the connected wallet,
// and its Passport account: open one (one signature, with the relay's stages and queue position),
// or, when this browser does not hold it, the way back through Import. Balances come from the
// coins this browser keeps, rebuilt from chain data by an inbox walk decrypted here.
//
// Plain layout for now: the MN Bank design (P1.5) restyles it once the mockup is approved.

import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';

import {
  formatUnits,
  holdingsByColour,
  parseUnits,
  type JobView,
  type NetworkProfile,
  type StoredCoin,
  type TokenRegistry,
} from '@mnbank/core';

import { readSepoliaHoldings, walletRpc, type SepoliaHoldings } from '../evm/balances.js';
import { useValuation } from '../markets/valuation.js';
import {
  openAccount,
  recipientOf,
  secureChange,
  syncAccount,
  unsecuredCoins,
  withdrawToWallet,
  type OperationEnv,
} from '../passport/operations.js';
import { findAccount, listJobs, readCoins, readSecret } from '../passport/records.js';
import { RelayClient } from '../relay/client.js';
import { useStore } from '../store/StoreContext.js';
import { useWallet } from '../wallet/WalletContext.js';

const short = (s: string, head = 8, tail = 6) =>
  s.length <= head + tail + 1 ? s : `${s.slice(0, head)}…${s.slice(-tail)}`;

const STAGE_TEXT: Record<string, string> = {
  queued: 'Waiting in line',
  running: 'Started',
  deploying: 'Creating your account',
  'wave-1-submitted': 'Account created (step 1 of 2)',
  'wave-2-submitted': 'Account features added (step 2 of 2)',
  deployed: 'Account created',
  activating: 'Activating your wallet as the account key',
  'activation-submitted': 'Activation sent',
  activated: 'Activated',
  proving: 'Preparing the transaction proof',
  submitted: 'Sent to the network',
  succeeded: 'Done',
  failed: 'Failed',
};

function JobTracker({ job }: { job: JobView }) {
  return (
    <div className="tracker" data-testid="job-tracker" data-state={job.state} data-stage={job.stage}>
      <p>
        <strong>{STAGE_TEXT[job.stage] ?? job.stage}</strong>
        {job.state === 'queued' && job.position !== undefined && (
          <span data-testid="queue-position"> — position {job.position} in the queue</span>
        )}
      </p>
      <ol>
        {job.stages.map((s, i) => (
          <li key={`${s.stage}-${i}`} data-testid="job-stage" data-stage={s.stage}>
            {STAGE_TEXT[s.stage] ?? s.stage}
            {s.detail?.tx && (
              <span className="mono" title={s.detail.tx}>
                {' '}
                tx {short(s.detail.tx)}
              </span>
            )}
          </li>
        ))}
      </ol>
      {job.error && (
        <p role="alert" className="notice error" data-testid="job-error">
          {job.error.message}
        </p>
      )}
    </div>
  );
}

function SepoliaSection({ tokens }: { tokens: TokenRegistry | null }) {
  const wallet = useWallet();
  const [holdings, setHoldings] = useState<SepoliaHoldings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const provider = wallet.provider;
  const address = wallet.address;

  const refresh = useCallback(async () => {
    if (!provider || !address) return;
    setError(null);
    try {
      setHoldings(await readSepoliaHoldings(walletRpc(provider), address, tokens?.tokens ?? [], 'wallet'));
    } catch {
      setError('Your wallet could not read Sepolia balances right now.');
    }
  }, [provider, address, tokens]);

  useEffect(() => {
    if (!wallet.onRightChain) return;
    const t = setTimeout(() => void refresh(), 0);
    return () => clearTimeout(t);
  }, [refresh, wallet.onRightChain]);

  return (
    <section aria-labelledby="sepolia-title" data-testid="sepolia-holdings">
      <h3 id="sepolia-title">Sepolia holdings</h3>
      {error && (
        <p role="alert" className="notice error">
          {error}
        </p>
      )}
      <table>
        <thead>
          <tr>
            <th>Token</th>
            <th>Contract</th>
            <th className="num">Balance</th>
          </tr>
        </thead>
        <tbody>
          <tr data-testid="sepolia-row" data-symbol="ETH">
            <td>ETH</td>
            <td>Sepolia ether</td>
            <td className="num" data-testid="sepolia-balance">
              {holdings ? formatUnits(holdings.eth, 18, { maxFractionDigits: 6 }) : '—'}
            </td>
          </tr>
          {(tokens?.tokens ?? [])
            .filter((t) => t.sepoliaAddress !== '')
            .map((t) => {
              const b = holdings?.tokens.find((x) => x.token.symbol === t.symbol)?.balance;
              return (
                <tr key={t.symbol} data-testid="sepolia-row" data-symbol={t.symbol}>
                  <td>{t.symbol}</td>
                  <td className="mono" title={t.sepoliaAddress}>
                    {short(t.sepoliaAddress, 6, 4)}
                  </td>
                  <td className="num" data-testid="sepolia-balance">
                    {b === undefined || b === null ? '—' : formatUnits(b, t.decimals, { minFractionDigits: 2 })}
                  </td>
                </tr>
              );
            })}
        </tbody>
      </table>
      <button type="button" data-testid="sepolia-refresh" onClick={() => void refresh()}>
        Refresh
      </button>
    </section>
  );
}

function PassportHoldings({ coins, tokens }: { coins: StoredCoin[]; tokens: TokenRegistry | null }) {
  const value = useValuation();
  const rows = holdingsByColour(coins).map((h) => ({
    h,
    token: tokens?.byColour(h.color),
    v: value(h.color, h.total),
  }));
  const totalUsdc = rows.reduce((n, r) => (r.v.kind === 'usdc' || r.v.kind === 'priced' ? n + r.v.usdcRaw : n), 0n);
  const leftOut = rows.filter((r) => r.v.kind !== 'usdc' && r.v.kind !== 'priced').length;
  const usdc = tokens?.usdc();
  return (
    <table data-testid="passport-holdings">
      <thead>
        <tr>
          <th>Token</th>
          <th className="num">Amount</th>
          <th className="num">Largest single payment</th>
          <th className="num">Value (USDC)</th>
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 && (
          <tr>
            <td colSpan={4} data-testid="passport-empty">
              No tokens in this account yet.
            </td>
          </tr>
        )}
        {rows.map(({ h, token: t, v }) => {
          const dec = t?.decimals ?? 0;
          return (
            <tr key={h.color} data-testid="passport-row" data-colour={h.color} data-name={t?.midnightName ?? ''}>
              <td>
                {t?.midnightName ?? short(h.color)}
                {t?.sepoliaAddress ? <small> bridged from Sepolia {short(t.sepoliaAddress, 6, 4)}</small> : null}
              </td>
              <td className="num" data-testid="passport-amount" data-raw={h.total.toString()}>
                {formatUnits(h.total, dec, { minFractionDigits: 2 })}
              </td>
              <td className="num" data-testid="passport-largest" data-raw={h.largest.toString()}>
                {formatUnits(h.largest, dec, { minFractionDigits: 2 })}
              </td>
              <td className="num" data-testid="passport-value">
                {v.kind === 'usdc' || v.kind === 'priced'
                  ? formatUnits(v.usdcRaw, usdc?.decimals ?? 6, { minFractionDigits: 2 })
                  : v.kind === 'no-liquidity'
                    ? 'no liquidity'
                    : 'price not available'}
              </td>
            </tr>
          );
        })}
      </tbody>
      {rows.length > 0 && (
        <tfoot>
          <tr>
            <td colSpan={3}>
              Total in USDC{leftOut > 0 ? ` (leaves out ${leftOut} token${leftOut > 1 ? 's' : ''} with no price)` : ''}
            </td>
            <td className="num" data-testid="passport-total">
              {formatUnits(totalUsdc, usdc?.decimals ?? 6, { minFractionDigits: 2 })}
            </td>
          </tr>
        </tfoot>
      )}
    </table>
  );
}

function SendForm({
  coins,
  tokens,
  network,
  onSend,
  busy,
}: {
  coins: StoredCoin[];
  tokens: TokenRegistry | null;
  network: string;
  onSend: (color: string, amount: bigint, recipient: string) => void;
  busy: boolean;
}) {
  const held = holdingsByColour(coins);
  const [color, setColor] = useState('');
  const [amount, setAmount] = useState('');
  const [recipient, setRecipient] = useState('');
  const [error, setError] = useState<string | null>(null);
  const chosen = color || held[0]?.color || '';
  const token = tokens?.byColour(chosen);
  const largest = held.find((h) => h.color === chosen)?.largest ?? 0n;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      const raw = parseUnits(amount, token?.decimals ?? 0);
      if (raw > largest) {
        setError(
          `The largest single payment is ${formatUnits(largest, token?.decimals ?? 0)}: the account pays from one coin at a time.`,
        );
        return;
      }
      recipientOf(recipient, network); // throws a readable message for a bad address
      onSend(chosen, raw, recipient.trim());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Enter an amount.');
    }
  };
  if (held.length === 0) return null;
  return (
    <details data-testid="send-midnight">
      <summary>Send to a Midnight wallet (advanced)</summary>
      <form onSubmit={submit}>
        <label>
          Token{' '}
          <select value={chosen} onChange={(e) => setColor(e.target.value)} data-testid="send-token">
            {held.map((h) => (
              <option key={h.color} value={h.color}>
                {tokens?.byColour(h.color)?.midnightName ?? short(h.color)}
              </option>
            ))}
          </select>
        </label>
        <label>
          Amount{' '}
          <input
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            inputMode="decimal"
            data-testid="send-amount"
          />
        </label>
        <small data-testid="send-largest">Largest single payment: {formatUnits(largest, token?.decimals ?? 0)}</small>
        <label>
          Recipient (shielded wallet address, mn_shield-addr_…){' '}
          <input value={recipient} onChange={(e) => setRecipient(e.target.value)} data-testid="send-recipient" />
        </label>
        <p>
          You sign once to send. The change stays in your account; the bank then asks for a second signature to record
          it in your account&apos;s inbox, so it can be restored from the chain.
        </p>
        {error && (
          <p role="alert" className="notice error" data-testid="send-error">
            {error}
          </p>
        )}
        <button type="submit" disabled={busy} data-testid="send-submit">
          Send
        </button>
      </form>
    </details>
  );
}

export function Accounts({
  network,
  relayUrl,
  tokens,
}: {
  network: NetworkProfile;
  relayUrl: string;
  tokens: TokenRegistry | null;
}) {
  const { store, revision } = useStore();
  const wallet = useWallet();
  const relay = useMemo(() => new RelayClient(relayUrl), [relayUrl]);
  const [job, setJob] = useState<JobView | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [syncing, setSyncing] = useState(false);

  const evmAddress = wallet.status === 'connected' ? wallet.address : null;
  const scope = useMemo(() => (evmAddress ? { network: network.name, evmAddress } : null), [evmAddress, network.name]);
  // `revision` changes on every store write, here or in another tab: the reads below follow it.
  const account = useMemo(
    () => (store && scope ? findAccount(store, scope) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [store, scope, revision],
  );
  const hasSecret = !!(store && scope && account && readSecret(store, scope, account.address));
  const coins = useMemo(
    () => (store && scope && account ? readCoins(store, scope, account.address) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [store, scope, account, revision],
  );
  const pendingJobs = useMemo(
    () => (store && scope ? listJobs(store, scope) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [store, scope, revision],
  );

  const env = useCallback((): OperationEnv | null => {
    if (!store || !scope || !wallet.provider || !wallet.address) return null;
    return {
      relay,
      store,
      scope,
      provider: wallet.provider,
      owner: wallet.address,
      chainId: network.evm.chainId,
      onJob: setJob,
    };
  }, [store, scope, wallet.provider, wallet.address, relay, network]);

  const sync = useCallback(async () => {
    const e = env();
    if (!e || !account || !hasSecret) return;
    setSyncing(true);
    try {
      await syncAccount(e, account.address);
    } catch (err) {
      setMessage({ kind: 'error', text: err instanceof Error ? err.message : 'The balances could not be refreshed.' });
    } finally {
      setSyncing(false);
    }
  }, [env, account, hasSecret]);

  // Walk the inbox whenever the account (or this wallet) changes. Deferred, so no state is set
  // during the effect itself.
  const accountAddress = account?.address;
  useEffect(() => {
    if (!accountAddress) return;
    const t = setTimeout(() => void sync(), 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountAddress, evmAddress]);

  const run = async (label: string, fn: (e: OperationEnv) => Promise<void>) => {
    const e = env();
    if (!e) return;
    setBusy(label);
    setMessage(null);
    setJob(null);
    try {
      await fn(e);
    } catch (err) {
      setMessage({ kind: 'error', text: err instanceof Error ? err.message : 'Something went wrong.' });
    } finally {
      setBusy(null);
    }
  };

  const open = () =>
    run('register', async (e) => {
      const rec = await openAccount(e, network.bridge.vaultAddress);
      setMessage({ kind: 'ok', text: `Your account ${short(rec.address)} is open.` });
    });

  const send = (color: string, amount: bigint, recipient: string) =>
    run('withdraw', async (e) => {
      if (!account) return;
      const r = await withdrawToWallet(e, account.address, { color, amount, recipient });
      setMessage({ kind: 'ok', text: `Sent (tx ${short(r.txId)}). Recording the change in your inbox…` });
      await syncAccount(e, account.address);
      // Q13 default A: file the change's inbox entry right away (a second signature).
      if (r.change) {
        await secureChange(e, account.address, r.change);
        await syncAccount(e, account.address);
        setMessage({ kind: 'ok', text: `Sent (tx ${short(r.txId)}); the change is recorded in your inbox.` });
      }
    });

  const secure = (coin: StoredCoin) =>
    run('append-inbox', async (e) => {
      if (!account) return;
      await secureChange(e, account.address, coin);
      await syncAccount(e, account.address);
      setMessage({ kind: 'ok', text: 'The coin is recorded in your inbox.' });
    });

  if (wallet.status !== 'connected' || !scope) {
    return (
      <section data-testid="section-accounts">
        <h2>Accounts</h2>
        <p>Connect your wallet to see your holdings and your MN Bank account.</p>
      </section>
    );
  }

  const registering = pendingJobs.find((j) => j.job.action === 'register' && j.account === null);
  const unsecured = unsecuredCoins(coins);

  return (
    <section data-testid="section-accounts">
      <h2>Accounts</h2>
      {message && (
        <p
          role={message.kind === 'error' ? 'alert' : 'status'}
          className={`notice ${message.kind}`}
          data-testid="accounts-message"
        >
          {message.text}
        </p>
      )}
      <SepoliaSection tokens={tokens} />

      <section aria-labelledby="passport-title" data-testid="passport-section">
        <h3 id="passport-title">MN Bank account</h3>
        {!account && (
          <div data-testid="no-account">
            <p>This wallet has no MN Bank account in this browser.</p>
            <p>
              Opened one on another computer or browser? <a href="#local">Import your export on Local data</a> to use it
              here. Opening a new account below creates a second, separate account.
            </p>
            {!wallet.onRightChain && <p className="notice">Switch your wallet to Sepolia first.</p>}
            <button
              type="button"
              data-testid="open-account"
              disabled={!!busy || !wallet.onRightChain || !store || store.readOnly}
              onClick={() => void open()}
            >
              {registering || busy === 'register' ? 'Opening your account…' : 'Open account'}
            </button>
            <p>
              <small>You sign once. The bank pays every network fee; you need no Midnight wallet.</small>
            </p>
          </div>
        )}
        {account && !hasSecret && (
          <p role="alert" className="notice error" data-testid="account-not-found">
            This browser does not hold this account&apos;s key. Import your export on <a href="#local">Local data</a>.
          </p>
        )}
        {account && (
          <div data-testid="account" data-account={account.address}>
            <p>
              Account{' '}
              <span className="mono" data-testid="account-address">
                {account.address}
              </span>
              <br />
              <small>Key: your wallet {short(account.device, 6, 4)}</small>
            </p>
            <button
              type="button"
              data-testid="refresh-balances"
              disabled={syncing || !!busy}
              onClick={() => void sync()}
            >
              {syncing ? 'Refreshing…' : 'Refresh balances'}
            </button>
            <PassportHoldings coins={coins} tokens={tokens} />
            {unsecured.length > 0 && (
              <div data-testid="pending-items">
                <h4>Pending</h4>
                <ul>
                  {unsecured.map((c) => (
                    <li key={c.commitment} data-testid="unsecured-coin">
                      {formatUnits(BigInt(c.value), tokens?.byColour(c.color)?.decimals ?? 0)}{' '}
                      {tokens?.byColour(c.color)?.midnightName ?? short(c.color)} — change not yet recorded in your
                      inbox{' '}
                      <button
                        type="button"
                        disabled={!!busy}
                        onClick={() => void secure(c)}
                        data-testid="secure-change"
                      >
                        Record it now
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <SendForm
              coins={coins}
              tokens={tokens}
              network={network.name}
              onSend={(c, a, r) => void send(c, a, r)}
              busy={!!busy}
            />
          </div>
        )}
        {job && <JobTracker job={job} />}
      </section>
    </section>
  );
}
