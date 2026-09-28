// What the page says about a transfer (plan L-BRG.3): each stage in plain words, and a clear message
// for every way a transfer can stop — a shortfall, an ERC20 that returned false, a slow MPC, a
// refund, a lost job.

import { formatUnits } from '@mnbank/core';

import type { TransferRecord } from './records.js';

/** The MPC normally signs in about 110 s (G-BRIDGE); after this long the page says it is slow. */
export const MPC_SLOW_AFTER_MS = 5 * 60_000;

export function stageText(kind: TransferRecord['kind'], stage: string): string {
  const t: Record<string, string> = {
    queued: 'Waiting in line at the bank',
    running: 'Picked up by the bank',
    preflight:
      kind === 'deposit'
        ? 'Checked the tokens and gas at your deposit address'
        : "Checked the gas and tokens of the bank's Sepolia vault account",
    'waiting-for-prover': "Waiting for the bank's prover",
    proving: 'Preparing the transaction proof',
    starting: 'Starting the transfer on Midnight',
    started: 'Started on Midnight',
    resumed: 'Picked up again by the bank',
    'mpc-signed': 'Sig Network signed the Sepolia transaction',
    'evm-broadcast': 'Sent on Sepolia',
    'evm-not-broadcast': 'Not sent on Sepolia',
    'evm-final': 'Final on Sepolia',
    attested: 'Sig Network confirmed the outcome',
    settling: 'Finishing on Midnight',
    settled: 'Finished on Midnight',
    abandoning: 'Closing the request in the vault',
    abandoned: 'Request closed in the vault',
    joined: 'The bank was already finishing it',
    'already-closed': 'Already closed by the bank',
    succeeded: 'Done',
    failed: 'Stopped',
  };
  return t[stage] ?? stage;
}

const amountText = (t: TransferRecord, raw?: string) =>
  `${formatUnits(BigInt(raw ?? t.amount), t.decimals, { minFractionDigits: 2 })}`;

/** True when the MPC has not signed long after the start (it normally takes about two minutes). */
export function mpcSlow(t: TransferRecord, now = Date.now()): boolean {
  if (t.state !== 'running') return false;
  const started = t.stages.find((s) => s.stage === 'started' || s.stage === 'resumed');
  if (!started) return false;
  if (t.stages.some((s) => s.stage === 'mpc-signed')) return false;
  return now - started.at * 1000 > MPC_SLOW_AFTER_MS;
}

/** The one line that says how a transfer ended, or why it is stopped. */
export function outcomeText(t: TransferRecord): { kind: 'ok' | 'error' | 'info'; text: string } | null {
  const name = t.kind === 'deposit' ? t.midnightName : t.symbol;
  if (t.state === 'succeeded' && t.result) {
    const r = t.result;
    const bank =
      r.closedBy === 'relay'
        ? 'A stale request was closed: the bank finished this transfer after it was left open. '
        : '';
    if (r.settleCircuit === 'abandonDeposit') {
      return {
        kind: 'info',
        text: `${bank}Sig Network reported that the sweep never ran on Sepolia, so nothing was minted and the request is closed: you can deposit again. Your ${t.symbol} is still at your deposit address, where your next deposit will use it.`,
      };
    }
    if (t.kind === 'deposit') {
      if (r.attested === 'returned-false') {
        return {
          kind: 'error',
          text: `${bank}The ${t.symbol} contract refused the sweep (its transfer returned false). Nothing was minted; the request is closed and your ${t.symbol} stays at the deposit address.`,
        };
      }
      return { kind: 'ok', text: `${bank}${amountText(t, r.coin?.value)} ${t.midnightName} arrived in your account.` };
    }
    if (r.settleCircuit === 'bridge_withdraw_refund') {
      return {
        kind: 'info',
        text: `${bank}Refunded: the transfer never ran on Sepolia, so ${amountText(t, r.coin?.value)} ${t.midnightName} came back to your account.`,
      };
    }
    if (r.attested === 'returned-false') {
      return {
        kind: 'info',
        text: `${bank}Refunded: the ${t.symbol} contract refused the payout (its transfer returned false), so ${amountText(t, r.coin?.value)} ${t.midnightName} came back to your account.`,
      };
    }
    return { kind: 'ok', text: `${bank}${amountText(t)} ${name} sent to ${t.dest} on Sepolia.` };
  }
  if (t.state === 'needs-resume') {
    if (t.error?.code === 'mpc-timeout') {
      return {
        kind: 'error',
        text: `Sig Network has not signed this request within 20 minutes. Nothing moved on Sepolia. Resume it to keep waiting, or ask the bank (request ${t.requestId}).`,
      };
    }
    return {
      kind: 'error',
      text: t.error?.message ?? 'The bank stopped following this transfer. Resume it: nothing is lost.',
    };
  }
  if (t.state === 'failed') {
    const e = t.error;
    if (e?.code === 'preflight-refused') return { kind: 'error', text: `Not started: ${e.message}` };
    if (e?.code === 'stale-evm-nonce' || e?.code === 'stale-authorisation')
      return { kind: 'error', text: `${e.message}. Nothing was sent: start it again.` };
    return { kind: 'error', text: e?.message ?? 'The bank could not complete this transfer.' };
  }
  if (mpcSlow(t)) {
    return {
      kind: 'info',
      text: 'Sig Network is slower than usual (it normally signs within about two minutes). The bank keeps waiting for up to 20 minutes; nothing has moved on Sepolia yet.',
    };
  }
  return null;
}

/** Links for the hashes a stage carries: Sepolia on its explorer; Midnight ids and hashes as text. */
export function stageLinks(
  detail: Record<string, string> | undefined,
  sepoliaExplorer: string,
): Array<{ label: string; value: string; href?: string }> {
  if (!detail) return [];
  const out: Array<{ label: string; value: string; href?: string }> = [];
  const sep = (label: string, v?: string) =>
    v && out.push({ label, value: v, href: `${sepoliaExplorer.replace(/\/$/, '')}/tx/${v}` });
  const mid = (label: string, v?: string) => v && out.push({ label, value: v });
  mid('Midnight tx', detail.txHash ?? detail.tx);
  mid('request', detail.requestId);
  sep('signed Sepolia tx', detail.signedTx);
  sep('Sepolia tx', detail.evmTx);
  if (detail.evmBlock) out.push({ label: 'Sepolia block', value: detail.evmBlock });
  if (detail.reason) out.push({ label: 'reason', value: detail.reason });
  if (detail.kind) out.push({ label: 'outcome', value: detail.kind });
  return out;
}
