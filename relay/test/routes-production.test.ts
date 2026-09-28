// Plan P4-A, route tests: auth and rate limits on EVERY state-changing route, with the catalogue
// the relay really runs (main.ts: register, the gated account calls, the bridge, trading), not the
// P1 stubs. For each route: an unsigned call, a wrong signer, an expired authorisation, a replay,
// and an unknown nonce are all refused BEFORE any work (no job queued, no sponsor wallet opened, no
// bridge call); the per-client and per-owner rate limits apply; a sponsor that is low refuses
// before any authorisation is used up. Read routes leak nothing secret.
//
// Two authorisations exist (relay/src/auth/verifiers.ts):
//   relay-action   register, bridge-resume: a RelayAction signature with a relay-issued nonce;
//   passport-call  withdraw, append-inbox, bridge-deposit, bridge-withdraw, open-swap, take: the
//                  call's own Passport signature; its "nonce" is the account's on-chain auth nonce.

import { type BaseWallet, Wallet } from 'ethers';
import { describe, expect, it } from 'vitest';

import {
  API_PATHS,
  DEFAULT_EVM_GAS,
  RELAY_ACTIONS,
  RELAY_ACTION_TYPES,
  buildRelayActionMessage,
  evmTxParamsJson,
  registryFromConfig,
  relayDomain,
  type AppendInboxPayload,
  type BridgeDepositPayload,
  type BridgeWithdrawPayload,
  type HealthResponse,
  type OpenSwapPayload,
  type RelayActionName,
  type TakePayload,
  type WithdrawPayload,
} from '@mnbank/core';
import {
  appendInboxRequest,
  bridgeDepositStartRequest,
  bridgeWithdrawStartRequest,
  evmDeviceEntry,
  gatedCall,
  openSwapGatedCall,
  withdrawRequest,
} from '@mnbank/core/passport';

import { accountCatalogue, withBridge, withTrade } from '../src/actions/catalogue.js';
import { createApp } from '../src/app.js';
import { NonceStore } from '../src/auth/nonces.js';
import { passportCallAuthoriser } from '../src/auth/passport-call.js';
import { DigestReplayGuard } from '../src/auth/verifiers.js';
import { BridgeService } from '../src/bridge/service.js';
import { deviceChecker, gatedStartVerifier } from '../src/bridge/wiring.js';
import { notImplementedChainReader } from '../src/chain/reader.js';
import { healthCollector, httpProbes } from '../src/health.js';
import { loadConfig } from '../src/config.js';
import type { AccountLedger, PassportRuntime } from '../src/passport/runtime.js';
import { ProofServerClient } from '../src/prover/client.js';
import { JobQueue } from '../src/queue/jobs.js';
import type { SponsorStatus } from '../src/sponsor/session.js';
import { COLOUR_A, FakeBridge, STKA, VAULT } from './bridge-fake.js';
import { FakeSponsor, LOCAL_TOKENS, silentLog, testEntitlements } from './harness.js';

const ACCOUNT = '5e'.repeat(32);
const SALT = '9a'.repeat(32);
const AUTH_NONCE = 3n;
const unhex = (h: string) => Uint8Array.from(Buffer.from(h, 'hex'));

type Kind = 'relay-action' | 'passport-call';
const KIND: Record<RelayActionName, Kind> = {
  register: 'relay-action',
  'bridge-resume': 'relay-action',
  withdraw: 'passport-call',
  'append-inbox': 'passport-call',
  'bridge-deposit': 'passport-call',
  'bridge-withdraw': 'passport-call',
  'open-swap': 'passport-call',
  take: 'passport-call',
};

/** A sponsor that records every time a job borrows its wallet (that would be work). */
class CountingSponsor extends FakeSponsor {
  walletCalls = 0;
  override async withWallet<T>(fn: (w: unknown) => Promise<T>): Promise<T> {
    this.walletCalls++;
    return fn({ fake: true });
  }
}

/** The account the device owns: booted, one live `evm` device at use counter 0, auth nonce 3. */
function fakeRuntime(device: string): PassportRuntime & { reads: number } {
  const live = new Set([evmDeviceEntry(ACCOUNT, device, 0n, 0n)]);
  const ledger: AccountLedger = {
    booted: true,
    device_count: 1n,
    device_epoch: 0n,
    auth_nonce: AUTH_NONCE,
    inbox_count: 0n,
    enc_key: new Uint8Array(32),
    evm_domain_salt: unhex(SALT),
    vault_address: { bytes: unhex(VAULT) },
    devices: {
      member: (e: Uint8Array) => live.has(Buffer.from(e).toString('hex')),
      [Symbol.iterator]: () => [...live].map(unhex)[Symbol.iterator](),
    },
    inbox: { member: () => false, lookup: () => new Uint8Array(192) },
  };
  const rt = {
    reads: 0,
    ledgerState: async (a: string) => {
      rt.reads++;
      return a === ACCOUNT ? ledger : null;
    },
  };
  return rt as unknown as PassportRuntime & { reads: number };
}

const tokens = registryFromConfig('undeployed', {
  tokens: [
    { symbol: 'USDC', midnightName: 'wUSDC', role: 'usdc', decimals: 6, midnightColour: 'b2'.repeat(32), vault: VAULT },
    {
      symbol: 'stkA',
      midnightName: 'wStkA',
      role: 'stock',
      decimals: 6,
      midnightColour: COLOUR_A,
      sepoliaAddress: STKA,
      vault: VAULT,
    },
  ],
});

/** The relay as main.ts wires it, with fakes at the edges (runtime, sponsor, bridge backend). */
function productionRelay(
  opts: { env?: Record<string, string>; sponsor?: CountingSponsor; appendsPerDay?: number } = {},
) {
  const device = Wallet.createRandom();
  const config = loadConfig({ RELAY_NETWORK: 'undeployed', TOKENS_FILE: '/t', ...opts.env }, () =>
    JSON.stringify(LOCAL_TOKENS),
  ).config;
  const log = silentLog();
  const rt = fakeRuntime(device.address);
  const sponsor = opts.sponsor ?? new CountingSponsor();
  const replay = new DigestReplayGuard(config.limits.authMaxTtlSeconds * 6);
  const nonces = new NonceStore(config.limits.nonceTtlSeconds, config.limits.maxNonces);
  const queue = new JobQueue({ ttlSeconds: config.limits.jobTtlSeconds, maxJobs: config.limits.maxJobs, log });
  const fake = new FakeBridge();
  const entitlements = testEntitlements({ maxPerAccountPerDay: opts.appendsPerDay ?? 20 });
  const bridge = new BridgeService({
    backend: () => fake,
    laneLoad: (lane, account) => queue.laneLoad(lane, account),
    gas: DEFAULT_EVM_GAS,
    tokens,
    vaultAddress: VAULT,
    verifyStart: gatedStartVerifier(() => rt),
    releaseDigest: (d) => replay.release(d),
    isDevice: deviceChecker(() => rt),
    log,
  });
  const catalogue = withTrade(
    withBridge(
      accountCatalogue({
        runtime: () => rt,
        sponsor,
        vaultAddress: VAULT,
        network: 'undeployed',
        chainId: 11155111,
        replay,
        entitlements,
        log,
      }),
      bridge,
    ),
    { runtime: () => rt, sponsor, kernelUrl: 'http://kernel.test', batcherUrl: 'http://batcher.test', replay, log },
  );
  const health = async (): Promise<HealthResponse> => {
    throw new Error('not used here');
  };
  const app = createApp({
    config,
    version: 'test',
    log,
    nonces,
    queue,
    catalogue,
    sponsor,
    health,
    chain: notImplementedChainReader,
    bridge,
    passportCall: passportCallAuthoriser(() => rt, replay),
    clientAddress: () => '198.51.100.7',
  });
  // Hold every lane with a job that never ends, so an accepted call stays QUEUED: it has done no
  // work, and its authorisation stays claimed (the replay test needs that).
  const hold = () => new Promise<Record<string, unknown>>(() => {});
  queue.submit({ action: 'register', lane: 'prover', payload: {}, executor: hold });
  queue.submit({ action: 'bridge-withdraw', lane: 'withdrawal', payload: {}, executor: hold });
  queue.submit({ action: 'bridge-deposit', lane: 'deposit', account: ACCOUNT, payload: {}, executor: hold });
  const HELD = 3;
  return {
    app,
    config,
    device,
    rt,
    sponsor,
    fake,
    queue,
    nonces,
    log,
    catalogue,
    entitlements,
    queued: () => queue.stats().jobs - HELD,
  };
}
type Relay = ReturnType<typeof productionRelay>;

const evm = evmTxParamsJson(DEFAULT_EVM_GAS, 0n);
/** A valid body for each action, before its authorisation; `n` varies it (a distinct call). */
function payloadFor(action: RelayActionName, n = 0, authNonce = AUTH_NONCE): Record<string, unknown> {
  const a = String(authNonce);
  const amount = String(1_000_000 + n);
  switch (action) {
    case 'register':
      return { encPublicKey: (n % 2 ? 'cd' : 'ab').repeat(32) };
    case 'bridge-resume':
      return { kind: 'deposit', requestId: (n % 2 ? 'ef' : 'ab').repeat(32) };
    case 'withdraw':
      return {
        recipient: '11'.repeat(32),
        color: COLOUR_A,
        amount,
        coin: { nonce: '33'.repeat(32), color: COLOUR_A, value: '5000000', mtIndex: '42' },
        authNonce: a,
      } satisfies WithdrawPayload;
    case 'append-inbox':
      return { entry: (0xcd + (n % 16)).toString(16).repeat(192), authNonce: a } satisfies AppendInboxPayload;
    case 'bridge-deposit':
      return { erc20: STKA, amount, evm, authNonce: a } satisfies BridgeDepositPayload;
    case 'bridge-withdraw':
      return {
        dest: '0x484738A67858305Edfc139B194Ed430Fe4D8e56b',
        color: COLOUR_A,
        erc20: STKA,
        amount,
        coin: { nonce: '0e'.repeat(32), color: COLOUR_A, value: '2000000', mtIndex: '7' },
        evm,
        authNonce: a,
      } satisfies BridgeWithdrawPayload;
    case 'open-swap':
    case 'take': {
      const make: OpenSwapPayload = {
        giveColor: COLOUR_A,
        giveAmount: amount,
        wantColor: 'b2'.repeat(32),
        wantAmount: '2100000',
        wantNonce: '11'.repeat(32),
        wantEntry: '22'.repeat(192),
        changeEntry: '00'.repeat(192),
        validUntil: '0',
        coin: { nonce: '33'.repeat(32), color: COLOUR_A, value: '3000000', mtIndex: '9' },
        authNonce: a,
      };
      return action === 'take' ? ({ ...make, offerId: 'cd'.repeat(32) } satisfies TakePayload) : make;
    }
  }
}

async function signPassport(
  action: RelayActionName,
  payload: Record<string, unknown>,
  w: BaseWallet,
  authNonce: bigint,
) {
  const ctx = { account: ACCOUNT, authNonce, evmDomainSalt: SALT };
  const call =
    action === 'open-swap' || action === 'take'
      ? openSwapGatedCall(ctx, w.address, payload as unknown as OpenSwapPayload)
      : gatedCall(
          ctx,
          w.address,
          action === 'withdraw'
            ? withdrawRequest(payload as unknown as WithdrawPayload)
            : action === 'append-inbox'
              ? appendInboxRequest(payload as unknown as AppendInboxPayload)
              : action === 'bridge-deposit'
                ? bridgeDepositStartRequest(payload as unknown as BridgeDepositPayload)
                : bridgeWithdrawStartRequest(payload as unknown as BridgeWithdrawPayload),
        );
  const { EIP712Domain: _d, ...types } = call.typedData.types as Record<string, never>;
  return w.signTypedData(call.typedData.domain as never, types, call.typedData.message as never);
}

interface Tamper {
  /** Who signs (default: the account's device). */
  signer?: BaseWallet;
  /** The owner the authorisation names (default: the signer). */
  owner?: string;
  /** relay-action: a nonce of our choosing; passport-call: the auth nonce signed and sent. */
  nonce?: string | bigint;
  /** relay-action: the expiry. */
  expiry?: number;
  n?: number;
  /** append-inbox: the entitlement sent (default: a fresh valid one; null: none). */
  entitlement?: string | null;
}

/** A body for `action`, signed as the route requires (or broken as `t` says). */
async function body(r: Relay, action: RelayActionName, t: Tamper = {}) {
  const signer = t.signer ?? r.device;
  const account = action === 'register' ? undefined : ACCOUNT;
  if (KIND[action] === 'relay-action') {
    const payload = payloadFor(action, t.n);
    const nonce =
      typeof t.nonce === 'string'
        ? t.nonce
        : ((await (await r.app.request(API_PATHS.nonce)).json()) as { nonce: string }).nonce;
    const message = buildRelayActionMessage({
      action,
      network: r.config.network.name,
      owner: t.owner ?? signer.address,
      account,
      payload,
      nonce,
      expiry: t.expiry ?? Math.floor(Date.now() / 1000) + 120,
    });
    const signature = await signer.signTypedData(relayDomain(), RELAY_ACTION_TYPES, message);
    return { ...(account ? { account } : {}), payload, auth: { message, signature } };
  }
  const authNonce = typeof t.nonce === 'bigint' ? t.nonce : AUTH_NONCE;
  const payload = payloadFor(action, t.n, authNonce);
  // An append is sponsored only against the bank's entitlement for a change (F-B3); it is not signed.
  if (action === 'append-inbox' && t.entitlement !== null)
    payload.entitlement = t.entitlement ?? r.entitlements.issue(ACCOUNT, `withdraw:test-${t.n ?? 0}`);
  const signature = await signPassport(action, payload, signer, authNonce);
  return { account, payload, passportAuth: { owner: t.owner ?? signer.address, signature, useCounter: '0' } };
}

const post = (r: Relay, action: string, b: unknown) =>
  r.app.request(`/v1/actions/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(b),
  });

async function refused(r: Relay, res: Response, status: number, detail?: string) {
  expect(res.status).toBe(status);
  const b = (await res.json()) as { error: { code: string; detail?: string } };
  if (detail) expect(b.error.detail).toBe(detail);
  // Before any work: nothing queued, the sponsor wallet never opened, the bridge never called.
  expect(r.queued()).toBe(0);
  expect(r.sponsor.walletCalls).toBe(0);
  expect(r.fake.calls).toEqual([]);
  return b;
}

describe('the production catalogue', () => {
  it('authorises each action the way the relay runs it', () => {
    const r = productionRelay();
    for (const a of RELAY_ACTIONS) expect([a, r.catalogue.get(a)!.auth]).toEqual([a, KIND[a]]);
  });
});

describe.each(RELAY_ACTIONS)('POST /v1/actions/%s (production catalogue)', (action) => {
  const kind = KIND[action];

  it('accepts a correct call, and queues exactly one job', async () => {
    const r = productionRelay();
    const res = await post(r, action, await body(r, action));
    expect(res.status).toBe(202);
    expect(r.queued()).toBe(1);
  });

  it('refuses an unsigned call before any work', async () => {
    const r = productionRelay();
    const b = await body(r, action);
    const { auth: _a, passportAuth: _p, ...unsigned } = b as Record<string, unknown>;
    await refused(r, await post(r, action, unsigned), 401, 'malformed');
  });

  it('refuses a call signed by someone who is not the owner, or not a device of the account', async () => {
    const r = productionRelay();
    const stranger = Wallet.createRandom();
    // Signed by a stranger in the device's name.
    await refused(
      r,
      await post(r, action, await body(r, action, { signer: stranger, owner: r.device.address })),
      401,
      'wrong-signer',
    );
    if (kind === 'passport-call' || action === 'bridge-resume') {
      // Signed by a stranger in their own name: not a device of this account. A resume is refused
      // at admission too (security review F-B2), so it never takes a queue slot.
      await refused(r, await post(r, action, await body(r, action, { signer: stranger })), 401, 'wrong-signer');
    }
  });

  it('refuses an expired authorisation', async () => {
    const r = productionRelay();
    const b =
      kind === 'relay-action'
        ? await body(r, action, { expiry: Math.floor(Date.now() / 1000) - 5 })
        : await body(r, action, { nonce: AUTH_NONCE - 1n }); // signed for an older account state
    await refused(r, await post(r, action, b), 401, 'expired');
  });

  it('refuses an unknown nonce', async () => {
    const r = productionRelay();
    const b =
      kind === 'relay-action'
        ? await body(r, action, { nonce: `0x${'42'.repeat(32)}` }) // never issued by this relay
        : await body(r, action, { nonce: AUTH_NONCE + 7n }); // not the account's auth nonce
    await refused(r, await post(r, action, b), 401, kind === 'relay-action' ? 'unknown-nonce' : 'expired');
  });

  it('refuses a replay, queuing nothing more', async () => {
    const r = productionRelay();
    const b = await body(r, action);
    expect((await post(r, action, b)).status).toBe(202);
    const res = await post(r, action, b);
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: { detail: string } }).error.detail).toBe('replayed');
    expect(r.queued()).toBe(1);
  });

  it('rate-limits per client address, before looking at the authorisation', async () => {
    const r = productionRelay({ env: { RATE_LIMIT_ACTIONS_PER_MIN: '2' } });
    const statuses: number[] = [];
    for (let i = 0; i < 3; i++) statuses.push((await post(r, action, { payload: {} })).status);
    expect(statuses).toEqual([400, 400, 429]);
    const res = await post(r, action, await body(r, action));
    expect(res.status).toBe(429);
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(r.queued()).toBe(0);
  });

  it('rate-limits per owner, and a call refused that way can be sent again later', async () => {
    const r = productionRelay({ env: { RATE_LIMIT_ACTIONS_PER_OWNER_PER_MIN: '1' } });
    expect((await post(r, action, await body(r, action, { n: 0 }))).status).toBe(202);
    const second = await body(r, action, { n: 1 });
    const res = await post(r, action, second);
    expect(res.status).toBe(429);
    expect(r.queued()).toBe(1);
    if (kind === 'passport-call') {
      // The digest was released: after the window, the SAME signature is not a "replay".
      const later = await post(r, action, second);
      expect([429]).toContain(later.status); // still inside the window here
      expect(((await later.json()) as { error: { code: string } }).error.code).toBe('rate-limited');
    }
  });

  it('refuses while the sponsor is low, before any authorisation is used up', async () => {
    const sponsor = new CountingSponsor({
      configured: true,
      state: 'synced',
      synced: true,
      dustSpecks: 1n,
    } as SponsorStatus);
    const r = productionRelay({ sponsor });
    const b = await body(r, action);
    const res = await post(r, action, b);
    const e = await refused(r, res, 503);
    expect(e.error.code).toBe('sponsor-low');
    sponsor.current = { ...sponsor.current, dustSpecks: 10n ** 20n };
    expect((await post(r, action, b)).status).toBe(202); // the same authorisation still works
  });
});

describe('a withdrawal to a wallet binds its encryption key (security review F-B6)', () => {
  const KEY = '55'.repeat(32);
  /** A withdraw to a wallet: the Passport call (which cannot cover the key) and, optionally, a
   *  RelayAction envelope over the whole body by `envelopeSigner`, for `signedKey`. */
  async function withdrawTo(
    r: Relay,
    opts: { sentKey?: string; signedKey?: string; envelopeSigner?: BaseWallet | null } = {},
  ) {
    const b = await body(r, 'withdraw');
    const signedPayload = { ...b.payload, recipientEncryptionKey: opts.signedKey ?? KEY };
    const payload = { ...b.payload, recipientEncryptionKey: opts.sentKey ?? opts.signedKey ?? KEY };
    const envelopeSigner = opts.envelopeSigner === undefined ? r.device : opts.envelopeSigner;
    if (!envelopeSigner) return { ...b, payload };
    const nonce = ((await (await r.app.request(API_PATHS.nonce)).json()) as { nonce: string }).nonce;
    const message = buildRelayActionMessage({
      action: 'withdraw',
      network: r.config.network.name,
      owner: envelopeSigner.address,
      account: ACCOUNT,
      payload: signedPayload,
      nonce,
      expiry: Math.floor(Date.now() / 1000) + 120,
    });
    const signature = await envelopeSigner.signTypedData(relayDomain(), RELAY_ACTION_TYPES, message);
    return { ...b, payload, auth: { message, signature } };
  }

  it('accepts the call with an envelope over the whole body, by the same device', async () => {
    const r = productionRelay();
    expect((await post(r, 'withdraw', await withdrawTo(r))).status).toBe(202);
    expect(r.queued()).toBe(1);
  });

  it('refuses a changed encryption key after signing, a missing envelope, or another signer, before any work', async () => {
    let r = productionRelay();
    await refused(
      r,
      await post(r, 'withdraw', await withdrawTo(r, { sentKey: '66'.repeat(32) })),
      401,
      'payload-mismatch',
    );
    r = productionRelay();
    await refused(r, await post(r, 'withdraw', await withdrawTo(r, { envelopeSigner: null })), 401, 'malformed');
    r = productionRelay();
    await refused(
      r,
      await post(r, 'withdraw', await withdrawTo(r, { envelopeSigner: Wallet.createRandom() })),
      401,
      'wrong-signer',
    );
    // The Passport signature was given back each time: the honest call still goes through.
    expect((await post(r, 'withdraw', await withdrawTo(r))).status).toBe(202);
  });
});

describe('append-inbox entitlements (security review F-B3)', () => {
  const code = async (res: Response) => ((await res.json()) as { error: { code: string } }).error.code;

  it('refuses an append without a valid entitlement before any proof or spend', async () => {
    const r = productionRelay();
    // none
    let e = await refused(r, await post(r, 'append-inbox', await body(r, 'append-inbox', { entitlement: null })), 403);
    expect(e.error.code).toBe('no-entitlement');
    // forged: right shape, wrong MAC
    const forged = r.entitlements.issue(ACCOUNT, 'withdraw:x').replace(/[0-9a-f]{64}$/, '0'.repeat(64));
    e = await refused(
      r,
      await post(r, 'append-inbox', await body(r, 'append-inbox', { entitlement: forged, n: 1 })),
      403,
    );
    expect(e.error.code).toBe('no-entitlement');
    // another account's
    const theirs = r.entitlements.issue('77'.repeat(32), 'withdraw:y');
    e = await refused(
      r,
      await post(r, 'append-inbox', await body(r, 'append-inbox', { entitlement: theirs, n: 2 })),
      403,
    );
    expect((e.error as { message?: string }).message).toContain('another account');
    // issued by another relay (another key)
    const other = testEntitlements({ key: new Uint8Array(32).fill(9) }).issue(ACCOUNT, 'withdraw:z');
    e = await refused(
      r,
      await post(r, 'append-inbox', await body(r, 'append-inbox', { entitlement: other, n: 3 })),
      403,
    );
    expect(e.error.code).toBe('no-entitlement');
    expect(r.rt.reads).toBeGreaterThan(0); // the signature was checked; only then the entitlement
  });

  it('accepts a valid entitlement once: a second append with it is refused', async () => {
    const r = productionRelay();
    const token = r.entitlements.issue(ACCOUNT, 'withdraw:tx-1');
    expect((await post(r, 'append-inbox', await body(r, 'append-inbox', { entitlement: token, n: 0 }))).status).toBe(
      202,
    );
    // Another entry (a new signature), the same entitlement: refused while the first is queued …
    const again = await post(r, 'append-inbox', await body(r, 'append-inbox', { entitlement: token, n: 1 }));
    expect(again.status).toBe(403);
    expect(await code(again)).toBe('no-entitlement');
    // … and for good once the first landed.
    r.entitlements.spend(token);
    const later = await post(r, 'append-inbox', await body(r, 'append-inbox', { entitlement: token, n: 2 }));
    expect(later.status).toBe(403);
    expect(r.queued()).toBe(1);
  });

  it('caps appends per account per day as a backstop', async () => {
    const r = productionRelay({ appendsPerDay: 2 });
    const statuses: number[] = [];
    for (let n = 0; n < 3; n++)
      statuses.push((await post(r, 'append-inbox', await body(r, 'append-inbox', { n }))).status);
    expect(statuses).toEqual([202, 202, 429]);
    expect(r.queued()).toBe(2);
  });
});

describe('bridge-resume admission (security review F-B2)', () => {
  it("refuses strangers' resumes before the queue, so they cannot fill it, and the owner's still queues", async () => {
    const r = productionRelay({
      env: { JOB_MAX: '10', RATE_LIMIT_ACTIONS_PER_MIN: '1000', RATE_LIMIT_ACTIONS_PER_OWNER_PER_MIN: '1000' },
    });
    const statuses: number[] = [];
    for (let i = 0; i < 25; i++) {
      const stranger = Wallet.createRandom();
      statuses.push(
        (await post(r, 'bridge-resume', await body(r, 'bridge-resume', { signer: stranger, n: i }))).status,
      );
    }
    expect(new Set(statuses)).toEqual(new Set([401]));
    expect(r.queue.stats().jobs).toBe(3); // only the three lane holders
    expect(r.fake.calls).toEqual([]);
    expect((await post(r, 'bridge-resume', await body(r, 'bridge-resume'))).status).toBe(202);
  });

  it('answers 503 and keeps nothing when the account cannot be read at admission', async () => {
    const r = productionRelay();
    (r.rt as unknown as { ledgerState: () => Promise<never> }).ledgerState = async () => {
      throw new Error('indexer down');
    };
    const res = await post(r, 'bridge-resume', await body(r, 'bridge-resume'));
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('chain-unavailable');
    expect(r.queued()).toBe(0);
  });
});

describe('read routes leak nothing secret', () => {
  it('health, config, nonces, jobs, queue, quotes and closed requests carry no secret and no job input', async () => {
    const seed = 'fa'.repeat(32);
    const rpc = 'https://sepolia.example.test/v3/0123456789abcdef0123456789abcdef';
    const files: Record<string, string> = {
      '/t': JSON.stringify(LOCAL_TOKENS),
      '/seed': `SEED=${seed}\n`,
      '/rpc': rpc,
    };
    const { config, secrets } = loadConfig(
      { RELAY_NETWORK: 'undeployed', TOKENS_FILE: '/t', SPONSOR_SEED_FILE: '/seed', SEPOLIA_RPC_URL_FILE: '/rpc' },
      (p) => files[p]!,
    );
    expect(secrets.sponsorSeedHex).toBe(seed);
    const r = productionRelay();
    // A real health collector whose Sepolia probe holds the keyed RPC URL.
    const fetched: string[] = [];
    const health = healthCollector({
      network: config.network.name,
      version: 'test',
      startedAt: 0,
      sponsor: r.sponsor,
      dustLowSpecks: config.sponsor.dustLowSpecks,
      prover: new ProofServerClient('http://prover.test', '9.0.0-rc.6', (async () => {
        throw new TypeError('down');
      }) as unknown as typeof fetch),
      keys: () => ({
        present: false,
        fingerprint: null,
        pinned: false,
        matchesPin: null,
        missingProverKeys: [],
        missingVerifierKeys: [],
        missingZkir: [],
        mismatchedVerifierKeys: [],
      }),
      queue: r.queue,
      probes: httpProbes({
        kernelUrl: 'http://kernel.test',
        batcherUrl: 'http://batcher.test',
        vaultEvmAddress: '0x648216975e722494bFF92E88FFc68C8F8d438FaA',
        sepoliaRpcUrl: secrets.sepoliaRpcUrl,
        log: r.log,
        fetchImpl: (async (u: string | URL) => {
          fetched.push(String(u));
          return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x1' }));
        }) as unknown as typeof fetch,
      }),
      vaultEvmAddress: '0x648216975e722494bFF92E88FFc68C8F8d438FaA',
      vaultGasLowWei: 1n,
      cacheSeconds: 0,
    });
    const h = await health();
    expect(fetched).toContain(rpc); // the probe used the secret...
    // ...and the answer does not carry it.
    const texts: string[] = [JSON.stringify(h)];

    // A job carrying a coin and a signature: its view shows neither.
    const b = await body(r, 'withdraw');
    const posted = (await (await post(r, 'withdraw', b)).json()) as { job: { requestId: string } };
    for (const path of [
      '/v1/config',
      API_PATHS.nonce,
      API_PATHS.queue,
      API_PATHS.job(posted.job.requestId),
      `/v1/bridge/quote?kind=deposit&account=${ACCOUNT}&erc20=${STKA}`,
      `/v1/bridge/closed/${'ab'.repeat(32)}`,
    ]) {
      const res = await r.app.request(path);
      expect(res.status, path).toBeLessThan(500);
      texts.push(await res.text());
    }
    const all = texts.join('\n');
    for (const secret of [seed, rpc, new URL(rpc).pathname, '0123456789abcdef0123456789abcdef']) {
      expect(all).not.toContain(secret);
    }
    const signature = (b.passportAuth as { signature: string }).signature;
    for (const input of [signature.slice(2), '33'.repeat(32), 'passportAuth', '"payload"', '"auth"']) {
      expect(all).not.toContain(input);
    }
    // The log never saw the body either.
    expect(r.log.lines.join('\n')).not.toContain(signature.slice(2));
  });
});
