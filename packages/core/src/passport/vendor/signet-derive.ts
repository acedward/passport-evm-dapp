// VENDORED from acedward/passport @ 51c1fb4ad164af034c8ed60fbb047e43cdd509f5
//   contract/contracts/erc20-vault/src/index.ts (the recipient shapes, ledger paths and the
//   deposit/vault address derivation; verbatim) and contract/contracts/erc20-vault/src/signet-sdk.ts
//   (only the four @sig-net/midnight 0.23.0 exports the derivation needs).
//
// WHY: upstream signet-sdk.ts imports @sig-net/midnight by the relative path
// `../node_modules/@sig-net/midnight/dist/*.js`, because the package root cannot load on
// compact-runtime 0.19.0 (its generated module pins 0.18.0-rc.1) and the package's `exports`
// map hides dist/*. That path only resolves inside the vault package's own install (plan 00039
// P0.4). Client-only shim under questions Q12 (option C allowed for shims) and Q18 (option B).
//
// CHANGES from upstream, and nothing else:
//   - @sig-net/midnight's dist files are imported through THIS repository's root install
//     (bunfig.toml keeps node_modules hoisted), and only the four the derivation needs;
//   - the compiled Erc20Vault module comes from the light compile in the submodule's
//     contracts/managed/ (scripts/compile-contracts.sh), the same tree the account links to;
//   - index.ts's `export * from ../managed/Erc20Vault/contract/index.js` is not repeated.
//
// DROP this file when upstream gives the vault package a browser-safe derivation entry (the Q18
// request). packages/core/test/vendored-vs-upstream.test.ts compares it with upstream on Node,
// and packages/core/test/passport-vectors.test.ts re-derives AA 00037's deposit address.

import { bytesToHex, deriveEvmAddress } from './sig-net-midnight.js';
import { pureCircuits } from '../../../../../vendor/passport/contract/contracts/managed/Erc20Vault/contract/index.js';

export { getMpcRootPublicKey, normaliseSecp256k1PublicKey } from './sig-net-midnight.js';

// ── upstream erc20-vault/src/index.ts, verbatim from here ────────────────────

/** `Either<ZswapCoinPublicKey, ContractAddress>` as the generated code shapes it. */
export interface EitherRecipient {
  readonly is_left: boolean;
  readonly left: { readonly bytes: Uint8Array };
  readonly right: { readonly bytes: Uint8Array };
}

const ZERO32 = (): Uint8Array => new Uint8Array(32);

/** `left(coinPublicKey)` — a wallet recipient. */
export const walletRecipient = (coinPublicKeyBytes: Uint8Array): EitherRecipient => ({
  is_left: true,
  left: { bytes: coinPublicKeyBytes },
  right: { bytes: ZERO32() },
});

/**
 * `right(contractAddress)` — a contract recipient.
 *
 * This is the ONLY recipient shape that works when the vault runs as the callee of a
 * cross-contract call, and then only when the address is the CALLING contract: a callee's
 * shielded output is refused by the node (ledger error 213) unless the transaction root
 * claims it. See question Q21b.
 */
export const contractRecipient = (contractAddressBytes: Uint8Array): EitherRecipient => ({
  is_left: false,
  left: { bytes: ZERO32() },
  right: { bytes: contractAddressBytes },
});

// ---- Ledger-tree paths --------------------------------------------------------------
//
// THIS contract's signet ledger layout. The notification a request circuit packs names the
// ledger-tree path of the map the request was written into, so each index below is part of
// the wire contract with the MPC. The fork declares 11 ledger fields — under the 15 at
// which compactc chunks the state tree — so every path is FLAT: one element, depth 1.
// The compiler records each field's path as its "index" in
// managed/Erc20Vault/compiler/contract-info.json, and tests/ledger-paths.test.ts asserts
// these constants against it. Never hand-derive one.

/** Resolved ledger-tree path of `depositEventMap` (ledger field 0). */
export const VAULT_DEPOSIT_REQUESTS_PATH: readonly number[] = [0];

/** Resolved ledger-tree path of `withdrawEventMap` (ledger field 2). */
export const VAULT_WITHDRAW_REQUESTS_PATH: readonly number[] = [2];

/** Resolved ledger-tree path of `signetRequestNonce` (ledger field 6). */
export const VAULT_NONCE_PATH: readonly number[] = [6];

/** The depth every notification packs, one per flat path element. */
export const VAULT_REQUESTS_PATH_DEPTH = 1;

// ---- MPC key derivation -------------------------------------------------------------

/**
 * The 32-byte MPC derivation path of a deposit for `recipient`, read from the COMPILED
 * pure circuit so no TypeScript re-implementation of the hash can drift from it.
 */
export const depositPathBytes = (recipient: EitherRecipient): Uint8Array =>
  pureCircuits.depositPath(recipient as Parameters<typeof pureCircuits.depositPath>[0]);

/**
 * Derive the EVM address a depositor must fund for `recipient`:
 * `f(MPC public key, this vault's contract address, hex(depositPath(recipient)))`.
 *
 * The MPC renders a record's path as the lowercase hex of all 32 bytes, padding included,
 * and `deriveEvmAddress` takes the same rendering — deriving with any other rendering
 * yields an account the MPC will never sign from.
 */
export function deriveDepositEvmAddress(
  mpcSecp256k1PublicKey: string,
  vaultContractAddress: string,
  recipient: EitherRecipient,
): string {
  return deriveEvmAddress(
    mpcSecp256k1PublicKey,
    vaultContractAddress,
    bytesToHex(depositPathBytes(recipient)),
  );
}

/** The vault's own derivation path as the ledger stores it: `pad(32, "vault")`. */
export const vaultPathBytes = (): Uint8Array => pureCircuits.vaultPath();

/** Hex rendering of {@link vaultPathBytes}, as `deriveEvmAddress` takes it. */
export const vaultPathHex = (): string => bytesToHex(vaultPathBytes());

/**
 * Derive the EVM account the MPC signs the vault's own transactions from — the address
 * every deposit lands on and every withdraw is paid out of. It needs gas ETH before any
 * withdrawal can execute.
 */
export function deriveVaultEvmAddress(
  mpcSecp256k1PublicKey: string,
  vaultContractAddress: string,
): string {
  return deriveEvmAddress(mpcSecp256k1PublicKey, vaultContractAddress, vaultPathHex());
}
