// What the bank's /health says the customer can and cannot do right now (plan P4-A error states),
// as specific notices. Pure and unit-tested; ./BankStatus.tsx polls /health and pages show the
// notices where they matter:
//   - everywhere (the shell): the bank unreachable, its prover down, its fee wallet low or syncing;
//   - Transfers: withdrawals paused for lack of gas at the vault's Sepolia account, a slow MPC;
//   - Trade: the exchange's settlement service down or refusing (429, 500).

import { formatUnits, type HealthResponse } from '@mnbank/core';

export type NoticePlace = 'shell' | 'transfers' | 'trade';

export interface BankNotice {
  id:
    | 'relay-down'
    | 'prover-down'
    | 'sponsor-low'
    | 'sponsor-syncing'
    | 'vault-gas-low'
    | 'mpc-slow'
    | 'batcher-down'
    | 'batcher-refusing';
  place: NoticePlace;
  tone: 'danger' | 'warning' | 'info';
  title: string;
  text: string;
}

/** The bank as last read: its health, or why it could not be read. */
export interface BankState {
  health: HealthResponse | null;
  /** False when /health could not be reached at all; null before the first read. */
  reachable: boolean | null;
  /** Unix ms of the last read. */
  checkedAt: number | null;
}

/** A refusal of the batcher counts for this long after it happened (seconds). */
export const BATCHER_REFUSAL_RECENT_S = 3_600;

export function bankNotices(s: BankState, nowS = Math.floor(Date.now() / 1000)): BankNotice[] {
  if (s.reachable === false) {
    return [
      {
        id: 'relay-down',
        place: 'shell',
        tone: 'danger',
        title: "The bank's server cannot be reached.",
        text: 'Your balances and the records in this browser are safe. Opening an account, transfers and trading need the bank, and work again as soon as it answers.',
      },
    ];
  }
  const h = s.health;
  if (!h) return [];
  const out: BankNotice[] = [];
  if (!h.proofServer.reachable) {
    out.push({
      id: 'prover-down',
      place: 'shell',
      tone: 'danger',
      title: "The bank's prover is not available.",
      text: 'Opening accounts, transfers and offers are paused until it is back. Your balances are safe.',
    });
  }
  if (h.sponsor.configured && !h.sponsor.synced) {
    out.push({
      id: 'sponsor-syncing',
      place: 'shell',
      tone: 'warning',
      title: "The bank's fee wallet is starting up.",
      text: 'It pays the network fees of every action; until it has caught up with the chain, new actions wait. Try again in a few minutes.',
    });
  } else if (h.sponsor.configured && h.sponsor.dustLow) {
    out.push({
      id: 'sponsor-low',
      place: 'shell',
      tone: 'danger',
      title: 'The bank is low on network-fee funds.',
      text: 'It pays your fees in DUST, and it has too little left, so opening accounts, transfers and offers are paused until the bank tops it up. Your balances are safe.',
    });
  }
  if (h.vaultGas.low === true) {
    const eth =
      h.vaultGas.balanceWei === null
        ? ''
        : ` (it holds ${formatUnits(BigInt(h.vaultGas.balanceWei), 18, { minFractionDigits: 4, maxFractionDigits: 6 })} ETH)`;
    out.push({
      id: 'vault-gas-low',
      place: 'transfers',
      tone: 'warning',
      title: 'Withdrawals to Sepolia are paused.',
      text: `The bank's Sepolia vault account pays the gas of every withdrawal, and it is low on ETH${eth}. Deposits and trading still work; withdrawals resume when the bank tops it up.`,
    });
  }
  const mpc = h.bridge?.mpc;
  if (mpc && mpc.timeouts24h > 0) {
    out.push({
      id: 'mpc-slow',
      place: 'transfers',
      tone: 'info',
      title: 'Sig Network has been slow today.',
      text: `${mpc.timeouts24h} transfer${mpc.timeouts24h === 1 ? '' : 's'} waited more than 20 minutes for its signature in the last day. Transfers may take longer than usual; nothing moves on Sepolia until it signs, and you can resume a transfer that stops.`,
    });
  }
  if (!h.batcher.reachable) {
    out.push({
      id: 'batcher-down',
      place: 'trade',
      tone: 'warning',
      title: "The exchange's settlement service is not answering.",
      text: 'Taking an offer is paused until it is back. You can still place your own offer; it is settled when someone takes it.',
    });
  } else if (h.batcher.lastRefusal && nowS - h.batcher.lastRefusal.at < BATCHER_REFUSAL_RECENT_S) {
    const r = h.batcher.lastRefusal;
    out.push({
      id: 'batcher-refusing',
      place: 'trade',
      tone: 'warning',
      title:
        r.httpStatus === 429
          ? "The exchange's settlement service is at its limit."
          : "The exchange's settlement service is failing.",
      text:
        r.httpStatus === 429
          ? 'It refused a recent settlement because it allows only a limited number a day (HTTP 429). A take may be refused until the limit resets; nothing moves when it is.'
          : `It answered a recent settlement with an error (HTTP ${r.httpStatus}). A take may fail; nothing moves when it does, and you can try again.`,
    });
  }
  return out;
}

/** Whether the bank can take actions that it pays fees for (register, transfers, offers) now. */
export function spendingPaused(s: BankState): string | null {
  const n = bankNotices(s).find((x) => ['relay-down', 'prover-down', 'sponsor-low', 'sponsor-syncing'].includes(x.id));
  return n ? `${n.title} ${n.text}` : null;
}

/** Whether withdrawals to Sepolia are paused (the vault's EVM account lacks gas). */
export function withdrawalsPaused(s: BankState): string | null {
  const n = bankNotices(s).find((x) => x.id === 'vault-gas-low');
  return n ? `${n.title} ${n.text}` : null;
}
