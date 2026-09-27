// The Transfers section (spec US5, US6; plan L-BRG.1–.3): bridge tokens from Sepolia into the
// account (deposit), out to a Sepolia address (withdrawal), and follow every transfer in flight.
//
// Styled with the MN Bank design system (plan P1.5): the deposit and withdrawal forms side by
// side, the deposit's numbered funding steps, and a stage tracker per transfer with every hash
// shortened and copyable. Presentation only; the flows are lane L-BRG's.

import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';

import {
  DEFAULT_EVM_GAS,
  formatUnits,
  holdingsByColour,
  maxGasCostWei,
  parseUnits,
  type NetworkProfile,
  type TokenEntry,
  type TokenRegistry,
} from '@mnbank/core';

import { useTransfers } from '../bridge/TransfersContext.js';
import { mpcSlow, outcomeText, stageLinks, stageText } from '../bridge/messages.js';
import {
  PreflightError,
  depositAddressOf,
  depositShortfall,
  draftDeposit,
  resumeTransfer,
  secureTransferChange,
  sendDepositGas,
  sendDepositTokens,
  sepoliaBalances,
  startDeposit,
  startWithdraw,
} from '../bridge/operations.js';
import { listTransfers, transferKey, type TransferRecord } from '../bridge/records.js';
import {
  Button,
  ButtonRow,
  CopyField,
  EmptyState,
  Field,
  Hash,
  KeyValueList,
  Notice,
  PageHead,
  Panel,
  Select,
  StageTracker,
  StatusPill,
  Step,
  Steps,
  TextInput,
  UnitInput,
  type NoticeTone,
  type PillStatus,
  type TrackerStage,
} from '../design/index.js';
import { useTokenRegistry } from '../market/MarketContext.js';
import { readCoins } from '../passport/records.js';
import { useStore } from '../store/StoreContext.js';
import { confirmCancelsOffer, markLiveOffersCancelled } from '../trade/operations.js';
import { useWallet } from '../wallet/WalletContext.js';

const short = (s: string, head = 8, tail = 6) =>
  s.length <= head + tail + 1 ? s : `${s.slice(0, head)}…${s.slice(-tail)}`;
const GAS_PER_SWEEP = maxGasCostWei(DEFAULT_EVM_GAS);
const eth = (wei: bigint) => formatUnits(wei, 18, { maxFractionDigits: 6 });

type Msg = { kind: 'ok' | 'error' | 'info'; text: string; problems?: string[] } | null;

const errorMsg = (err: unknown, fallback: string): Msg =>
  err instanceof PreflightError
    ? { kind: 'error', text: 'Not started, nothing was signed:', problems: err.problems }
    : { kind: 'error', text: err instanceof Error ? err.message : fallback };

const TONE: Record<NonNullable<Msg>['kind'], NoticeTone> = { ok: 'success', error: 'danger', info: 'info' };

function MessageNotice({ msg, testId }: { msg: Msg; testId: string }) {
  if (!msg) return null;
  return (
    <Notice
      tone={TONE[msg.kind]}
      role={msg.kind === 'error' ? 'alert' : 'status'}
      className="gap-top"
      data-testid={testId}
    >
      {msg.text}
      {msg.problems && (
        <ul>
          {msg.problems.map((p) => (
            <li key={p} data-testid="preflight-problem">
              {p}
            </li>
          ))}
        </ul>
      )}
    </Notice>
  );
}

const bridged = (tokens: TokenRegistry | null) =>
  (tokens?.tokens ?? []).filter((t) => t.sepoliaAddress !== '' && t.vault !== '');

/** A Sepolia transaction as a shortened, copyable hash that links to the explorer. */
function SepoliaTx({ hash, explorer }: { hash: string; explorer: string }) {
  return <Hash value={hash} head={8} tail={6} href={`${explorer}/tx/${hash}`} />;
}

// ── Deposit (L-BRG.1) ─────────────────────────────────────────────────────────────

function DepositPanel({ network, tokens }: { network: NetworkProfile; tokens: TokenRegistry | null }) {
  const { account, env, followActively } = useTransfers();
  const { store, revision } = useStore();
  const list = bridged(tokens);
  const [symbol, setSymbol] = useState('');
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<Msg>(null);
  const [status, setStatus] = useState<{
    held: { eth: bigint; erc20: bigint | null };
    tokenShort: bigint;
    gasShort: bigint;
  } | null>(null);
  const token = list.find((t) => t.symbol === symbol) ?? list[0];

  const draft = useMemo(() => {
    const e = env();
    if (!e || !account) return null;
    return (
      listTransfers(e.store, e.scope, account.address).find((t) => t.kind === 'deposit' && t.state === 'funding') ??
      null
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [env, account, revision]);

  const refresh = useCallback(async () => {
    const e = env();
    if (!e || !draft) return;
    try {
      const s = await depositShortfall(e, draft);
      setStatus({ held: s.held, tokenShort: s.tokenShort, gasShort: s.gasShort });
    } catch {
      setStatus(null);
    }
  }, [env, draft]);

  useEffect(() => {
    const t = setTimeout(() => void refresh(), 0);
    return () => clearTimeout(t);
  }, [refresh]);

  if (!account) return null;
  const depositAddress = (() => {
    try {
      return depositAddressOf(network, account.address);
    } catch {
      return null;
    }
  })();

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setMsg(null);
    try {
      await fn();
    } catch (err) {
      setMsg(errorMsg(err, 'Something went wrong.'));
    } finally {
      setBusy(null);
      void refresh();
    }
  };

  const begin = (ev: FormEvent) => {
    ev.preventDefault();
    const e = env();
    if (!e || !token) return;
    setMsg(null);
    try {
      draftDeposit(e, account.address, token, parseUnits(amount, token.decimals));
    } catch (err) {
      setMsg(errorMsg(err, 'Enter an amount.'));
    }
  };

  const explorer = network.evm.explorerUrl;
  return (
    <Panel title="Deposit from Ethereum" meta="Sepolia to Passport" data-testid="deposit-panel">
      <Field
        label="Your account's deposit address"
        hint="Derived in this page from your account; only your account can receive what is sent there. The page sends to it for you."
      >
        {depositAddress ? (
          <CopyField value={depositAddress} data-testid="deposit-address" />
        ) : (
          <span className="mono" data-testid="deposit-address">
            —
          </span>
        )}
      </Field>
      {!draft && (
        <form onSubmit={begin}>
          <Field
            label="Token"
            htmlFor="deposit-token"
            hint={token ? `Arrives in your account as ${token.midnightName}.` : undefined}
          >
            <Select
              id="deposit-token"
              value={token?.symbol ?? ''}
              onChange={(e) => setSymbol(e.target.value)}
              data-testid="deposit-token"
            >
              {list.map((t) => (
                <option key={t.symbol} value={t.symbol}>
                  {t.symbol} → {t.midnightName}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Amount" htmlFor="deposit-amount">
            <UnitInput
              id="deposit-amount"
              unit={token?.symbol ?? '—'}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              inputMode="decimal"
              autoComplete="off"
              data-testid="deposit-amount"
            />
          </Field>
          <Button type="submit" data-testid="deposit-continue" disabled={!token || !store}>
            Continue
          </Button>
        </form>
      )}
      {draft && (
        <div data-testid="deposit-draft" data-id={draft.id}>
          <KeyValueList
            items={[
              {
                term: 'Deposit',
                value: (
                  <strong className="num">
                    {formatUnits(BigInt(draft.amount), draft.decimals, { minFractionDigits: 2 })} {draft.symbol}
                  </strong>
                ),
              },
              { term: 'Arrives as', value: draft.midnightName },
              {
                term: "Gas for the bridge's sweep",
                value: <span className="num">up to {eth(GAS_PER_SWEEP)} ETH</span>,
              },
              { term: 'Midnight fees', value: 'paid by the bank' },
              {
                term: 'At the deposit address now',
                valueProps: { 'data-testid': 'deposit-held', className: 'tabular' },
                value: status
                  ? `${formatUnits(status.held.erc20 ?? 0n, draft.decimals, { minFractionDigits: 2 })} ${draft.symbol}, ${eth(status.held.eth)} ETH`
                  : '—',
              },
            ]}
          />
          <Steps>
            <Step title="Send the tokens with your wallet" done={status?.tokenShort === 0n}>
              <p>Your wallet asks you to approve a transfer to the deposit address.</p>
              <ButtonRow>
                <Button
                  variant="secondary"
                  data-testid="send-tokens"
                  disabled={!!busy || status?.tokenShort === 0n}
                  onClick={() =>
                    void run('tokens', async () => {
                      const e = env();
                      if (e) await sendDepositTokens(e, draft);
                    })
                  }
                >
                  Send {status && status.tokenShort > 0n ? formatUnits(status.tokenShort, draft.decimals) : ''}{' '}
                  {draft.symbol} from your wallet
                </Button>
                {status?.tokenShort === 0n && (
                  <StatusPill status="done" data-testid="tokens-ready">
                    ✓ there
                  </StatusPill>
                )}
                {draft.funding?.tokenTx && <SepoliaTx hash={draft.funding.tokenTx} explorer={explorer} />}
              </ButtonRow>
            </Step>
            <Step title="Send ETH for the sweep's gas" done={status?.gasShort === 0n}>
              <p>The bridge's sweep of the deposit address pays its own Sepolia gas.</p>
              <ButtonRow>
                <Button
                  variant="secondary"
                  data-testid="send-gas"
                  disabled={!!busy || status?.gasShort === 0n}
                  onClick={() =>
                    void run('gas', async () => {
                      const e = env();
                      if (e) await sendDepositGas(e, draft);
                    })
                  }
                >
                  Send {status && status.gasShort > 0n ? eth(status.gasShort) : ''} ETH for the sweep&apos;s gas
                </Button>
                {status?.gasShort === 0n && (
                  <StatusPill status="done" data-testid="gas-ready">
                    ✓ there
                  </StatusPill>
                )}
                {draft.funding?.gasTx && <SepoliaTx hash={draft.funding.gasTx} explorer={explorer} />}
              </ButtonRow>
            </Step>
            <Step title="Start the deposit">
              <p>When both have arrived, sign once to start. The bank does the rest, in about 20 minutes.</p>
              <ButtonRow>
                <Button
                  data-testid="start-deposit"
                  disabled={!!busy}
                  onClick={() =>
                    void run('start', async () => {
                      const e = env();
                      if (!e) return;
                      // L-TRD.3 (Q9): the start is a signed call; it cancels a live offer.
                      if (!confirmCancelsOffer(e, draft.account, 'bridge-deposit')) return;
                      const rec = await startDeposit(e, draft);
                      markLiveOffersCancelled(e, draft.account);
                      followActively(rec.id);
                      setMsg({
                        kind: 'ok',
                        text: 'Deposit started. It takes about 20 minutes; you can close this page and come back.',
                      });
                    })
                  }
                >
                  {busy === 'start' ? 'Starting…' : 'Start the deposit (you sign once)'}
                </Button>
              </ButtonRow>
            </Step>
          </Steps>
          <p className="table-note">
            <Button
              variant="link"
              data-testid="deposit-cancel"
              disabled={!!busy}
              onClick={() => {
                const e = env();
                if (e) e.store.remove(transferKey(e.scope, draft.account, draft.id));
              }}
            >
              Cancel
            </Button>{' '}
            — anything already sent stays at the deposit address for your next deposit.
          </p>
        </div>
      )}
      <MessageNotice msg={msg} testId="deposit-message" />
    </Panel>
  );
}

// ── Withdrawal (L-BRG.2) ──────────────────────────────────────────────────────────

function WithdrawPanel({ network, tokens }: { network: NetworkProfile; tokens: TokenRegistry | null }) {
  const { account, env, followActively } = useTransfers();
  const { store, revision } = useStore();
  const wallet = useWallet();
  const [colour, setColour] = useState('');
  const [amount, setAmount] = useState('');
  const [dest, setDest] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);
  const [vaultGas, setVaultGas] = useState<bigint | null>(null);
  const scope = wallet.address ? { network: network.name, evmAddress: wallet.address } : null;
  const held = useMemo(
    () => (store && scope && account ? holdingsByColour(readCoins(store, scope, account.address)) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [store, account, wallet.address, revision],
  );
  const withdrawable = held
    .map((h) => ({ h, t: tokens?.byColour(h.color) }))
    .filter(
      (x): x is { h: (typeof held)[number]; t: TokenEntry } => !!x.t && x.t.sepoliaAddress !== '' && x.t.vault !== '',
    );
  const chosen = withdrawable.find((x) => x.h.color === colour) ?? withdrawable[0];

  useEffect(() => {
    const e = env();
    const vault = network.bridge.vaultEvmAddress;
    if (!e || !vault) return;
    let live = true;
    sepoliaBalances(e, vault, null).then(
      (b) => live && setVaultGas(b.eth),
      () => live && setVaultGas(null),
    );
    return () => {
      live = false;
    };
  }, [env, network.bridge.vaultEvmAddress, revision]);

  if (!account || withdrawable.length === 0 || !chosen) {
    return (
      <Panel title="Withdraw to Ethereum" meta="Passport to Sepolia" data-testid="withdraw-panel">
        <EmptyState data-testid="withdraw-nothing" title="Nothing to withdraw yet">
          Deposit first: bridged tokens in your account can be withdrawn here.
        </EmptyState>
      </Panel>
    );
  }

  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    const e = env();
    if (!e) return;
    setMsg(null);
    let raw: bigint;
    try {
      raw = parseUnits(amount, chosen.t.decimals);
    } catch (err) {
      setMsg(errorMsg(err, 'Enter an amount.'));
      return;
    }
    if (raw > chosen.h.largest) {
      setMsg({
        kind: 'error',
        text: `The largest single payment is ${formatUnits(chosen.h.largest, chosen.t.decimals)} ${chosen.t.midnightName}: the account pays from one coin at a time.`,
      });
      return;
    }
    // L-TRD.3 (Q9): the start is a signed call; it cancels a live offer.
    if (!confirmCancelsOffer(e, account.address, 'bridge-withdraw')) return;
    setBusy(true);
    try {
      const rec = await startWithdraw(e, account.address, {
        token: chosen.t,
        amount: raw,
        dest: dest.trim() || wallet.address!,
      });
      markLiveOffersCancelled(e, account.address);
      followActively(rec.id);
      setMsg({
        kind: 'ok',
        text: 'Withdrawal started. It takes about 20 minutes; you can close this page and come back.',
      });
    } catch (err) {
      setMsg(errorMsg(err, 'The withdrawal could not start.'));
    } finally {
      setBusy(false);
    }
  };

  const gasShort = vaultGas !== null && vaultGas < GAS_PER_SWEEP;
  return (
    <Panel title="Withdraw to Ethereum" meta="Passport to Sepolia" data-testid="withdraw-panel">
      <form onSubmit={(e) => void submit(e)}>
        <Field label="Token" htmlFor="withdraw-token" hint={`Arrives on Sepolia as ${chosen.t.symbol}.`}>
          <Select
            id="withdraw-token"
            value={chosen.h.color}
            onChange={(e) => setColour(e.target.value)}
            data-testid="withdraw-token"
          >
            {withdrawable.map(({ h, t }) => (
              <option key={h.color} value={h.color}>
                {t.midnightName} → {t.symbol}
              </option>
            ))}
          </Select>
        </Field>
        <Field
          label="Amount"
          htmlFor="withdraw-amount"
          hint={
            <span data-testid="withdraw-largest">
              Largest single payment: {formatUnits(chosen.h.largest, chosen.t.decimals)} {chosen.t.midnightName}
            </span>
          }
        >
          <UnitInput
            id="withdraw-amount"
            unit={chosen.t.midnightName}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            inputMode="decimal"
            autoComplete="off"
            data-testid="withdraw-amount"
          />
        </Field>
        <Field
          label="Destination on Sepolia"
          htmlFor="withdraw-dest"
          hint="Leave it empty to use your connected wallet, or enter another Sepolia address."
        >
          <TextInput
            id="withdraw-dest"
            className="mono"
            value={dest}
            placeholder={wallet.address ?? '0x…'}
            onChange={(e) => setDest(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            data-testid="withdraw-dest"
          />
        </Field>
        <KeyValueList
          items={[
            {
              term: "Bank's bridge gas for the return",
              value: (
                <span data-testid="vault-gas" className="tabular">
                  The bank&apos;s vault account pays the Sepolia gas (up to {eth(GAS_PER_SWEEP)} ETH):{' '}
                  {vaultGas === null ? '—' : `it holds ${eth(vaultGas)} ETH`}
                  {gasShort ? ' — not enough right now; withdrawals are paused' : ''}
                </span>
              ),
            },
            { term: 'Fees', value: 'paid by the bank' },
            { term: 'Queue', value: 'one at a time, all customers' },
          ]}
        />
        <p className="small muted section-gap">
          You sign once. If you withdraw part of a coin, the bank then asks for a second signature to record the change
          in your account&apos;s inbox, so it can be restored from the chain.
        </p>
        <ButtonRow stretch className="section-gap">
          <Button type="submit" disabled={busy} data-testid="withdraw-submit">
            {busy ? 'Starting…' : 'Sign and withdraw'}
          </Button>
        </ButtonRow>
      </form>
      <MessageNotice msg={msg} testId="withdraw-message" />
    </Panel>
  );
}

// ── Pending and past transfers (L-BRG.3) ──────────────────────────────────────────

/** The milestones every transfer passes, to show what is still ahead while one runs. */
const MILESTONES = ['started', 'mpc-signed', 'evm-broadcast', 'evm-final', 'attested', 'settled'];

const PILL: Record<TransferRecord['state'], PillStatus> = {
  funding: 'idle',
  running: 'progress',
  'needs-resume': 'progress',
  succeeded: 'filled',
  failed: 'failed',
};

const clock = (unixSeconds: number) => new Date(unixSeconds * 1000).toISOString().slice(11, 16);

function TransferCard({ t, network }: { t: TransferRecord; network: NetworkProfile }) {
  const { env, followActively } = useTransfers();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);
  const outcome = outcomeText(t);
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
    } catch (err) {
      setMsg(errorMsg(err, 'Something went wrong.'));
    } finally {
      setBusy(false);
    }
  };
  const title =
    t.kind === 'deposit'
      ? `Deposit ${formatUnits(BigInt(t.amount), t.decimals, { minFractionDigits: 2 })} ${t.symbol} → ${t.midnightName}`
      : `Withdraw ${formatUnits(BigInt(t.amount), t.decimals, { minFractionDigits: 2 })} ${t.midnightName} → ${t.symbol} to ${short(t.dest ?? '', 6, 4)}`;
  const stateText: Record<TransferRecord['state'], string> = {
    funding: 'Waiting for the funding transactions',
    running: mpcSlow(t) ? 'In progress (Sig Network is slow)' : 'In progress',
    'needs-resume': 'Needs you to resume it',
    succeeded: 'Done',
    failed: 'Stopped',
  };

  const shown = t.stages.filter((s) => !['queued', 'running', 'succeeded', 'failed'].includes(s.stage));
  const finished = t.state === 'succeeded' || t.state === 'failed';
  const stages: TrackerStage[] = shown.map((s, i) => ({
    key: `${s.stage}-${s.at}-${i}`,
    title: stageText(t.kind, s.stage),
    state: i < shown.length - 1 || t.state === 'succeeded' ? 'done' : t.state === 'failed' ? 'failed' : 'current',
    time: <span title={new Date(s.at * 1000).toISOString()}>{clock(s.at)}</span>,
    detail: (
      <span className="detail-links">
        {stageLinks(s.detail, network.evm.explorerUrl).map((l) => (
          <span key={`${l.label}-${l.value}`}>
            {l.label}{' '}
            {l.value.length > 20 ? (
              <Hash value={l.value} head={8} tail={6} href={l.href} />
            ) : (
              <span className="mono">{l.value}</span>
            )}
          </span>
        ))}
      </span>
    ),
    data: { testid: 'transfer-stage', stage: s.stage },
  }));
  // What is still ahead (shown only while the transfer runs its usual course).
  if (!finished && !shown.some((s) => s.stage === 'evm-not-broadcast')) {
    const reached = shown.reduce((n, s) => Math.max(n, MILESTONES.indexOf(s.stage)), -1);
    for (const m of MILESTONES.slice(reached + 1)) {
      stages.push({ key: `ahead-${m}`, title: stageText(t.kind, m), state: 'pending', data: { ahead: m } });
    }
  }

  return (
    <li className="transfer-card" data-testid="transfer" data-id={t.id} data-kind={t.kind} data-state={t.state}>
      <div className="transfer-head">
        <span className="transfer-title">{title}</span>
        <StatusPill status={PILL[t.state]} data-testid="transfer-state">
          {stateText[t.state]}
        </StatusPill>
      </div>
      <div className="transfer-meta">
        {t.requestId && (
          <span data-testid="transfer-request">
            request <Hash value={t.requestId} head={8} tail={6} />
          </span>
        )}
        {(t.funding?.tokenTx || t.funding?.gasTx) && (
          <span>
            funding{' '}
            {[t.funding?.tokenTx, t.funding?.gasTx].filter(Boolean).map((h) => (
              <SepoliaTx key={h} hash={h!} explorer={network.evm.explorerUrl} />
            ))}
          </span>
        )}
      </div>
      {stages.length > 0 && <StageTracker stages={stages} label={title} />}
      <div className="transfer-foot">
        {outcome && <MessageNotice msg={outcome} testId="transfer-outcome" />}
        {t.state === 'needs-resume' && (
          <Button
            disabled={busy}
            data-testid="resume-transfer"
            onClick={() =>
              void act(async () => {
                const e = env();
                if (!e) return;
                const r = await resumeTransfer(e, t);
                followActively(r.id);
              })
            }
          >
            {busy ? 'Resuming…' : 'Resume (you sign once)'}
          </Button>
        )}
        {t.state === 'succeeded' && t.change && !t.change.secured && (
          <Notice tone="warning" data-testid="transfer-change">
            Change of {formatUnits(BigInt(t.change.coin.value), t.decimals)} {t.midnightName} is not yet recorded in
            your account&apos;s inbox{t.change.deferredReason ? ` (${t.change.deferredReason})` : ''}.{' '}
            <Button
              variant="secondary"
              size="small"
              disabled={busy}
              data-testid="secure-transfer-change"
              onClick={() =>
                void act(async () => {
                  const e = env();
                  if (e && confirmCancelsOffer(e, t.account, 'append-inbox'))
                    await secureTransferChange(e, {
                      ...t,
                      change: { ...t.change!, deferredReason: undefined },
                    } as TransferRecord);
                })
              }
            >
              Record it now (you sign once)
            </Button>
          </Notice>
        )}
        {t.change?.secured && (
          <p className="small muted" data-testid="transfer-change-secured">
            The change is recorded in your inbox{t.change.secureTx ? ` (tx ${short(t.change.secureTx)})` : ''}.
          </p>
        )}
        <MessageNotice msg={msg} testId="transfer-message" />
      </div>
    </li>
  );
}

export function Transfers({ network }: { network: NetworkProfile }) {
  const tokens = useTokenRegistry();
  const wallet = useWallet();
  const { account, hasSecret, env } = useTransfers();
  const { revision } = useStore();
  const transfers = useMemo(() => {
    const e = env();
    return e && account ? listTransfers(e.store, e.scope, account.address).filter((t) => t.state !== 'funding') : [];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [env, account, revision]);

  const head = (
    <PageHead
      eyebrow="Between Ethereum and Midnight"
      title="Transfers"
      lede="Move stocks and USDC between your Sepolia wallet and your Passport account. Each transfer takes about 20 minutes, and you can close the page meanwhile."
    />
  );

  if (wallet.status !== 'connected') {
    return (
      <section data-testid="section-transfers">
        {head}
        <EmptyState title="Connect your wallet">
          Connect your wallet to move tokens between Sepolia and your MN Bank account.
        </EmptyState>
      </section>
    );
  }
  if (!account || !hasSecret) {
    return (
      <section data-testid="section-transfers">
        {head}
        <EmptyState data-testid="transfers-no-account" title="No account in this browser">
          Open an account first (<a href="#accounts">Accounts</a>), or import yours on <a href="#local">Local data</a>.
        </EmptyState>
      </section>
    );
  }
  return (
    <section data-testid="section-transfers">
      {head}
      {!wallet.onRightChain && (
        <Notice tone="warning" className="panel-intro">
          Switch your wallet to Sepolia first.
        </Notice>
      )}
      <div className="form-grid">
        <DepositPanel network={network} tokens={tokens} />
        <WithdrawPanel network={network} tokens={tokens} />
      </div>
      <Panel
        className="section-gap"
        title="Pending and past transfers"
        meta="Stored in this browser"
        data-testid="transfers-list"
      >
        {transfers.length === 0 ? (
          <p className="muted" data-testid="transfers-empty">
            No transfers yet.
          </p>
        ) : (
          <ul className="transfer-list">
            {transfers.map((t) => (
              <TransferCard key={t.id} t={t} network={network} />
            ))}
          </ul>
        )}
      </Panel>
    </section>
  );
}
