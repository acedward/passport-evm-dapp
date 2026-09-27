// Publishing an account's offer on the exchange (`POST /v1/offers`, `{"offer": "swapoffer1…"}`) and
// reading an offer back, through the shared kernel client (@mnbank/core).
//
// A freshly proven offer spends a coin against the newest Merkle root the indexer served, and the
// kernel may not have synced that root yet: it answers `ROOT_UNKNOWN`. That one refusal is waited
// out (the G-TAKE gate's rule, 10 s apart); every other refusal is final and returned as is.

import { KernelClient, decodeOffer, type KernelOfferStatus, type PostOfferAnswer } from '@mnbank/core';

export interface PublishOptions {
  kernelUrl: string;
  attempts?: number;
  retryDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  fetchImpl?: typeof fetch;
}

const client = (o: { kernelUrl: string; fetchImpl?: typeof fetch }) =>
  new KernelClient({
    baseUrl: o.kernelUrl,
    ...(o.fetchImpl ? { fetch: (url, init) => o.fetchImpl!(url, init) } : {}),
    retries: 2,
    timeoutMs: 20_000,
  });

export async function publishOffer(blob: string, o: PublishOptions): Promise<PostOfferAnswer & { attempts: number }> {
  const kernel = client(o);
  const attempts = o.attempts ?? 12;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let attempt = 1; ; attempt++) {
    const answer = await kernel.postOffer(blob);
    if (answer.accepted || answer.code !== 'ROOT_UNKNOWN' || attempt >= attempts)
      return { ...answer, attempts: attempt };
    await sleep(o.retryDelayMs ?? 10_000);
  }
}

/** The offer's status on the exchange, polled until it is one of `want` or the time runs out. */
export async function waitOfferStatus(
  offerId: string,
  want: readonly KernelOfferStatus[],
  o: PublishOptions & { timeoutMs?: number; pollMs?: number },
): Promise<KernelOfferStatus> {
  const kernel = client(o);
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = Date.now() + (o.timeoutMs ?? 60_000);
  for (;;) {
    let status: KernelOfferStatus = 'unknown';
    try {
      status = await kernel.offerStatus(offerId);
    } catch {
      /* a transient failure counts as unknown */
    }
    if (want.includes(status) || Date.now() >= deadline) return status;
    await sleep(o.pollMs ?? 4_000);
  }
}

/** The raw bytes of a live offer on the exchange, and its status; null when the kernel has none. */
export async function fetchOfferBytes(
  offerId: string,
  o: { kernelUrl: string; fetchImpl?: typeof fetch },
): Promise<{ bytes: Uint8Array; status: string | null } | null> {
  const detail = await client(o).offer(offerId);
  if (!detail) return null;
  return { bytes: decodeOffer(detail.offerBech32), status: detail.computed.status };
}
