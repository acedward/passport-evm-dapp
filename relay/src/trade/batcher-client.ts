// Submitting a proven settlement to the kernel's batcher, target `midnight-balancer`, which adds the
// DUST and submits (plan finding 12). The body is the zswap SPA's, byte for byte
// (midnight-2-offers `images/offerfiles-kernel/runner/spa-roundtrip.ts`):
//
//   POST {batcher}/send-input
//   { data: { address, addressType: 5, input: JSON.stringify({ tx: <hex>, txStage: "finalized" }),
//             timestamp, target: "midnight-balancer" },
//     confirmationLevel: "wait-receipt", timeoutMs }
//
// Only PROVEN transactions go here: the batcher's own proof server cannot prove Passport circuits.
// Inputs are capped at 500,000 characters by the batcher.

/** The 32-byte Midnight address type in the batcher's input envelope. */
export const MIDNIGHT_ADDRESS_TYPE = 5;
export const BALANCER_TARGET = 'midnight-balancer';
export const MAX_INPUT_CHARS = 500_000;

export interface BatcherSubmission {
  batcherUrl: string;
  txHex: string;
  /** The submitter's unshielded address (bech32m), as the SPA sends it. */
  address: string;
  target?: string;
  timeoutMs?: number;
  now?: () => Date;
  fetchImpl?: typeof fetch;
}

export interface BatcherResult {
  /** True only when the batcher says the settlement succeeded. */
  ok: boolean;
  httpStatus: number;
  transactionHash?: string;
  /** The batcher's answer, as returned (public data only). */
  body: unknown;
  /** The error text, when there is one. */
  error?: string;
  inputChars: number;
}

export function batcherBody(s: BatcherSubmission): { body: Record<string, unknown>; inputChars: number } {
  const hex = s.txHex.replace(/^0x/, '').toLowerCase();
  if (!/^[0-9a-f]+$/.test(hex) || hex.length % 2 !== 0) throw new Error('the settlement is not hex');
  const input = JSON.stringify({ tx: hex, txStage: 'finalized' });
  if (input.length > MAX_INPUT_CHARS) {
    throw new Error(`the settlement is ${input.length} characters; the batcher takes at most ${MAX_INPUT_CHARS}`);
  }
  return {
    inputChars: input.length,
    body: {
      data: {
        address: s.address,
        addressType: MIDNIGHT_ADDRESS_TYPE,
        input,
        timestamp: (s.now ?? (() => new Date()))().toISOString(),
        target: s.target ?? BALANCER_TARGET,
      },
      confirmationLevel: 'wait-receipt',
      timeoutMs: s.timeoutMs ?? 600_000,
    },
  };
}

const errorOf = (body: unknown): string | undefined => {
  if (!body || typeof body !== 'object') return typeof body === 'string' && body ? body : undefined;
  const b = body as Record<string, unknown>;
  const e = b.error ?? b.message ?? b.reason;
  return e === undefined ? undefined : typeof e === 'string' ? e : JSON.stringify(e);
};

export async function submitToBatcher(s: BatcherSubmission): Promise<BatcherResult> {
  const { body, inputChars } = batcherBody(s);
  const f = s.fetchImpl ?? fetch;
  const res = await f(`${s.batcherUrl.replace(/\/+$/, '')}/send-input`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout((s.timeoutMs ?? 600_000) + 30_000),
  });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* a plain-text answer is kept as text */
  }
  const b = (parsed && typeof parsed === 'object' ? parsed : {}) as Record<string, unknown>;
  const ok = res.ok && b.success === true;
  const hash = b.transactionHash ?? b.txHash;
  return {
    ok,
    httpStatus: res.status,
    ...(typeof hash === 'string' && hash ? { transactionHash: hash } : {}),
    body: parsed,
    ...(ok ? {} : { error: errorOf(parsed) ?? `HTTP ${res.status}` }),
    inputChars,
  };
}
