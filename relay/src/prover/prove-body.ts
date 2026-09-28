// The proof server's /prove body, laid out by the relay itself so that a proof never holds its
// prover key in memory (plan 00039 P5.1b, question Q25).
//
// The body is the ledger's tagged serialisation of
//   (ProofPreimageVersioned, Option<ProvingKeyMaterial>, Option<Fr>)
// (ledger-wasm 9.1.0.0-rc.3 `createProvingPayload`; proof-server `/prove`). With key material:
//
//   HEAD | 0x01 | len(pk) pk | len(vk) vk | len(ir) ir | TAIL
//   '------- prefix -------'  '------------ suffix ------------'
//
// HEAD is the tag and the preimage, TAIL the binding-input option, `0x01` the `Some` of the key
// material, and each len() the SCALE compact length midnight-serialize writes for a `Vec<u8>`
// (ProvingKeyMaterial's three fields, in declaration order). HEAD and TAIL come from the ledger's
// own `createProvingPayload` called WITHOUT key material (a few kilobytes), so only the layout of
// the key material is ours, and ./proving-provider.ts checks it against the ledger on every proof.
// The prover key itself (up to 570 MB) is streamed from its file between the prefix and the suffix.

/** The ledger's body for a preimage, around the key material. */
export interface ProveBodyFrame {
  head: Uint8Array;
  tail: Uint8Array;
}

/** A body with key material: `prefix | <prover key bytes> | suffix`. */
export interface ProveBodyParts {
  prefix: Uint8Array;
  suffix: Uint8Array;
  /** The whole body's length, prover key included. */
  total: number;
}

/** SCALE compact encoding of a length, as midnight-serialize writes a `Vec`'s u32 length. */
export function compactLength(n: number): Uint8Array {
  if (!Number.isInteger(n) || n < 0 || n > 0xffff_ffff) throw new RangeError(`length out of range: ${n}`);
  if (n < 1 << 6) return Uint8Array.of(n << 2);
  if (n < 1 << 14) {
    const v = (n << 2) | 0b01;
    return Uint8Array.of(v & 0xff, v >>> 8);
  }
  if (n < 1 << 30) {
    const v = ((n << 2) | 0b10) >>> 0;
    return Uint8Array.of(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, v >>> 24);
  }
  // Big-integer mode: the byte count minus 4 in the top six bits, then the value's bytes (LE).
  return Uint8Array.of(0b11, n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, n >>> 24);
}

/**
 * HEAD and TAIL, from the ledger's two key-less bodies for the same preimage: `withBinding` =
 * createProvingPayload(preimage, binding, undefined) = HEAD | 0x00 | TAIL, and `withoutBinding` =
 * createProvingPayload(preimage, undefined, undefined) = HEAD | 0x00 | 0x00. Throws when they do not
 * have that shape.
 */
export function proveBodyFrame(withBinding: Uint8Array, withoutBinding: Uint8Array): ProveBodyFrame {
  const n = withoutBinding.length;
  if (n < 2 || withoutBinding[n - 1] !== 0 || withoutBinding[n - 2] !== 0) {
    throw new Error('the key-less /prove body does not end with two None tags');
  }
  const headLength = n - 2;
  const shared =
    withBinding.length >= headLength + 2 &&
    withBinding[headLength] === 0 &&
    equalBytes(withBinding.subarray(0, headLength), withoutBinding.subarray(0, headLength));
  if (!shared) throw new Error('the key-less /prove body with a binding input does not share the preimage prefix');
  return { head: withBinding.slice(0, headLength), tail: withBinding.slice(headLength + 1) };
}

/** The bytes before and after the prover key, for a key of `proverKeyLength` bytes. */
export function proveBodyParts(
  frame: ProveBodyFrame,
  proverKeyLength: number,
  verifierKey: Uint8Array,
  ir: Uint8Array,
): ProveBodyParts {
  const prefix = concatBytes([frame.head, Uint8Array.of(1), compactLength(proverKeyLength)]);
  const suffix = concatBytes([
    compactLength(verifierKey.length),
    verifierKey,
    compactLength(ir.length),
    ir,
    frame.tail,
  ]);
  return { prefix, suffix, total: prefix.length + proverKeyLength + suffix.length };
}

/** The whole body from in-memory key material (the per-proof layout check and the tests). */
export function assembleProveBody(
  frame: ProveBodyFrame,
  material: { proverKey: Uint8Array; verifierKey: Uint8Array; ir: Uint8Array },
): Uint8Array {
  const { prefix, suffix } = proveBodyParts(frame, material.proverKey.length, material.verifierKey, material.ir);
  return concatBytes([prefix, material.proverKey, suffix]);
}

export function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
