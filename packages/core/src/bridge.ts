// The bridge's wire contract (plan L-BRG; spec US5, US6, FR-009, FR-010): the bodies of the two
// device-gated starts and of a resume, the quote the relay gives before a start, the job's
// public result, its stage names, and the preflights the page and the relay both run.
//
// A round trip is two Midnight transactions with the MPC in between (acedward/passport
// `contract/src/wallet/bridge.ts`):
//
//   deposit   the customer's wallet sends the ERC20 and the sweep's gas ETH to the account's
//             deposit address (Sepolia) -> bridge_deposit_start_with_evm (one signature) ->
//             the MPC signs the sweep, the relay broadcasts it, Sepolia finality, the MPC
//             attests -> bridge_deposit_complete (permissionless) mints the coin to the account
//             and files its inbox entry.
//   withdraw  bridge_withdraw_start_with_evm (one signature) hands ONE coin to the vault ->
//             the MPC signs transfer(dest, amount) from the vault's own EVM account, broadcast,
//             finality, attestation -> bridge_withdraw_complete (nothing minted on success, a
//             refund coin on a transfer that returned false) or bridge_withdraw_refund (the
//             transfer never executed: the refund is always minted).
//
// The Ethereum transaction the MPC signs is part of what the device signs (its nonce and gas),
// so the relay quotes the nonce to sign (its lanes know which nonces are already promised) and
// enforces one gas policy: the gas of a withdrawal is paid from the vault's shared EVM account.

import { z } from 'zod';

import { QualifiedCoinSchema } from './accounts.js';
import {
  depositPreflight,
  type DepositPreflightResult,
} from '../../../vendor/passport/contract/contracts/erc20-vault/src/preflight.js';

export { depositPreflight, type DepositPreflightResult };

const decimal = z.string().regex(/^[0-9]{1,40}$/);
const hex32 = z.string().regex(/^(0x)?[0-9a-fA-F]{64}$/);
const evmAddress = z.string().regex(/^0x[0-9a-fA-F]{40}$/);

export const BRIDGE_KINDS = ['deposit', 'withdraw'] as const;
export type BridgeKind = (typeof BRIDGE_KINDS)[number];

// ── The EVM transaction the MPC signs ─────────────────────────────────────────

/** The EIP-1559 fields of the transaction the MPC signs, as decimal strings (what the device signs). */
export const EvmTxParamsSchema = z
  .object({
    nonce: decimal,
    gasLimit: decimal,
    maxFeePerGas: decimal,
    maxPriorityFeePerGas: decimal,
    /** Selects the MPC root key; 1 today. */
    keyVersion: decimal,
  })
  .strict();
export type EvmTxParamsJson = z.infer<typeof EvmTxParamsSchema>;

export interface EvmGasPolicy {
  gasLimit: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  keyVersion: bigint;
}

/** AA 00037's proven values, used by every G-BRIDGE transaction: 100,000 gas at 10 gwei (1 gwei tip). */
export const DEFAULT_EVM_GAS: Readonly<EvmGasPolicy> = Object.freeze({
  gasLimit: 100_000n,
  maxFeePerGas: 10_000_000_000n,
  maxPriorityFeePerGas: 1_000_000_000n,
  keyVersion: 1n,
});

/** The most the MPC-signed transaction can cost its sender: gasLimit × maxFeePerGas. */
export const maxGasCostWei = (g: Pick<EvmGasPolicy, 'gasLimit' | 'maxFeePerGas'>): bigint =>
  g.gasLimit * g.maxFeePerGas;

export function evmTxParamsJson(gas: EvmGasPolicy, nonce: bigint): EvmTxParamsJson {
  return {
    nonce: nonce.toString(10),
    gasLimit: gas.gasLimit.toString(10),
    maxFeePerGas: gas.maxFeePerGas.toString(10),
    maxPriorityFeePerGas: gas.maxPriorityFeePerGas.toString(10),
    keyVersion: gas.keyVersion.toString(10),
  };
}

/** True when the signed gas fields are exactly the policy's (the nonce is checked separately). */
export function matchesGasPolicy(evm: EvmTxParamsJson, gas: EvmGasPolicy): boolean {
  return (
    BigInt(evm.gasLimit) === gas.gasLimit &&
    BigInt(evm.maxFeePerGas) === gas.maxFeePerGas &&
    BigInt(evm.maxPriorityFeePerGas) === gas.maxPriorityFeePerGas &&
    BigInt(evm.keyVersion) === gas.keyVersion
  );
}

// ── Action bodies ─────────────────────────────────────────────────────────────

/** `bridge_deposit_start_with_evm`: sweep `amount` of `erc20` from the account's deposit address. */
export const BridgeDepositPayloadSchema = z
  .object({
    erc20: evmAddress,
    amount: decimal,
    /** The sweep's fields; `nonce` is the deposit address's own transaction count (quoted). */
    evm: EvmTxParamsSchema,
    /** The auth nonce the signed challenge binds. */
    authNonce: decimal,
  })
  .strict();
export type BridgeDepositPayload = z.infer<typeof BridgeDepositPayloadSchema>;

/** `bridge_withdraw_start_with_evm`: hand ONE coin (the browser's choice, Q9) to the vault, which
 *  asks the MPC to transfer `amount` of `erc20` to `dest` from the vault's own EVM account. */
export const BridgeWithdrawPayloadSchema = z
  .object({
    dest: evmAddress,
    /** The bridged colour, which must be the vault's colour for `erc20`. */
    color: hex32,
    erc20: evmAddress,
    amount: decimal,
    coin: QualifiedCoinSchema,
    /** The transfer's fields; `nonce` is the vault EVM account's transaction count (quoted). */
    evm: EvmTxParamsSchema,
    authNonce: decimal,
  })
  .strict();
export type BridgeWithdrawPayload = z.infer<typeof BridgeWithdrawPayloadSchema>;

/** Resume a request that was started, by its vault request id (after the relay restarted). The
 *  relay needs nothing else: the settles are permissionless and pinned to the account. */
export const BridgeResumePayloadSchema = z
  .object({
    kind: z.enum(BRIDGE_KINDS),
    /** The vault's request id (the id the MPC answers under), 64 hex. */
    requestId: z.string().regex(/^[0-9a-f]{64}$/),
    /** When the start transaction landed (ms), for the signature budget. */
    startedAtMs: decimal.optional(),
  })
  .strict();
export type BridgeResumePayload = z.infer<typeof BridgeResumePayloadSchema>;

// ── The quote (GET /v1/bridge/quote) ──────────────────────────────────────────

export const BridgeQuoteSchema = z.object({
  kind: z.enum(BRIDGE_KINDS),
  account: z.string().regex(/^[0-9a-f]{64}$/),
  /** Who pays the MPC-signed transaction's gas: the deposit address, or the vault's EVM account. */
  payer: evmAddress,
  vaultEvmAddress: evmAddress,
  erc20: evmAddress.nullable(),
  /** The fields to sign, with the nonce the relay reserves for this request. */
  evm: EvmTxParamsSchema,
  maxGasCostWei: decimal,
  /** What the payer holds now, or null when the relay could not read Sepolia. */
  payerEthWei: decimal.nullable(),
  payerErc20: decimal.nullable(),
  /** Requests ahead in the lane this one would join. */
  lane: z.object({ running: z.number().int().nonnegative(), waiting: z.number().int().nonnegative() }),
  /** Requests of this path still open in the vault (a deposit left unfinished must be resumed first). */
  openInVault: z.number().int().nonnegative(),
  /** The open requests that belong to THIS account (deposit: its path; withdrawal: its refund
   *  recipient), so the page can resume one whose start landed while the relay was restarting. */
  accountOpen: z.array(z.string().regex(/^[0-9a-f]{64}$/)),
});
export type BridgeQuote = z.infer<typeof BridgeQuoteSchema>;

// ── Results and stages ────────────────────────────────────────────────────────

export type AttestedKind = 'success' | 'returned-false' | 'never-executed';

export interface BridgeCoinJson {
  nonce: string;
  color: string;
  value: string;
}

/** A bridge job's public outcome. */
export interface BridgeResult {
  kind: BridgeKind;
  account: string;
  /** The vault request id. */
  requestId: string;
  startTx: string | null;
  /** What the MPC attested about the Sepolia transaction. */
  attested: AttestedKind;
  evmTxHash: string | null;
  settleTx: string;
  /** The circuit that closed the request. `abandonDeposit` (the vault's, called directly) closes a
   *  deposit whose sweep never executed on Sepolia: nothing is minted, the tokens stay at the
   *  deposit address, and the account can deposit again (plan P4-A, Q21 A). */
  settleCircuit: 'bridge_deposit_complete' | 'bridge_withdraw_complete' | 'bridge_withdraw_refund' | 'abandonDeposit';
  /** The coin the settle minted to the account (a deposit, or a withdrawal's refund); null if none. */
  coin: BridgeCoinJson | null;
  /** A withdrawal's change, returned by the start (192 zero bytes in its inbox entry: Q13). */
  change: BridgeCoinJson | null;
  /** True when the settle's inbox entry describes the minted coin. */
  entryMatchesCoin: boolean;
  /** The single-use entitlement to file the change's inbox entry (security review F-B3). */
  changeEntitlement?: string;
  /** The same for the minted coin, when the settle's entry does not describe it. */
  coinEntitlement?: string;
  /** `relay` when the bank closed a request its owner had left open (a stale request, Q21 A); the
   *  settles are permissionless and pinned to the account, so the outcome is the same either way. */
  closedBy?: 'owner' | 'relay';
}

/** GET /v1/bridge/closed/:requestId — how a request this relay closed recently ended (plan P4-A),
 *  so a page whose job was lost (a relay restart, or the bank closed it as stale) can finish its
 *  record without a signature. Keyed by the PUBLIC vault request id, so it carries only facts the
 *  chain shows anyway, and no coin: the page finds a minted coin with its own inbox walk. Kept in
 *  memory for the job TTL. */
export interface BridgeClosedResponse {
  requestId: string;
  kind: BridgeKind;
  /** Unix seconds. */
  closedAt: number;
  closedBy: 'owner' | 'relay';
  attested: AttestedKind;
  settleCircuit: BridgeResult['settleCircuit'];
  settleTx: string;
  evmTxHash: string | null;
  /** Whether the settle minted a coin to the account (a deposit, or a refund). */
  minted: boolean;
}

export const BridgeClosedResponseSchema = z.object({
  requestId: z.string().regex(/^[0-9a-f]{64}$/),
  kind: z.enum(BRIDGE_KINDS),
  closedAt: z.number().int(),
  closedBy: z.enum(['owner', 'relay']),
  attested: z.enum(['success', 'returned-false', 'never-executed']),
  settleCircuit: z.enum([
    'bridge_deposit_complete',
    'bridge_withdraw_complete',
    'bridge_withdraw_refund',
    'abandonDeposit',
  ]),
  settleTx: z.string(),
  evmTxHash: z.string().nullable(),
  minted: z.boolean(),
});

/** The stage ids a bridge job reports, in order (each with public details only). */
export const BRIDGE_STAGES = [
  'preflight',
  'waiting-for-prover',
  'proving',
  'starting',
  'started',
  'resumed',
  'mpc-signed',
  'evm-broadcast',
  'evm-not-broadcast',
  'evm-final',
  'attested',
  'settling',
  'settled',
  'abandoning',
  'abandoned',
  /** A resume found the bank already completing this request, and waited for that run. */
  'joined',
  /** A resume found the request already closed by the bank (a stale request, Q21 A). */
  'already-closed',
] as const;
export type BridgeStage = (typeof BRIDGE_STAGES)[number];

/** Error codes a bridge job fails with (shown to the customer with their message). */
export const BRIDGE_ERRORS = {
  preflight: 'preflight-refused',
  staleNonce: 'stale-evm-nonce',
  openRequest: 'request-still-open',
  gasPolicy: 'gas-policy',
  unknownToken: 'unknown-token',
  mpcTimeout: 'mpc-timeout',
  attestationTimeout: 'attestation-timeout',
  requestMatch: 'request-match',
  notOpen: 'request-not-open',
  inProgress: 'already-in-progress',
  /** The bank's budget for closing other customers' stale requests is used up for now (Q21 A). */
  closeBudget: 'close-budget',
} as const;

// ── Preflights ────────────────────────────────────────────────────────────────

/**
 * The deposit preflight with requests already queued on the same deposit address: each queued
 * sweep will move its own amount of its own token and may cost its own gas, so this request only
 * passes when the address holds enough for every earlier one AND this one. With nothing queued it
 * is exactly the vault v0.3.0 preflight (`depositPreflight`).
 */
export function queuedDepositPreflight(input: {
  erc20Balance: bigint;
  ethBalance: bigint;
  amount: bigint;
  gas: Pick<EvmGasPolicy, 'gasLimit' | 'maxFeePerGas'>;
  decimals?: number;
  /** Earlier sweeps of the SAME token from this address that have not happened yet. */
  aheadSameToken?: bigint;
  /** How many earlier sweeps (any token) have not been broadcast yet. */
  aheadSweeps?: number;
}): DepositPreflightResult {
  const ahead = input.aheadSameToken ?? 0n;
  const sweeps = BigInt(input.aheadSweeps ?? 0);
  const perSweep = maxGasCostWei(input.gas);
  return depositPreflight({
    erc20Balance: input.erc20Balance > ahead ? input.erc20Balance - ahead : 0n,
    amount: input.amount,
    ethBalance: input.ethBalance > perSweep * sweeps ? input.ethBalance - perSweep * sweeps : 0n,
    gasLimit: input.gas.gasLimit,
    maxFeePerGas: input.gas.maxFeePerGas,
    ...(input.decimals === undefined ? {} : { decimals: input.decimals }),
  });
}

export interface WithdrawPreflightResult {
  ok: boolean;
  problems: string[];
  maxGasCostWei: bigint;
}

/**
 * Before a withdrawal is signed (spec US6 scenario 1): the vault's EVM account must hold the gas
 * the transfer may cost, and the ERC20 it will pay out.
 */
export function withdrawPreflight(input: {
  vaultEthWei: bigint;
  vaultErc20: bigint | null;
  amount: bigint;
  gas: Pick<EvmGasPolicy, 'gasLimit' | 'maxFeePerGas'>;
}): WithdrawPreflightResult {
  const cost = maxGasCostWei(input.gas);
  const problems: string[] = [];
  if (input.amount <= 0n) problems.push('the amount must be positive');
  if (input.vaultEthWei < cost) {
    problems.push(
      `the bank's Sepolia vault account holds ${input.vaultEthWei.toString()} wei of gas but the transfer may cost up to ${cost.toString()} wei; it must be topped up first`,
    );
  }
  if (input.vaultErc20 !== null && input.vaultErc20 < input.amount) {
    problems.push(
      `the bank's Sepolia vault account holds ${input.vaultErc20.toString()} of this token, less than the ${input.amount.toString()} to pay out`,
    );
  }
  return { ok: problems.length === 0, problems, maxGasCostWei: cost };
}
