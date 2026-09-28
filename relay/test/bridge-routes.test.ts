// The bridge's routes: the quote (a read) and the three actions (every one refuses unsigned calls;
// the two starts accept only their own Passport signature).

import { describe, expect, it } from 'vitest';
import { BridgeQuoteSchema, DEFAULT_EVM_GAS, registryFromConfig } from '@mnbank/core';

import { defaultCatalogue, withBridge } from '../src/actions/catalogue.js';
import { passportCallAuthoriser } from '../src/auth/passport-call.js';
import { DigestReplayGuard } from '../src/auth/verifiers.js';
import { BridgeService } from '../src/bridge/service.js';
import { JobQueue } from '../src/queue/jobs.js';
import { COLOUR_A, FakeBridge, STKA, VAULT } from './bridge-fake.js';
import { ACCOUNT, harness, newWallet, post, signedBody, silentLog } from './harness.js';

const tokens = registryFromConfig('undeployed', {
  tokens: [
    { symbol: 'USDC', midnightName: 'wUSDC', role: 'usdc', decimals: 6, midnightColour: 'c1'.repeat(32), vault: VAULT },
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

function service(fake: FakeBridge | null) {
  const log = silentLog();
  const queue = new JobQueue({ ttlSeconds: 60, maxJobs: 10, log });
  return new BridgeService({
    backend: () => fake,
    laneLoad: (l, a) => queue.laneLoad(l, a),
    gas: DEFAULT_EVM_GAS,
    tokens,
    vaultAddress: VAULT,
    verifyStart: {
      deposit: async () => {
        throw new Error('not used');
      },
      withdraw: async () => {
        throw new Error('not used');
      },
    },
    releaseDigest: () => {},
    log,
  });
}

describe('GET /v1/bridge/quote', () => {
  it('returns the fields to sign, with the reserved nonce', async () => {
    const fake = new FakeBridge();
    fake.setNonce(fake.depositAddress(ACCOUNT), 4n);
    const h = harness({ bridge: service(fake) });
    const res = await h.app.request(`/v1/bridge/quote?kind=deposit&account=${ACCOUNT}&erc20=${STKA}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const q = BridgeQuoteSchema.parse(await res.json());
    expect(q.evm.nonce).toBe('4');
    expect(q.payer).toBe(fake.depositAddress(ACCOUNT));
  });

  it('refuses bad arguments, an unbridged token, and answers 503 without a bridge', async () => {
    const h = harness({ bridge: service(new FakeBridge()) });
    expect((await h.app.request(`/v1/bridge/quote?kind=swap&account=${ACCOUNT}`)).status).toBe(400);
    expect((await h.app.request(`/v1/bridge/quote?kind=deposit&account=12`)).status).toBe(400);
    expect((await h.app.request(`/v1/bridge/quote?kind=deposit&account=${ACCOUNT}&erc20=nope`)).status).toBe(400);
    const unbridged = await h.app.request(
      `/v1/bridge/quote?kind=deposit&account=${ACCOUNT}&erc20=0x000000000000000000000000000000000000dEaD`,
    );
    expect(unbridged.status).toBe(400);
    expect(((await unbridged.json()) as { error: { code: string } }).error.code).toBe('unknown-token');
    expect((await harness().app.request(`/v1/bridge/quote?kind=deposit&account=${ACCOUNT}`)).status).toBe(503);
    expect(
      (await harness({ bridge: service(null) }).app.request(`/v1/bridge/quote?kind=withdraw&account=${ACCOUNT}`))
        .status,
    ).toBe(503);
  });
});

describe('the bridge actions', () => {
  const bridged = () => {
    const replay = new DigestReplayGuard(600);
    return harness({
      catalogue: withBridge(defaultCatalogue(), service(new FakeBridge())),
      passportCall: passportCallAuthoriser(() => null, replay),
    });
  };

  it.each(['bridge-deposit', 'bridge-withdraw'])('%s accepts only the start own Passport signature', async (action) => {
    const h = bridged();
    const evm = {
      nonce: '0',
      gasLimit: '100000',
      maxFeePerGas: '10000000000',
      maxPriorityFeePerGas: '1000000000',
      keyVersion: '1',
    };
    const payload =
      action === 'bridge-deposit'
        ? { erc20: STKA, amount: '1000000', evm, authNonce: '0' }
        : {
            dest: '0x484738A67858305Edfc139B194Ed430Fe4D8e56b',
            color: COLOUR_A,
            erc20: STKA,
            amount: '1000000',
            coin: { nonce: '0e'.repeat(32), color: COLOUR_A, value: '1000000', mtIndex: '7' },
            evm,
            authNonce: '0',
          };
    // unsigned
    let res = await post(h, action, { account: ACCOUNT, payload });
    expect(res.status).toBe(401);
    // a RelayAction signature is not a Passport call signature
    res = await post(h, action, await signedBody(h, action as never, newWallet(), { payload }));
    expect(res.status).toBe(401);
    expect(h.queue.stats().jobs).toBe(0);
  });

  it('bridge-resume needs a RelayAction signature of the owner, and a well-formed body', async () => {
    const h = bridged();
    const payload = { kind: 'deposit', requestId: 'ab'.repeat(32) };
    expect((await post(h, 'bridge-resume', { account: ACCOUNT, payload })).status).toBe(401);
    const bad = await post(
      h,
      'bridge-resume',
      await signedBody(h, 'bridge-resume', newWallet(), { payload: { kind: 'x' } }),
    );
    expect(bad.status).toBe(400);
    const ok = await post(h, 'bridge-resume', await signedBody(h, 'bridge-resume', newWallet(), { payload }));
    expect(ok.status).toBe(202);
    const { job } = (await ok.json()) as { job: { lane: string } };
    expect(job.lane).toBe('deposit');
  });
});
