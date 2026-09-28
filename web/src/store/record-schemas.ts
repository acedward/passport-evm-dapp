// The shape of every record kind this page writes (security review F-B4), so an Import accepts
// only records this page could have written itself: every field known and well-typed, nothing
// else, and each record consistent with the key it is filed under (its account, its id). The
// types they mirror live next to the code that writes them (passport/records.ts, bridge/records.ts,
// trade/records.ts, @mnbank/core `StoredCoin`); a change there must be made here too, and the
// store tests import a record of every kind written the way the page writes it.
//
// Addresses, colours, amounts and keys are checked exactly (they decide where money goes); text
// that is only shown (a summary, a message) is bounded in length. React renders it as text.

import { z } from 'zod';

import { APPEND_ENTITLEMENT_PATTERN, encPublicKeyOf } from '@mnbank/core';

import type { ParsedKey, RecordKind } from './schema.js';

const hex32 = z.string().regex(/^[0-9a-f]{64}$/);
const evm = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const decimal = z.string().regex(/^[0-9]{1,40}$/);
const ms = z.number().int().nonnegative();
/** A transaction id or hash as the relay or a wallet reported it (shown, and linked in an explorer
 *  URL path: letters, digits, `-` and `_` only). */
const txId = z.string().regex(/^[0-9A-Za-z_-]{0,200}$/);
const text = (max: number) => z.string().max(max);
const entitlement = z.string().regex(APPEND_ENTITLEMENT_PATTERN);

const coinInfo = z.object({ nonce: hex32, color: hex32, value: decimal }).strict();

const profile = z.object({ firstSeen: ms.optional(), lastSeen: ms.optional() }).strict();

/** Nothing writes a wallet-scoped `settings` record today: accept only a small flat map. */
const settings = z.record(z.string().max(64), z.union([text(256), z.number(), z.boolean(), z.null()]));

const account = z
  .object({
    address: hex32,
    device: evm,
    network: z.string().regex(/^[a-z0-9-]{1,32}$/),
    vault: hex32,
    createdAt: ms,
    txs: z.object({ waveOne: txId, waveTwo: txId, activation: txId }).strict().optional(),
  })
  .strict();

const secret = z.object({ encSecretKey: hex32, encPublicKey: hex32, pending: z.boolean().optional() }).strict();

const storedCoin = z
  .object({
    nonce: hex32,
    color: hex32,
    value: decimal,
    mtIndex: decimal.nullable(),
    commitment: hex32,
    origin: z.enum(['inbox', 'change', 'local']),
    inInbox: z.boolean(),
    inboxIndex: decimal.optional(),
    createdTx: txId.optional(),
    spent: z.boolean(),
    spentTx: txId.optional(),
    appendEntitlement: entitlement.optional(),
  })
  .strict();
// No count bound of its own (security review F-B8): an account's list only grows (spent coins are
// kept, see @mnbank/core `reconcileCoins`), and a bound below what the browser can hold refused
// the page's own exports. The import's size bound, checked before any record is parsed, is the
// limit: it measures what localStorage itself can hold (schema.ts `MAX_IMPORT_FILE_BYTES`).
const coins = z.array(storedCoin);

const roster = z.object({ useCounter: decimal }).strict();

const jobStage = z
  .object({
    stage: text(64),
    at: z.number().int(),
    detail: z.record(text(64), text(512)).optional(),
  })
  .strict();

const bridgeResult = z
  .object({
    kind: z.enum(['deposit', 'withdraw']),
    account: hex32,
    requestId: hex32,
    startTx: txId.nullable(),
    attested: z.enum(['success', 'returned-false', 'never-executed']),
    evmTxHash: txId.nullable(),
    settleTx: txId,
    settleCircuit: z.enum([
      'bridge_deposit_complete',
      'bridge_withdraw_complete',
      'bridge_withdraw_refund',
      'abandonDeposit',
    ]),
    coin: coinInfo.nullable(),
    change: coinInfo.nullable(),
    entryMatchesCoin: z.boolean(),
    changeEntitlement: entitlement.optional(),
    coinEntitlement: entitlement.optional(),
    closedBy: z.enum(['owner', 'relay']).optional(),
  })
  .strict();

const bridge = z
  .object({
    id: z.string().regex(/^[0-9a-f]{16}$/),
    kind: z.enum(['deposit', 'withdraw']),
    account: hex32,
    symbol: text(32),
    midnightName: text(64),
    erc20: evm,
    colour: hex32,
    decimals: z.number().int().min(0).max(36),
    amount: decimal,
    depositAddress: evm.optional(),
    dest: evm.optional(),
    spentCommitment: hex32.optional(),
    createdAt: ms,
    updatedAt: ms,
    state: z.enum(['funding', 'running', 'needs-resume', 'succeeded', 'failed']),
    funding: z.object({ tokenTx: txId.optional(), gasTx: txId.optional() }).strict().optional(),
    jobIds: z.array(z.string().regex(/^[0-9a-f]{32}$/)).max(1_000),
    requestId: hex32.optional(),
    startedAtMs: ms.optional(),
    stages: z.array(jobStage).max(2_000),
    error: z
      .object({ code: text(64), message: text(1_000) })
      .strict()
      .optional(),
    result: bridgeResult.optional(),
    applied: z.boolean().optional(),
    change: z
      .object({
        coin: coinInfo,
        secured: z.boolean(),
        secureTx: txId.optional(),
        deferredReason: text(500).optional(),
        entitlement: entitlement.optional(),
      })
      .strict()
      .optional(),
    closedCheckAt: ms.optional(),
  })
  .strict();

const offer = z
  .object({
    offerId: hex32,
    role: z.enum(['make', 'take']),
    side: z.enum(['buy', 'sell']),
    stock: hex32,
    usdc: hex32,
    stockRaw: decimal,
    usdcRaw: decimal,
    summary: text(200),
    coin: hex32,
    authNonce: decimal,
    wantNonce: hex32,
    createdAt: ms,
    expiresAt: ms,
    status: z.enum(['live', 'filled', 'expired', 'cancelled', 'refused']),
    kernelStatus: text(64).optional(),
    settledTx: txId.optional(),
    checkedAt: ms.optional(),
  })
  .strict();

const job = z
  .object({
    requestId: z.string().regex(/^[0-9a-f]{32}$/),
    action: z.enum(['register', 'withdraw', 'append-inbox', 'open-swap', 'take']),
    startedAt: ms,
    state: z.enum(['queued', 'running', 'succeeded', 'failed']),
    stage: text(64),
    context: z
      .object({ summary: text(200).optional(), spent: hex32.optional(), coin: hex32.optional() })
      .strict()
      .optional(),
  })
  .strict();

export const RECORD_DATA_SCHEMAS: Record<RecordKind, z.ZodType> = {
  profile,
  settings,
  account,
  secret,
  coins,
  roster,
  bridge,
  offer,
  job,
};

/**
 * Why an imported record's data is not one this page writes, or null when it is. Checks its shape
 * for its kind, and that it agrees with the key it is filed under.
 */
export function recordDataProblem(key: ParsedKey, data: unknown): string | null {
  const r = RECORD_DATA_SCHEMAS[key.kind].safeParse(data);
  if (!r.success) return `a ${key.kind} record is not in the shape this page writes`;
  const scopeAccount = key.scope.global ? null : key.scope.account;
  const needsAccount = ['account', 'coins', 'roster', 'bridge', 'offer'].includes(key.kind);
  if (needsAccount && !scopeAccount) return `a ${key.kind} record is not filed under an account`;
  if (['profile'].includes(key.kind) && scopeAccount) return 'a profile record is filed under an account';
  const d = r.data as Record<string, unknown>;
  switch (key.kind) {
    case 'account':
      if (d.address !== scopeAccount) return 'an account record names another account than its key';
      if (!key.scope.global && d.network !== key.scope.network) return 'an account record names another network';
      if (!key.scope.global && String(d.device).toLowerCase() !== key.scope.evmAddress)
        return 'an account record names another device than this wallet';
      break;
    case 'bridge':
      if (d.account !== scopeAccount || d.id !== key.id) return 'a transfer record does not match its key';
      if (d.kind === 'deposit' && d.dest !== undefined) return 'a deposit record names a withdrawal destination';
      if (d.kind === 'withdraw' && d.depositAddress !== undefined) return 'a withdrawal record names a deposit address';
      break;
    case 'offer':
      if (key.id !== `${String(d.role)}-${String(d.offerId)}`) return 'an offer record does not match its key';
      break;
    case 'job':
      if (key.id !== d.requestId) return 'a job record does not match its key';
      break;
    case 'secret':
      // A secret and its public key must be one pair (security review F-B5).
      if (encPublicKeyOf(String(d.encSecretKey)) !== d.encPublicKey)
        return "a secret record's public key is not its secret's";
      break;
  }
  return null;
}
