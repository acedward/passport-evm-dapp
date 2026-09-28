// The @sig-net/midnight 0.23.0 exports the relay's bridge code needs, reached by file path.
//
// ADAPTED from acedward/passport @ 51c1fb4ad164af034c8ed60fbb047e43cdd509f5 (identical at 07d8ea4)
// `contract/contracts/erc20-vault/src/signet-sdk.ts`. Upstream re-exports the package's dist files
// by the relative path `../node_modules/@sig-net/midnight/dist/*.js`, because the package root
// cannot load on compact-runtime 0.19.0 (its generated module pins 0.18.0-rc.1) and its `exports`
// map hides dist/*. That path only resolves inside the vault package's own install. This shim does
// the same through THIS repository's hoisted root install (bunfig.toml), which pins the same
// 0.23.0 (bun.lock), and exports only what relayer.ts (vendored beside it) and the relay's bridge
// module use. It never re-exports `pureCircuits` (upstream's recompile of the SDK's circuits):
// nothing here needs it. Client-only shim under Q12 option C / Q18.
//
// These dist modules import only @noble/curves, ethers, @sig-net/midnight-serde, compact-runtime's
// plain helpers and each other; none imports a generated contract module (upstream Q25).

export { serializeRespondOutput } from '../../../../node_modules/@sig-net/midnight/dist/abi-serde.js';
export {
  MPC_FAILURE_OUTPUT,
  getMpcOutputCacheUrl,
  getMpcRootPublicKey,
  getSignetContractAddress,
} from '../../../../node_modules/@sig-net/midnight/dist/constants.js';
export { deriveMidnightResponseKey } from '../../../../node_modules/@sig-net/midnight/dist/epsilon-derivation.js';
export { MpcOutputCacheReader } from '../../../../node_modules/@sig-net/midnight/dist/mpc-output-cache.js';
export { signetEventSourceFromIndexer } from '../../../../node_modules/@sig-net/midnight/dist/signet-contract-events.js';
export { SignetRequestResponseReader } from '../../../../node_modules/@sig-net/midnight/dist/signet-request-response-reader.js';
export {
  requestIdBytes,
  toSignBidirectionalEventIndex,
} from '../../../../node_modules/@sig-net/midnight/dist/signet-requests.js';
export {
  normaliseSecp256k1PublicKey,
  respondBidirectionalEventToCircuitInput,
  verifyRespondBidirectionalSignature,
} from '../../../../node_modules/@sig-net/midnight/dist/ecdsa-attestation.js';

/** The @sig-net/midnight version these paths were checked against. */
export const SIG_NET_MIDNIGHT_VERSION = '0.23.0';
