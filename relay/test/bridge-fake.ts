// A fake bridge backend: Sepolia balances and nonces, the vault's open requests and settle views,
// the two starts, a controllable MPC, and the settles. No network, no proof.

import type { AttestedKind, BridgeDepositPayload, BridgeKind, BridgeWithdrawPayload } from '@mnbank/core';

import type {
  BridgeBackend,
  RelayOutcome,
  RelayProgress,
  SettleCircuit,
  SettleView,
  StartAuth,
  StartOutcome,
  TxFacts,
} from '../src/bridge/backend.js';

export const VAULT = '77'.repeat(32);
export const VAULT_EVM = '0x648216975e722494bFF92E88FFc68C8F8d438FaA';
export const STKA = '0x2Ab7BE0769e3BBD5c7d047B422CB383fCC06FB52';
export const STKB = '0xF2bEFf36543219C8feC2AB2f42070AA65D3C844B';
export const COLOUR_A = 'a1'.repeat(32);
export const COLOUR_B = 'b1'.repeat(32);
const VAULT_PATH = '5a'.repeat(32);

export type MpcMode = AttestedKind | 'timeout';

/** A gate the test opens to let one MPC round trip finish. */
export class Gate {
  private open!: () => void;
  readonly opened: Promise<void> = new Promise((r) => (this.open = r));
  release() {
    this.open();
  }
}

export class FakeBridge implements BridgeBackend {
  readonly vaultEvmAddress = VAULT_EVM;
  readonly eth = new Map<string, bigint>();
  readonly erc20 = new Map<string, bigint>();
  readonly nonces = new Map<string, bigint>();
  readonly open: Record<BridgeKind, Map<string, string>> = { deposit: new Map(), withdraw: new Map() };
  readonly views: Record<BridgeKind, Map<string, SettleView & { signedNonce: bigint; payer: string }>> = {
    deposit: new Map(),
    withdraw: new Map(),
  };
  readonly calls: string[] = [];
  /** How the MPC answers the next round trips (default: success). */
  mpc: MpcMode = 'success';
  /** When set, every relay waits for this gate after the signature (before the broadcast). */
  gate: Gate | null = null;
  /** Extra ids a start also creates (to provoke an ambiguous request match). */
  extraOnStart: Array<{ kind: BridgeKind; path: (account: string) => string }> = [];
  private seq = 0;

  private key = (a: string) => a.toLowerCase();
  setEth(a: string, v: bigint) {
    this.eth.set(this.key(a), v);
  }
  setErc20(token: string, a: string, v: bigint) {
    this.erc20.set(`${this.key(token)}:${this.key(a)}`, v);
  }
  setNonce(a: string, v: bigint) {
    this.nonces.set(this.key(a), v);
  }

  readonly evm = {
    ethBalance: async (a: string) => this.eth.get(this.key(a)) ?? 0n,
    erc20Balance: async (t: string, a: string) => this.erc20.get(`${this.key(t)}:${this.key(a)}`) ?? 0n,
    nonce: async (a: string, _tag: 'latest' | 'pending') => this.nonces.get(this.key(a)) ?? 0n,
  };

  depositAddress(account: string) {
    return `0x${account.slice(0, 40)}`;
  }
  depositPathHex(account: string) {
    return `d0${account.slice(2)}`;
  }
  vaultPathHex() {
    return VAULT_PATH;
  }
  colourOf(erc20: string) {
    return erc20.toLowerCase() === STKA.toLowerCase() ? COLOUR_A : COLOUR_B;
  }

  async openRequests(kind: BridgeKind) {
    const m = this.open[kind];
    return { ids: [...m.keys()], pathOf: (id: string) => m.get(id) };
  }

  async settleView(kind: BridgeKind, id: string) {
    const v = this.views[kind].get(id);
    return v ? { account: v.account, erc20: v.erc20, amount: v.amount } : null;
  }

  private newId() {
    return (++this.seq).toString(16).padStart(64, '0');
  }

  /** A request as if a start had landed (to test resume after a restart). */
  addOpen(kind: BridgeKind, account: string, erc20: string, amount: bigint, signedNonce = 0n): string {
    const id = this.newId();
    const payer = kind === 'deposit' ? this.depositAddress(account) : VAULT_EVM;
    this.open[kind].set(id, kind === 'deposit' ? this.depositPathHex(account) : VAULT_PATH);
    this.views[kind].set(id, { account, erc20, amount, signedNonce, payer });
    return id;
  }

  private addExtra(kind: BridgeKind, account: string) {
    for (const x of this.extraOnStart.filter((e) => e.kind === kind))
      this.open[kind].set(this.newId(), x.path(account));
  }

  async startDeposit(i: { account: string; payload: BridgeDepositPayload; auth: StartAuth }): Promise<StartOutcome> {
    this.calls.push(`startDeposit:${i.account.slice(0, 4)}:${i.payload.evm.nonce}`);
    this.addOpen('deposit', i.account, i.payload.erc20, BigInt(i.payload.amount), BigInt(i.payload.evm.nonce));
    this.addExtra('deposit', i.account);
    return { txId: `tx-start-${this.seq}`, change: null };
  }

  async startWithdraw(i: { account: string; payload: BridgeWithdrawPayload; auth: StartAuth }): Promise<StartOutcome> {
    this.calls.push(`startWithdraw:${i.account.slice(0, 4)}:${i.payload.evm.nonce}`);
    const amount = BigInt(i.payload.amount);
    this.addOpen('withdraw', i.account, i.payload.erc20, amount, BigInt(i.payload.evm.nonce));
    this.addExtra('withdraw', i.account);
    const rest = BigInt(i.payload.coin.value) - amount;
    return {
      txId: `tx-start-${this.seq}`,
      change: rest > 0n ? { nonce: 'cc'.repeat(32), color: i.payload.color, value: rest.toString(10) } : null,
    };
  }

  async relay(i: {
    kind: BridgeKind;
    requestId: string;
    expectedSigner: string;
    signatureTimeoutMs: number;
    onProgress: (p: RelayProgress) => void;
  }): Promise<RelayOutcome> {
    this.calls.push(`relay:${i.kind}:${i.requestId.slice(-2)}`);
    const view = this.views[i.kind].get(i.requestId);
    if (!view) throw new Error('no such request');
    if (this.mpc === 'timeout') {
      throw new Error(
        `timed out after ${Math.round(i.signatureTimeoutMs / 1000)} s waiting for the MPC's signature on ${i.requestId} (expected signer ${i.expectedSigner})`,
      );
    }
    i.onProgress({
      stage: 'signed',
      signedTxHash: `0xsigned${i.requestId.slice(-4)}`,
      from: i.expectedSigner,
      nonce: Number(view.signedNonce),
      afterMs: 110_000,
    });
    if (this.gate) await this.gate.opened;
    const kind = this.mpc;
    if (kind === 'never-executed') {
      i.onProgress({ stage: 'not-broadcast', reason: 'nonce already consumed', afterMs: 120_000 });
    } else {
      // The broadcast spends the payer's nonce.
      this.setNonce(view.payer, (this.nonces.get(this.key(view.payer)) ?? 0n) + 1n);
      i.onProgress({
        stage: 'broadcast',
        evmTxHash: `0xevm${i.requestId.slice(-4)}`,
        evmBlock: 100,
        evmStatus: 1,
        alreadyMined: false,
        afterMs: 120_000,
      });
      i.onProgress({ stage: 'finalized', evmBlock: 100, finalizedBlock: 101, afterMs: 900_000 });
    }
    return {
      kind,
      ...(kind === 'never-executed' ? {} : { evmTxHash: `0xevm${i.requestId.slice(-4)}`, evmStatus: 1 }),
      signedTxHash: `0xsigned${i.requestId.slice(-4)}`,
      signatureAfterMs: 110_000,
      attestationAfterMs: 1_100_000,
      event: { fake: true },
      serializedOutput: new Uint8Array(kind === 'never-executed' ? 5 : 1),
    };
  }

  async settle(i: {
    kind: BridgeKind;
    circuit: SettleCircuit;
    account: string;
    requestId: string;
    relay: RelayOutcome;
  }) {
    this.calls.push(`settle:${i.circuit}:${i.requestId.slice(-2)}`);
    const view = this.views[i.kind].get(i.requestId);
    if (!view) throw new Error('no settle view');
    this.open[i.kind].delete(i.requestId);
    this.views[i.kind].delete(i.requestId);
    const mints =
      (i.kind === 'deposit' && i.relay.kind === 'success') || (i.kind === 'withdraw' && i.relay.kind !== 'success');
    return {
      txId: `tx-settle-${i.requestId.slice(-2)}`,
      coin: mints
        ? { nonce: 'ee'.repeat(32), color: this.colourOf(view.erc20), value: view.amount.toString(10) }
        : null,
      entryMatchesCoin: true,
    };
  }

  async txFacts(txId: string): Promise<TxFacts> {
    return { hash: `hash-${txId}`, blockHeight: 1, blockMs: 1_700_000_000_000 };
  }
}
