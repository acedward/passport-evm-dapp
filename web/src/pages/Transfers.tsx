// The Transfers section (spec US5, US6; plan L-BRG.1–.3): bridge tokens from Sepolia into the
// account (deposit), out to a Sepolia address (withdrawal), and follow every transfer in flight.
//
// Plain layout for now: the MN Bank design (P1.5) restyles it once the mockup is approved (Q16).

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
import { useTokenRegistry } from '../market/MarketContext.js';
import { readCoins } from '../passport/records.js';
import { useStore } from '../store/StoreContext.js';
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

function Notice({ msg, testId }: { msg: Msg; testId: string }) {
  if (!msg) return null;
  return (
    <div role={msg.kind === 'error' ? 'alert' : 'status'} className={`notice ${msg.kind}`} data-testid={testId}>
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
    </div>
  );
}

const bridged = (tokens: TokenRegistry | null) =>
  (tokens?.tokens ?? []).filter((t) => t.sepoliaAddress !== '' && t.vault !== '');

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

  return (
    <section aria-labelledby="deposit-title" data-testid="deposit-panel">
      <h3 id="deposit-title">Deposit from Sepolia</h3>
      <p>
        Your account&apos;s deposit address on Sepolia is{' '}
        <span className="mono" data-testid="deposit-address">
          {depositAddress ?? '—'}
        </span>
        . It is derived in this page from your account; only your account can receive what is sent there.
      </p>
      {!draft && (
        <form onSubmit={begin}>
          <label>
            Token{' '}
            <select value={token?.symbol ?? ''} onChange={(e) => setSymbol(e.target.value)} data-testid="deposit-token">
              {list.map((t) => (
                <option key={t.symbol} value={t.symbol}>
                  {t.symbol} → {t.midnightName}
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
              data-testid="deposit-amount"
            />
          </label>
          <button type="submit" data-testid="deposit-continue" disabled={!token || !store}>
            Continue
          </button>
        </form>
      )}
      {draft && (
        <div data-testid="deposit-draft" data-id={draft.id}>
          <p>
            Deposit{' '}
            <strong>
              {formatUnits(BigInt(draft.amount), draft.decimals, { minFractionDigits: 2 })} {draft.symbol}
            </strong>{' '}
            as {draft.midnightName}. The sweep into the bank&apos;s vault needs up to {eth(GAS_PER_SWEEP)} ETH of gas at
            the deposit address.
          </p>
          <p data-testid="deposit-held">
            At the deposit address now:{' '}
            {status
              ? `${formatUnits(status.held.erc20 ?? 0n, draft.decimals, { minFractionDigits: 2 })} ${draft.symbol}, ${eth(status.held.eth)} ETH`
              : '—'}
          </p>
          <ol>
            <li>
              <button
                type="button"
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
              </button>
              {status?.tokenShort === 0n && <span data-testid="tokens-ready"> ✓ there</span>}
              {draft.funding?.tokenTx && (
                <a
                  className="mono"
                  href={`${network.evm.explorerUrl}/tx/${draft.funding.tokenTx}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {' '}
                  {short(draft.funding.tokenTx)}
                </a>
              )}
            </li>
            <li>
              <button
                type="button"
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
              </button>
              {status?.gasShort === 0n && <span data-testid="gas-ready"> ✓ there</span>}
              {draft.funding?.gasTx && (
                <a
                  className="mono"
                  href={`${network.evm.explorerUrl}/tx/${draft.funding.gasTx}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {' '}
                  {short(draft.funding.gasTx)}
                </a>
              )}
            </li>
            <li>
              <button
                type="button"
                data-testid="start-deposit"
                disabled={!!busy}
                onClick={() =>
                  void run('start', async () => {
                    const e = env();
                    if (!e) return;
                    const rec = await startDeposit(e, draft);
                    followActively(rec.id);
                    setMsg({
                      kind: 'ok',
                      text: 'Deposit started. It takes about 20 minutes; you can close this page and come back.',
                    });
                  })
                }
              >
                {busy === 'start' ? 'Starting…' : 'Start the deposit (you sign once)'}
              </button>
            </li>
          </ol>
          <button
            type="button"
            className="link"
            data-testid="deposit-cancel"
            disabled={!!busy}
            onClick={() => {
              const e = env();
              if (e) e.store.remove(transferKey(e.scope, draft.account, draft.id));
            }}
          >
            Cancel (anything already sent stays at the deposit address for your next deposit)
          </button>
        </div>
      )}
      <Notice msg={msg} testId="deposit-message" />
    </section>
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
      <section aria-labelledby="withdraw-title" data-testid="withdraw-panel">
        <h3 id="withdraw-title">Withdraw to Sepolia</h3>
        <p data-testid="withdraw-nothing">Nothing to withdraw yet: deposit first.</p>
      </section>
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
    setBusy(true);
    try {
      const rec = await startWithdraw(e, account.address, {
        token: chosen.t,
        amount: raw,
        dest: dest.trim() || wallet.address!,
      });
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

  return (
    <section aria-labelledby="withdraw-title" data-testid="withdraw-panel">
      <h3 id="withdraw-title">Withdraw to Sepolia</h3>
      <form onSubmit={(e) => void submit(e)}>
        <label>
          Token{' '}
          <select value={chosen.h.color} onChange={(e) => setColour(e.target.value)} data-testid="withdraw-token">
            {withdrawable.map(({ h, t }) => (
              <option key={h.color} value={h.color}>
                {t.midnightName} → {t.symbol}
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
            data-testid="withdraw-amount"
          />
        </label>
        <small data-testid="withdraw-largest">
          Largest single payment: {formatUnits(chosen.h.largest, chosen.t.decimals)} {chosen.t.midnightName}
        </small>
        <label>
          To (Sepolia address){' '}
          <input
            value={dest}
            placeholder={wallet.address ?? '0x…'}
            onChange={(e) => setDest(e.target.value)}
            data-testid="withdraw-dest"
          />
        </label>
        <small data-testid="vault-gas">
          The bank&apos;s vault account pays the Sepolia gas (up to {eth(GAS_PER_SWEEP)} ETH):{' '}
          {vaultGas === null ? '—' : `it holds ${eth(vaultGas)} ETH`}
          {vaultGas !== null && vaultGas < GAS_PER_SWEEP ? ' — not enough right now; withdrawals are paused' : ''}
        </small>
        <p>
          You sign once. If you withdraw part of a coin, the bank then asks for a second signature to record the change
          in your account&apos;s inbox, so it can be restored from the chain.
        </p>
        <button type="submit" disabled={busy} data-testid="withdraw-submit">
          {busy ? 'Starting…' : 'Withdraw'}
        </button>
      </form>
      <Notice msg={msg} testId="withdraw-message" />
    </section>
  );
}

// ── Pending and past transfers (L-BRG.3) ──────────────────────────────────────────

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
  return (
    <li className="tracker" data-testid="transfer" data-id={t.id} data-kind={t.kind} data-state={t.state}>
      <p>
        <strong>{title}</strong> — <span data-testid="transfer-state">{stateText[t.state]}</span>
        {t.requestId && (
          <small className="mono" title={t.requestId} data-testid="transfer-request">
            {' '}
            request {short(t.requestId)}
          </small>
        )}
      </p>
      {(t.funding?.tokenTx || t.funding?.gasTx) && (
        <p>
          Funding:{' '}
          {[t.funding?.tokenTx, t.funding?.gasTx].filter(Boolean).map((h) => (
            <a key={h} className="mono" href={`${network.evm.explorerUrl}/tx/${h}`} target="_blank" rel="noreferrer">
              {short(h!)}{' '}
            </a>
          ))}
        </p>
      )}
      <ol>
        {t.stages
          .filter((s) => !['queued', 'running', 'succeeded', 'failed'].includes(s.stage))
          .map((s, i) => (
            <li key={`${s.stage}-${s.at}-${i}`} data-testid="transfer-stage" data-stage={s.stage}>
              {stageText(t.kind, s.stage)}
              {stageLinks(s.detail, network.evm.explorerUrl).map((l) => (
                <span key={`${l.label}-${l.value}`}>
                  {' · '}
                  {l.label}{' '}
                  {l.href ? (
                    <a className="mono" href={l.href} target="_blank" rel="noreferrer" title={l.value}>
                      {short(l.value)}
                    </a>
                  ) : (
                    <span className="mono" title={l.value}>
                      {short(l.value)}
                    </span>
                  )}
                </span>
              ))}
            </li>
          ))}
      </ol>
      {outcome && <Notice msg={outcome} testId="transfer-outcome" />}
      {t.state === 'needs-resume' && (
        <button
          type="button"
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
        </button>
      )}
      {t.state === 'succeeded' && t.change && !t.change.secured && (
        <p data-testid="transfer-change">
          Change of {formatUnits(BigInt(t.change.coin.value), t.decimals)} {t.midnightName} is not yet recorded in your
          account&apos;s inbox{t.change.deferredReason ? ` (${t.change.deferredReason})` : ''}.{' '}
          <button
            type="button"
            disabled={busy}
            data-testid="secure-transfer-change"
            onClick={() =>
              void act(async () => {
                const e = env();
                if (e)
                  await secureTransferChange(e, {
                    ...t,
                    change: { ...t.change!, deferredReason: undefined },
                  } as TransferRecord);
              })
            }
          >
            Record it now (you sign once)
          </button>
        </p>
      )}
      {t.change?.secured && (
        <p data-testid="transfer-change-secured">
          The change is recorded in your inbox{t.change.secureTx ? ` (tx ${short(t.change.secureTx)})` : ''}.
        </p>
      )}
      <Notice msg={msg} testId="transfer-message" />
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

  if (wallet.status !== 'connected') {
    return (
      <section data-testid="section-transfers">
        <h2>Transfers</h2>
        <p>Connect your wallet to move tokens between Sepolia and your MN Bank account.</p>
      </section>
    );
  }
  if (!account || !hasSecret) {
    return (
      <section data-testid="section-transfers">
        <h2>Transfers</h2>
        <p data-testid="transfers-no-account">
          Open an account first (<a href="#accounts">Accounts</a>), or import yours on <a href="#local">Local data</a>.
        </p>
      </section>
    );
  }
  return (
    <section data-testid="section-transfers">
      <h2>Transfers</h2>
      {!wallet.onRightChain && <p className="notice">Switch your wallet to Sepolia first.</p>}
      <DepositPanel network={network} tokens={tokens} />
      <WithdrawPanel network={network} tokens={tokens} />
      <section aria-labelledby="pending-title" data-testid="transfers-list">
        <h3 id="pending-title">Pending and past transfers</h3>
        {transfers.length === 0 ? (
          <p data-testid="transfers-empty">No transfers yet.</p>
        ) : (
          <ul>
            {transfers.map((t) => (
              <TransferCard key={t.id} t={t} network={network} />
            ))}
          </ul>
        )}
      </section>
    </section>
  );
}
