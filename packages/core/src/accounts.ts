// The wire contract of the account routes (plan L-ACC): the public reads the relay serves about
// an account, and the bodies and results of the account actions (register, withdraw,
// append-inbox). The browser and the relay both import these.
//
// Everything here is PUBLIC chain data or a call's own arguments. The account's encryption
// secret never appears: the browser decrypts the inbox itself (Q5).

import { z } from 'zod';

const hex = (bytes: number) => z.string().regex(new RegExp(`^(0x)?[0-9a-fA-F]{${bytes * 2}}$`));
const hex32 = hex(32);
const decimal = z.string().regex(/^[0-9]{1,40}$/);

// ── Reads ─────────────────────────────────────────────────────────────────────

export const AccountStateViewSchema = z.object({
  account: z.string().regex(/^[0-9a-f]{64}$/),
  booted: z.boolean(),
  deviceCount: z.number().int().nonnegative(),
  /** The current device epoch (device entries are derived under it). */
  deviceEpoch: decimal,
  /** Every live device entry (64 hex). A device's use counter is found by matching its entry. */
  devices: z.array(z.string().regex(/^[0-9a-f]{64}$/)),
  /** The nonce the next gated call's challenge binds. */
  authNonce: decimal,
  inboxCount: decimal,
  /** The account's encryption PUBLIC key (X25519, 64 hex). */
  encKey: z.string().regex(/^[0-9a-f]{64}$/),
  /** The vault sealed at construction (64 hex; all zero for none). */
  vault: z.string().regex(/^[0-9a-f]{64}$/),
  /** The EIP-712 domain salt sealed at construction (64 hex). */
  evmDomainSalt: z.string().regex(/^[0-9a-f]{64}$/),
});
export type AccountStateView = z.infer<typeof AccountStateViewSchema>;

export const InboxPageSchema = z.object({
  account: z.string(),
  from: z.number().int().nonnegative(),
  /** 192-byte entries as hex, in inbox order from `from`; null where an index is empty. */
  entries: z.array(
    z
      .string()
      .regex(/^[0-9a-f]{384}$/)
      .nullable(),
  ),
  total: z.number().int().nonnegative(),
});
export type InboxPage = z.infer<typeof InboxPageSchema>;

export const OwnedOutputSchema = z.object({
  commitment: z.string().regex(/^[0-9a-f]{64}$/),
  mtIndex: decimal,
  txHash: z.string(),
  blockHeight: z.number().int().nonnegative(),
});
export const OwnedInputSchema = z.object({
  nullifier: z.string().regex(/^[0-9a-f]{64}$/),
  txHash: z.string(),
  blockHeight: z.number().int().nonnegative(),
});

/** Every Zswap leaf the ledger inserted for coins the account owns, and every nullifier it spent. */
export const ZswapActivitySchema = z.object({
  account: z.string(),
  outputs: z.array(OwnedOutputSchema),
  inputs: z.array(OwnedInputSchema),
  /** How many of the account's transactions were read. */
  transactions: z.number().int().nonnegative(),
  /** The newest block the answer covers. */
  blockHeight: z.number().int().nonnegative(),
});
export type ZswapActivity = z.infer<typeof ZswapActivitySchema>;

// ── Action bodies ─────────────────────────────────────────────────────────────

export const RegisterPayloadSchema = z
  .object({
    /** The account's encryption PUBLIC key (X25519, 32 bytes). The secret never leaves the browser. */
    encPublicKey: hex32,
  })
  .strict();
export type RegisterPayload = z.infer<typeof RegisterPayloadSchema>;

/** A gated call's own Passport authorisation: the wallet's signature over the call's EIP-712
 *  digest, and the device's use counter (the rolling entry the call consumes, AUTH-9). The
 *  relay recomputes the digest from the call's arguments and the account's state, and recovers
 *  the device's public point from this signature. */
export const PassportAuthSchema = z
  .object({
    /** The device (the connected EOA) the call is signed by; the typed data names it. */
    owner: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
    signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/),
    useCounter: decimal,
  })
  .strict();
export type PassportAuth = z.infer<typeof PassportAuthSchema>;

export const QualifiedCoinSchema = z.object({ nonce: hex32, color: hex32, value: decimal, mtIndex: decimal }).strict();

/** `withdraw_shielded_with_evm`: pay `amount` of `color` from ONE coin (the browser's choice,
 *  L-ACC.5) to a shielded wallet (its coin public key, plus its encryption public key so the
 *  wallet can see the coin: midnight-js refuses a recipient it cannot seal to, upstream Q42). */
export const WithdrawPayloadSchema = z
  .object({
    recipient: hex32,
    /** The recipient wallet's encryption public key (from its shielded address), so the coin's
     *  ciphertext is sealed to it; omitted only when paying the relay's own wallet. */
    recipientEncryptionKey: hex32.optional(),
    color: hex32,
    amount: decimal,
    /** The coin spent, exactly as the challenge binds it (the call's private state). */
    coin: QualifiedCoinSchema,
    /** The auth nonce the signed challenge binds. */
    authNonce: decimal,
  })
  .strict();
export type WithdrawPayload = z.infer<typeof WithdrawPayloadSchema>;

/** `append_inbox_with_evm`: file one 192-byte inbox entry (Q13: a withdrawal's change). */
export const AppendInboxPayloadSchema = z
  .object({
    entry: hex(192),
    authNonce: decimal,
  })
  .strict();
export type AppendInboxPayload = z.infer<typeof AppendInboxPayloadSchema>;

// ── Results (the job's public outcome) ────────────────────────────────────────

export interface RegisterResult {
  account: string;
  /** The device (the EOA), lowercase 0x hex. */
  device: string;
  txs: { waveOne: string; waveTwo: string; activation: string };
  seconds: { waveOne: number; waveTwo: number; activation: number; total: number };
}

export interface WithdrawResult {
  txId: string;
  /** The change coin the circuit returned (it has no inbox entry yet: Q13). */
  change: { nonce: string; color: string; value: string } | null;
}

export interface AppendInboxResult {
  txId: string;
}
