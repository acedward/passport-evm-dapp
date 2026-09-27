// The Passport client surface the BROWSER uses, imported module by module from the pinned
// submodule (vendor/passport = acedward/passport @ 51c1fb4, questions Q12 option A).
//
// Never import the package root or its `./browser` entry here: the root pulls in modules that
// cannot load in a browser, and `./browser` drags in ledger-v9 (+10 MB of WASM). The set below
// is the one plan P0.4 proved byte-identical in Chromium, Node and Bun.
//
// Two pieces are vendored shims (Q18 option B), because their upstream modules cannot load in a
// browser: the OpenSwapShielded codec (./vendor/offer-codec.ts) and the deposit-address
// derivation (./vendor/signet-derive.ts). Each carries its upstream source and commit.
//
// Needs the light compile first (`bun run contracts`): contract.ts imports the generated account
// module from the submodule's git-ignored contracts/managed/.

export {
  generateEncKeyPairPortable,
  sealEntryPortable,
  openEntryPortable,
  inboxWalkPortable,
} from '../../../../vendor/passport/contract/src/wallet/deposit.js';
export {
  ENTRY_SIZE,
  ENTRY_VERSION,
  ENTRY_SUITE,
  type PlainCoin,
} from '../../../../vendor/passport/contract/src/wallet/entry-format.js';
export {
  DOMAIN_NAME as PASSPORT_DOMAIN_NAME,
  DOMAIN_VERSION as PASSPORT_DOMAIN_VERSION,
  buildTypedData,
  computeDigest,
  evmDomainSaltFor,
  type EvmOp,
  type TypedDataV4,
} from '../../../../vendor/passport/contract/src/wallet/eip712.js';
export {
  EvmDevice,
  eip191Digest,
  eip1193Backend,
  evmChallengeFor,
  evmTypedMessage,
  type AuthRequest,
  type CallContext,
  type Eip1193Provider,
  type EvmAuthorisation,
  type EvmSigningBackend,
} from '../../../../vendor/passport/contract/src/wallet/signer.js';
export {
  recoverPoint,
  parseSignature,
  ethereumAddress,
  pointFromUncompressed,
  type EvmPoint,
} from '../../../../vendor/passport/contract/src/wallet/evm-signature.js';
export {
  pureCircuits,
  type QualifiedCoin,
  type ShieldedCoin,
} from '../../../../vendor/passport/contract/src/wallet/contract.js';

export * from './vendor/offer-codec.js';
export * from './vendor/signet-derive.js';

/** The upstream commit the client code above comes from. */
export const PASSPORT_CLIENT_COMMIT = '51c1fb4ad164af034c8ed60fbb047e43cdd509f5';
