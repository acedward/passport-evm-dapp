// The Accounts section (spec US1, US2; plan L-ACC): the Sepolia holdings of the connected wallet,
// and its Passport account: open one (one signature, with the relay's stages and queue position),
// or, when this browser does not hold it, the way back through Import. Balances come from the
// coins this browser keeps, rebuilt from chain data by an inbox walk decrypted here.
//
// Laid out as a bank statement (plan P1.5, the approved mockup): summary figures, one ruled
// table per side with a double-ruled subtotal, and a side column with the pending items, the
// job tracker and the "Open your Passport account" card.

import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';

import {
  formatUnits,
  holdingsByColour,
  parseUnits,
  type JobView,
  type NetworkProfile,
  type StoredCoin,
  type TokenEntry,
  type TokenRegistry,
  type Valuation,
} from '@mnbank/core';

import {
  AssetCell,
  Button,
  Card,
  Cell,
  EmptyState,
  Field,
  Figure,
  Figures,
  Hash,
  Money,
  NoValue,
  Notice,
  PageHead,
  Panel,
  PendingItem,
  Select,
  StageTracker,
  StatementTable,
  StatusPill,
  Sub,
  SubtotalRow,
  TextInput,
  UnitInput,
  shortHex,
  tokenDisplayName,
  type Column,
  type TrackerStage,
} from '../design/index.js';
import { useAssetFilter } from '../assets/AssetFilterContext.js';
import { readSepoliaHoldings, walletRpc, type SepoliaHoldings } from '../evm/balances.js';
import { useMarkets, useTokenRegistry } from '../market/MarketContext.js';
import { bidText } from '../market/view.js';
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
import { useBankStatus } from '../relay/BankStatus.js';
import { RelayClient } from '../relay/client.js';
import { storageText } from '../store/messages.js';
import { useStore } from '../store/StoreContext.js';
import { confirmCancelsOffer as confirmOffer, markLiveOffersCancelled } from '../trade/operations.js';
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

const JOB_TITLE: Record<string, string> = {
  register: 'Opening your account',
  withdraw: 'Sending from your account',
  'append-inbox': 'Recording the change in your inbox',
};

/** "14:06" UTC from the relay's Unix seconds. */
const clock = (unixSeconds: number) => new Date(unixSeconds * 1000).toISOString().slice(11, 16);

const HOLDING_COLUMNS: Column[] = [
  { label: 'Asset' },
  { label: 'Quantity', align: 'right' },
  { label: 'Price', sub: 'USDC, best bid', align: 'right' },
  { label: 'Value', sub: 'USDC', align: 'right' },
];

/** Whether a valuation counts towards the USDC totals (stocks at the best bid, USDC at face). */
const counts = (v: Valuation): v is Extract<Valuation, { usdcRaw: bigint }> => v.kind === 'usdc' || v.kind === 'priced';

function PriceCell({ v }: { v: Valuation | null }) {
  let body: ReactNode;
  if (v === null) body = <NoValue>not priced</NoValue>;
  else if (v.kind === 'priced') body = <span className="num">{bidText(v.price)}</span>;
  else if (v.kind === 'usdc')
    body = (
      <span className="num-wrap num">
        1.00<Sub>face value</Sub>
      </span>
    );
  else if (v.kind === 'no-liquidity') body = <NoValue>no liquidity</NoValue>;
  else if (v.kind === 'unavailable') body = <NoValue>price not available</NoValue>;
  else body = <NoValue>not priced</NoValue>;
  return (
    <Cell label="Price" align="right">
      {body}
    </Cell>
  );
}

function JobTracker({ job }: { job: JobView }) {
  const last = job.stages.length - 1;
  const stages: TrackerStage[] = job.stages.map((s, i) => ({
    key: `${s.stage}-${i}`,
    title: STAGE_TEXT[s.stage] ?? s.stage,
    state: i < last || job.state === 'succeeded' ? 'done' : job.state === 'failed' ? 'failed' : 'current',
    time: <span title={new Date(s.at * 1000).toISOString()}>{clock(s.at)}</span>,
    detail: s.detail?.tx ? (
      <>
        tx <Hash value={s.detail.tx} head={8} tail={6} />
      </>
    ) : undefined,
    data: { testid: 'job-stage', stage: s.stage },
  }));
  return (
    <Panel
      title={JOB_TITLE[job.action] ?? 'Bank job'}
      data-testid="job-tracker"
      data-state={job.state}
      data-stage={job.stage}
      meta={
        <StatusPill
          status={
            job.state === 'succeeded'
              ? 'done'
              : job.state === 'failed'
                ? 'failed'
                : job.state === 'queued'
                  ? 'idle'
                  : 'progress'
          }
        >
          {job.state === 'succeeded'
            ? 'Done'
            : job.state === 'failed'
              ? 'Failed'
              : job.state === 'queued'
                ? 'Queued'
                : 'In progress'}
        </StatusPill>
      }
    >
      <p className="tracker-summary">
        <strong>{STAGE_TEXT[job.stage] ?? job.stage}</strong>
        {job.state === 'queued' && job.position !== undefined && (
          <span data-testid="queue-position"> — position {job.position} in the queue</span>
        )}
        <br />
        <span className="muted">Safe to leave this page open; the bank does the work.</span>
      </p>
      <StageTracker stages={stages} label="Progress" />
      {job.error && (
        <Notice tone="danger" role="alert" data-testid="job-error">
          {job.error.message}
        </Notice>
      )}
    </Panel>
  );
}

/** The connected wallet's Sepolia balances, read through its own provider. */
function useSepoliaHoldings(tokens: TokenRegistry | null) {
  const wallet = useWallet();
  // Keyed by address: another wallet's numbers are never shown, even for a moment.
  const [read, setRead] = useState<{ address: string; holdings: SepoliaHoldings } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const provider = wallet.provider;
  const address = wallet.address;

  const refresh = useCallback(async () => {
    if (!provider || !address) return;
    setError(null);
    try {
      const holdings = await readSepoliaHoldings(walletRpc(provider), address, tokens?.tokens ?? [], 'wallet');
      setRead({ address, holdings });
    } catch {
      setError('Your wallet could not read Sepolia balances right now.');
    }
  }, [provider, address, tokens]);

  useEffect(() => {
    if (!wallet.onRightChain) return;
    const t = setTimeout(() => void refresh(), 0);
    return () => clearTimeout(t);
  }, [refresh, wallet.onRightChain]);

  return { holdings: read && read.address === address ? read.holdings : null, error, refresh };
}

interface Valued {
  token: TokenEntry;
  balance: bigint | null | undefined;
  v: Valuation | null;
}

type ValueFn = (colour: string, amountRaw: bigint) => Valuation;

/** Sepolia rows valued with the same hook as the Passport holdings (a stkA is priced at the
 *  best bid for wStkA, the token it bridges to); the subtotal leaves out what has no price. Only
 *  the tokens the asset filter shows are listed and counted (plan 00042). */
function sepoliaValuation(
  tokens: TokenRegistry | null,
  holdings: SepoliaHoldings | null,
  value: ValueFn,
  shows: (t: TokenEntry) => boolean,
) {
  const rows: Valued[] = (tokens?.tokens ?? [])
    .filter((t) => t.sepoliaAddress !== '' && shows(t))
    .map((t) => {
      const balance = holdings?.tokens.find((x) => x.token.symbol === t.symbol)?.balance;
      return {
        token: t,
        balance,
        v: balance === undefined || balance === null ? null : value(t.midnightColour, balance),
      };
    });
  const subtotal = holdings ? rows.reduce((n, r) => (r.v !== null && counts(r.v) ? n + r.v.usdcRaw : n), 0n) : null;
  const excluded = rows.filter((r) => r.v !== null && !counts(r.v)).map((r) => r.token.symbol);
  return { rows, subtotal, excluded };
}

function passportValuation(coins: StoredCoin[], tokens: TokenRegistry | null, value: ValueFn) {
  const valued = holdingsByColour(coins).map((h) => ({
    name: tokens?.byColour(h.color)?.midnightName ?? short(h.color),
    v: value(h.color, h.total),
  }));
  return {
    subtotal: valued.reduce((n, r) => (counts(r.v) ? n + r.v.usdcRaw : n), 0n),
    excluded: valued.filter((r) => !counts(r.v)).map((r) => r.name),
  };
}

/** The statement's top strip. Mounted only while a wallet is connected, so a page without a
 *  wallet starts no price feed. */
function SummaryFigures({
  tokens,
  holdings,
  coins,
  hasAccount,
}: {
  tokens: TokenRegistry | null;
  holdings: SepoliaHoldings | null;
  coins: StoredCoin[];
  hasAccount: boolean;
}) {
  const { value } = useMarkets();
  const assets = useAssetFilter();
  const sep = sepoliaValuation(tokens, holdings, value, assets.shows);
  const pass = passportValuation(coins, tokens, value);
  const usdcDec = tokens?.usdc()?.decimals ?? 6;
  // One name per token: a token listed under the same name on both sides (TBILL) is named once.
  const excluded = [...new Set([...sep.excluded, ...(hasAccount ? pass.excluded : [])])];
  return (
    <Figures aria-label="Summary">
      <Figure
        main
        label="Total value, priced holdings"
        value={
          sep.subtotal === null && !hasAccount ? (
            '—'
          ) : (
            <Money raw={(sep.subtotal ?? 0n) + (hasAccount ? pass.subtotal : 0n)} decimals={usdcDec} unit="USDC" />
          )
        }
        note={
          <>
            Holdings other than USDC are valued at the best bid in the live book. Not included: ETH (not priced)
            {excluded.length > 0 ? `, and ${excluded.join(', ')} (no price)` : ''}.
          </>
        }
      />
      <Figure
        label="Ethereum (Sepolia)"
        value={sep.subtotal === null ? '—' : <Money raw={sep.subtotal} decimals={usdcDec} />}
      />
      <Figure
        label="Passport account"
        value={hasAccount ? <Money raw={pass.subtotal} decimals={usdcDec} /> : <NoValue>no account</NoValue>}
      />
    </Figures>
  );
}

function SepoliaSection({
  tokens,
  address,
  holdings,
  error,
  onRefresh,
}: {
  tokens: TokenRegistry | null;
  address: string;
  holdings: SepoliaHoldings | null;
  error: string | null;
  onRefresh(): void;
}) {
  const { value } = useMarkets();
  const assets = useAssetFilter();
  const { rows, subtotal, excluded: leftOut } = sepoliaValuation(tokens, holdings, value, assets.shows);
  const usdcDec = tokens?.usdc()?.decimals ?? 6;
  return (
    <Panel
      title="Ethereum (Sepolia)"
      data-testid="sepolia-holdings"
      meta={
        <>
          <span>
            Wallet <span className="mono">{shortHex(address)}</span>
          </span>
          <Button variant="secondary" size="small" data-testid="sepolia-refresh" onClick={onRefresh}>
            Refresh
          </Button>
        </>
      }
    >
      {error && (
        <Notice tone="danger" role="alert" className="panel-intro">
          {error}
        </Notice>
      )}
      <StatementTable
        columns={HOLDING_COLUMNS}
        caption="Sepolia holdings"
        foot={
          <SubtotalRow
            span={3}
            label="Subtotal, priced holdings"
            note={
              leftOut.length > 0
                ? `Excludes ${leftOut.join(', ')} (no price) and ETH (not priced).`
                : 'Excludes ETH (not priced).'
            }
            valueLabel="USDC"
            valueTestId="sepolia-total"
          >
            {subtotal === null ? '—' : <Money raw={subtotal} decimals={usdcDec} />}
          </SubtotalRow>
        }
      >
        <tr data-testid="sepolia-row" data-symbol="ETH">
          <AssetCell symbol="ETH" name="Sepolia ether" origin="Used for gas" />
          <Cell label="Quantity" align="right" num data-testid="sepolia-balance">
            {holdings ? formatUnits(holdings.eth, 18, { maxFractionDigits: 6 }) : '—'}
          </Cell>
          <Cell label="Price" align="right">
            <NoValue>not priced</NoValue>
          </Cell>
          <Cell label="Value" align="right">
            <NoValue>not valued</NoValue>
          </Cell>
        </tr>
        {rows.map(({ token: t, balance: b, v }) => (
          <tr key={t.symbol} data-testid="sepolia-row" data-symbol={t.symbol}>
            <AssetCell
              symbol={t.symbol}
              name={tokenDisplayName(t)}
              origin={
                <>
                  ERC-20{' '}
                  <span className="mono" title={t.sepoliaAddress}>
                    {short(t.sepoliaAddress, 6, 4)}
                  </span>
                </>
              }
            />
            <Cell label="Quantity" align="right" num data-testid="sepolia-balance">
              {b === undefined || b === null
                ? '—'
                : formatUnits(b, t.decimals, { minFractionDigits: 2, grouping: true })}
            </Cell>
            <PriceCell v={v} />
            <Cell label="Value" align="right">
              {v !== null && counts(v) ? <Money raw={v.usdcRaw} decimals={usdcDec} /> : <NoValue>not valued</NoValue>}
            </Cell>
          </tr>
        ))}
      </StatementTable>
      <p className="table-note">
        Holdings other than USDC are valued at the best bid of the live book; one with no bid is shown but not valued.
        ETH is kept for gas and is not priced.
      </p>
    </Panel>
  );
}

function PassportHoldings({ coins, tokens }: { coins: StoredCoin[]; tokens: TokenRegistry | null }) {
  // Stocks are valued at the best live bid of the offer book (plan L-MKT); USDC at face value.
  const { value } = useMarkets();
  // Listed in the bank's token order (the registry's); unknown colours last.
  const order = (colour: string) => {
    const i = tokens?.tokens.findIndex((t) => t.midnightColour === colour) ?? -1;
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  };
  const rows = holdingsByColour(coins)
    .map((h) => ({
      h,
      token: tokens?.byColour(h.color),
      v: value(h.color, h.total),
    }))
    .sort((a, b) => order(a.h.color) - order(b.h.color));
  const totalUsdc = rows.reduce((n, r) => (r.v.kind === 'usdc' || r.v.kind === 'priced' ? n + r.v.usdcRaw : n), 0n);
  const leftOut = rows.filter((r) => r.v.kind !== 'usdc' && r.v.kind !== 'priced').length;
  const usdc = tokens?.usdc();
  if (rows.length === 0) {
    return (
      <EmptyState data-testid="passport-empty" title="No tokens in this account yet">
        Deposit assets from Sepolia on Transfers; they appear here once they land.
      </EmptyState>
    );
  }
  return (
    <StatementTable
      columns={HOLDING_COLUMNS}
      caption="Passport account holdings"
      data-testid="passport-holdings"
      foot={
        <SubtotalRow
          span={3}
          label="Subtotal, priced holdings"
          note={leftOut > 0 ? `Leaves out ${leftOut} token${leftOut > 1 ? 's' : ''} with no price.` : undefined}
          valueLabel="USDC"
          valueTestId="passport-total"
        >
          {formatUnits(totalUsdc, usdc?.decimals ?? 6, { minFractionDigits: 2, grouping: true })}
        </SubtotalRow>
      }
    >
      {rows.map(({ h, token: t, v }) => {
        const dec = t?.decimals ?? 0;
        return (
          <tr key={h.color} data-testid="passport-row" data-colour={h.color} data-name={t?.midnightName ?? ''}>
            <AssetCell
              symbol={t?.midnightName ?? short(h.color)}
              name={t ? tokenDisplayName(t) : undefined}
              origin={
                t?.sepoliaAddress ? (
                  <>
                    bridged from Sepolia{' '}
                    <span className="mono" title={t.sepoliaAddress}>
                      {short(t.sepoliaAddress, 6, 4)}
                    </span>
                  </>
                ) : undefined
              }
            />
            <Cell label="Quantity" align="right">
              <span className="num-wrap">
                <span className="num" data-testid="passport-amount" data-raw={h.total.toString()}>
                  {formatUnits(h.total, dec, { minFractionDigits: 2, grouping: true })}
                </span>
                <Sub>
                  largest single payment{' '}
                  <span data-testid="passport-largest" data-raw={h.largest.toString()}>
                    {formatUnits(h.largest, dec, { minFractionDigits: 2, grouping: true })}
                  </span>
                </Sub>
              </span>
            </Cell>
            <PriceCell v={v} />
            <Cell label="Value" align="right" num data-testid="passport-value">
              {v.kind === 'usdc' || v.kind === 'priced' ? (
                formatUnits(v.usdcRaw, usdc?.decimals ?? 6, { minFractionDigits: 2, grouping: true })
              ) : (
                <NoValue>not valued</NoValue>
              )}
            </Cell>
          </tr>
        );
      })}
    </StatementTable>
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
    <details className="disclosure" data-testid="send-midnight">
      <summary>Send to a Midnight wallet (advanced)</summary>
      <form className="disclosure-body" onSubmit={submit}>
        <p className="panel-intro small">
          Pays a shielded Midnight wallet straight from your account. To move tokens back to Ethereum, use Transfers.
        </p>
        <div className="form-grid">
          <Field label="Token" htmlFor="send-token">
            <Select id="send-token" value={chosen} onChange={(e) => setColor(e.target.value)} data-testid="send-token">
              {held.map((h) => (
                <option key={h.color} value={h.color}>
                  {tokens?.byColour(h.color)?.midnightName ?? short(h.color)}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label="Amount"
            htmlFor="send-amount"
            hint={
              <span data-testid="send-largest">
                Largest single payment: {formatUnits(largest, token?.decimals ?? 0)}
              </span>
            }
          >
            <UnitInput
              id="send-amount"
              unit={token?.midnightName ?? 'units'}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              inputMode="decimal"
              autoComplete="off"
              data-testid="send-amount"
            />
          </Field>
        </div>
        <Field label="Recipient" htmlFor="send-recipient" hint="A shielded wallet address, mn_shield-addr_…">
          <TextInput
            id="send-recipient"
            className="mono"
            value={recipient}
            onChange={(e) => setRecipient(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            data-testid="send-recipient"
          />
        </Field>
        <p className="small muted panel-intro">
          You sign twice to send: once for the payment, and once to confirm the recipient&apos;s address to the bank.
          The change stays in your account; the bank then asks for one more signature to record it in your
          account&apos;s inbox, so it can be restored from the chain.
        </p>
        {error && (
          <Notice tone="danger" role="alert" data-testid="send-error" className="panel-intro">
            {error}
          </Notice>
        )}
        <Button type="submit" disabled={busy} data-testid="send-submit">
          Send
        </Button>
      </form>
    </details>
  );
}

export function Accounts({ network, relayUrl }: { network: NetworkProfile; relayUrl: string }) {
  // The bank's token list; the price feed starts only where holdings are valued.
  const tokens = useTokenRegistry();
  const { store, revision, status: storageStatus } = useStore();
  const { spendingPaused } = useBankStatus();
  const wallet = useWallet();
  const relay = useMemo(() => new RelayClient(relayUrl), [relayUrl]);
  const [job, setJob] = useState<JobView | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [syncing, setSyncing] = useState(false);
  const sepolia = useSepoliaHoldings(tokens);

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
  // The holdings, totals and Send list show only the assets the filter shows (plan 00042); what
  // needs the customer's action (an unrecorded change coin, under Pending) shows whatever it is.
  const assets = useAssetFilter();
  const shownCoins = useMemo(() => coins.filter((c) => assets.showsColour(c.color)), [coins, assets]);
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

  /** L-TRD.3 (Q9): a signed action cancels the account's live offer; say so and ask first. */
  const confirmCancelsOffer = (action: 'withdraw' | 'append-inbox'): boolean => {
    const e = env();
    if (!e || !account) return false;
    return confirmOffer(e, account.address, action);
  };

  const send = (color: string, amount: bigint, recipient: string) =>
    run('withdraw', async (e) => {
      if (!account) return;
      if (!confirmCancelsOffer('withdraw')) return;
      const r = await withdrawToWallet(e, account.address, { color, amount, recipient });
      markLiveOffersCancelled(e, account.address);
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
      if (!confirmCancelsOffer('append-inbox')) return;
      await secureChange(e, account.address, coin);
      markLiveOffersCancelled(e, account.address);
      await syncAccount(e, account.address);
      setMessage({ kind: 'ok', text: 'The coin is recorded in your inbox.' });
    });

  const lede =
    'Sepolia balances are read from the chain through your wallet; Passport balances come from the coins this browser keeps, checked against your account’s inbox.';

  if (wallet.status !== 'connected' || !scope) {
    return (
      <section data-testid="section-accounts">
        <PageHead eyebrow="Statement" title="Accounts" lede={lede} />
        <EmptyState title="Connect your wallet">
          Connect your wallet to see your holdings and your MN Bank account. Use Connect wallet at the top of the page.
        </EmptyState>
      </section>
    );
  }

  const registering = pendingJobs.find((j) => j.job.action === 'register' && j.account === null);
  const unsecured = unsecuredCoins(coins);

  return (
    <section data-testid="section-accounts">
      <PageHead eyebrow="Statement" title="Accounts" lede={lede} />
      {message && (
        <Notice
          tone={message.kind === 'error' ? 'danger' : 'success'}
          role={message.kind === 'error' ? 'alert' : 'status'}
          className="panel-intro"
          data-testid="accounts-message"
        >
          {message.text}
        </Notice>
      )}

      <SummaryFigures tokens={tokens} holdings={sepolia.holdings} coins={shownCoins} hasAccount={!!account} />

      <div className="accounts-grid">
        <div className="area-stmt stack-gap">
          <SepoliaSection
            tokens={tokens}
            address={scope.evmAddress}
            holdings={sepolia.holdings}
            error={sepolia.error}
            onRefresh={() => void sepolia.refresh()}
          />

          {account && (
            <Panel
              title="Passport account (Midnight)"
              data-testid="passport-section"
              meta={
                <>
                  <span>
                    {shownCoins.filter((c) => !c.spent).length} coin
                    {shownCoins.filter((c) => !c.spent).length === 1 ? '' : 's'}
                  </span>
                  <Button
                    variant="secondary"
                    size="small"
                    data-testid="refresh-balances"
                    disabled={syncing || !!busy}
                    onClick={() => void sync()}
                  >
                    {syncing ? 'Refreshing…' : 'Refresh balances'}
                  </Button>
                </>
              }
            >
              {!hasSecret && (
                <Notice tone="danger" role="alert" className="panel-intro" data-testid="account-not-found">
                  This browser does not hold this account&apos;s key. Import your export on{' '}
                  <a href="#local">Local data</a>.
                </Notice>
              )}
              <div data-testid="account" data-account={account.address}>
                <PassportHoldings coins={shownCoins} tokens={tokens} />
                <p className="table-note">
                  One payment can use only one coin, so the largest single payment can be less than the balance. An
                  asset with no live bid is shown but not valued.
                </p>
                <p className="account-number">
                  Account number{' '}
                  <span className="mono break" data-testid="account-address">
                    {account.address}
                  </span>
                  <br />
                  <span className="xsmall muted">Key: your wallet {short(account.device, 6, 4)}</span>
                </p>
                <SendForm
                  coins={shownCoins}
                  tokens={tokens}
                  network={network.name}
                  onSend={(c, a, r) => void send(c, a, r)}
                  busy={!!busy}
                />
              </div>
            </Panel>
          )}
        </div>

        <div className="area-side stack-gap">
          {account && (
            <Panel tone="quiet" as="aside" title="Pending" data-testid="pending-box">
              <p className="small muted">Not yet in the balances above, or waiting for you.</p>
              {unsecured.length === 0 && !job ? <p className="pending-item small muted">Nothing pending.</p> : null}
              {unsecured.length > 0 && (
                <div data-testid="pending-items">
                  {unsecured.map((c) => (
                    <PendingItem
                      key={c.commitment}
                      data-testid="unsecured-coin"
                      what={
                        <>
                          {formatUnits(BigInt(c.value), tokens?.byColour(c.color)?.decimals ?? 0, {
                            minFractionDigits: 2,
                            grouping: true,
                          })}{' '}
                          {tokens?.byColour(c.color)?.midnightName ?? short(c.color)}
                        </>
                      }
                      state="Change not yet recorded in your inbox."
                      meta="Record it so an export can always restore it from the chain. One signature."
                    >
                      <Button
                        variant="secondary"
                        size="small"
                        disabled={!!busy}
                        onClick={() => void secure(c)}
                        data-testid="secure-change"
                      >
                        Record it now
                      </Button>
                    </PendingItem>
                  ))}
                </div>
              )}
            </Panel>
          )}

          {job && <JobTracker job={job} />}

          {!account && (
            <Card title="Open your Passport account" data-testid="no-account">
              <p className="panel-intro">
                This wallet has no MN Bank account in this browser. Your wallet signs once to open one; the bank pays
                every Midnight fee, and you need no Midnight wallet.
              </p>
              {!wallet.onRightChain && (
                <Notice tone="warning" className="panel-intro">
                  Switch your wallet to Sepolia first.
                </Notice>
              )}
              {storageStatus !== 'ok' && (
                <Notice tone="danger" className="panel-intro" data-testid="open-account-storage">
                  Not here: {storageText(storageStatus).title} Your account&apos;s secret would have nowhere to live.
                </Notice>
              )}
              {spendingPaused && (
                <Notice tone="warning" className="panel-intro" data-testid="open-account-paused">
                  Not now: {spendingPaused}
                </Notice>
              )}
              <Button
                data-testid="open-account"
                disabled={!!busy || !wallet.onRightChain || !store || store.readOnly || !!spendingPaused}
                onClick={() => void open()}
              >
                {registering || busy === 'register' ? 'Opening your account…' : 'Open account'}
              </Button>
              <p className="table-note">
                Opened one on another computer or browser? <a href="#local">Import your data on Local data</a> to use it
                here instead: opening a new account creates a second, separate account.
              </p>
            </Card>
          )}
        </div>
      </div>
    </section>
  );
}
