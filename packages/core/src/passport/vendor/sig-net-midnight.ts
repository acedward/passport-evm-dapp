// The four @sig-net/midnight 0.23.0 exports the deposit-address derivation needs, reached by
// file path because the package's `exports` map hides dist/* and its root entry cannot load on
// compact-runtime 0.19.0 (see ./signet-derive.ts). The same technique as upstream
// erc20-vault/src/signet-sdk.ts, pointed at this repository's hoisted root install.
//
// These dist modules import only @noble/curves, ethers, compact-runtime's plain helpers and
// each other; none imports a generated contract module (upstream signet-sdk.ts, Q25).

export { bytesToHex } from '../../../../../node_modules/@sig-net/midnight/dist/byte-codecs.js';
export { deriveEvmAddress } from '../../../../../node_modules/@sig-net/midnight/dist/epsilon-derivation.js';
export { normaliseSecp256k1PublicKey } from '../../../../../node_modules/@sig-net/midnight/dist/ecdsa-attestation.js';
export { getMpcRootPublicKey } from '../../../../../node_modules/@sig-net/midnight/dist/constants.js';

/** The @sig-net/midnight version the file paths above were checked against. */
export const SIG_NET_MIDNIGHT_VERSION = '0.23.0';
