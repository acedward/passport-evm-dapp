// Plan L-ACC.4 / P1.3: the `passport-call` authorisation. The relay rebuilds the digest from the
// call's arguments and the account's state, recovers the signer, and accepts only a live device
// of that account at the given counter, signing the current auth nonce, once.

import { type BaseWallet, Wallet } from 'ethers';
import { describe, expect, it } from 'vitest';

import {
  RELAY_ACTION_TYPES,
  buildRelayActionMessage,
  relayDomain,
  type AppendInboxPayload,
  type WithdrawPayload,
} from '@mnbank/core';
import { appendInboxRequest, evmDeviceEntry, gatedCall, withdrawRequest } from '@mnbank/core/passport';

import { withdrawExecutor } from '../src/actions/account-actions.js';
import { accountCatalogue } from '../src/actions/catalogue.js';
import { passportCallAuthoriser } from '../src/auth/passport-call.js';
import { DigestReplayGuard } from '../src/auth/verifiers.js';
import { checkGatedCall } from '../src/passport/gated-verify.js';
import { JobQueue } from '../src/queue/jobs.js';
import type { AccountLedger, PassportRuntime } from '../src/passport/runtime.js';
import { FakeSponsor, harness, post, silentLog, testEntitlements } from './harness.js';

const ACCOUNT = '5e'.repeat(32);
const SALT = '9a'.repeat(32);
const unhex = (h: string) => Uint8Array.from(Buffer.from(h, 'hex'));

function fakeRuntime(opts: { owner: string; counter?: bigint; authNonce?: bigint; booted?: boolean }) {
  const live = new Set([evmDeviceEntry(ACCOUNT, opts.owner, 0n, opts.counter ?? 0n)]);
  const ledger: AccountLedger = {
    booted: opts.booted ?? true,
    device_count: 1n,
    device_epoch: 0n,
    auth_nonce: opts.authNonce ?? 3n,
    inbox_count: 0n,
    enc_key: new Uint8Array(32),
    evm_domain_salt: unhex(SALT),
    vault_address: { bytes: new Uint8Array(32) },
    devices: {
      member: (e: Uint8Array) => live.has(Buffer.from(e).toString('hex')),
      [Symbol.iterator]: () => [...live].map(unhex)[Symbol.iterator](),
    },
    inbox: { member: () => false, lookup: () => new Uint8Array(192) },
  };
  return { ledgerState: async () => ledger } as unknown as PassportRuntime;
}

const withdraw: WithdrawPayload = {
  recipient: '11'.repeat(32),
  color: '22'.repeat(32),
  amount: '1500000',
  coin: { nonce: '33'.repeat(32), color: '22'.repeat(32), value: '5000000', mtIndex: '42' },
  authNonce: '3',
};

async function sign(w: BaseWallet, payload: WithdrawPayload | AppendInboxPayload, authNonce = 3n) {
  const req = 'entry' in payload ? appendInboxRequest(payload) : withdrawRequest(payload);
  const call = gatedCall({ account: ACCOUNT, authNonce, evmDomainSalt: SALT }, w.address, req);
  const { EIP712Domain: _d, ...types } = call.typedData.types as Record<string, never>;
  return {
    signature: await w.signTypedData(call.typedData.domain, types, call.typedData.message),
    digest: call.digestHex,
  };
}

describe('checkGatedCall', () => {
  it('accepts the device at its counter, and yields the circuit authorisation', async () => {
    const w = Wallet.createRandom();
    const { signature, digest } = await sign(w, withdraw);
    const r = await checkGatedCall(fakeRuntime({ owner: w.address, counter: 2n }), 'withdraw', ACCOUNT, withdraw, {
      owner: w.address,
      signature,
      useCounter: '2',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.signer).toBe(w.address.toLowerCase());
    expect(r.digestHex).toBe(digest);
    expect(r.auth.use_counter).toBe(2n);
    // The point is the wallet's public key.
    const pub = w.signingKey.publicKey; // 0x04 x y
    expect(r.auth.pk.x).toBe(BigInt(`0x${pub.slice(4, 68)}`));
    expect(r.auth.pk.y).toBe(BigInt(`0x${pub.slice(68)}`));
  });

  it('refuses a signature over other arguments (the relay never trusts a digest)', async () => {
    const w = Wallet.createRandom();
    const { signature } = await sign(w, withdraw);
    const tampered = { ...withdraw, amount: '4999999' };
    const r = await checkGatedCall(fakeRuntime({ owner: w.address }), 'withdraw', ACCOUNT, tampered, {
      owner: w.address,
      signature,
      useCounter: '0',
    });
    expect(r).toMatchObject({ ok: false, code: 'wrong-signer' });
  });

  it('refuses a signer that is not a live device at that counter', async () => {
    const w = Wallet.createRandom();
    const { signature } = await sign(w, withdraw);
    const rt = fakeRuntime({ owner: w.address, counter: 1n });
    expect(
      await checkGatedCall(rt, 'withdraw', ACCOUNT, withdraw, { owner: w.address, signature, useCounter: '0' }),
    ).toMatchObject({
      ok: false,
      code: 'wrong-signer',
    });
    const stranger = Wallet.createRandom();
    const s2 = await sign(stranger, withdraw);
    expect(
      await checkGatedCall(rt, 'withdraw', ACCOUNT, withdraw, {
        owner: stranger.address,
        signature: s2.signature,
        useCounter: '1',
      }),
    ).toMatchObject({ ok: false, code: 'wrong-signer' });
  });

  it('refuses a signature for an older account state, and an inactive account', async () => {
    const w = Wallet.createRandom();
    const { signature } = await sign(w, withdraw);
    expect(
      await checkGatedCall(fakeRuntime({ owner: w.address, authNonce: 4n }), 'withdraw', ACCOUNT, withdraw, {
        owner: w.address,
        signature,
        useCounter: '0',
      }),
    ).toMatchObject({ ok: false, code: 'expired' });
    expect(
      await checkGatedCall(fakeRuntime({ owner: w.address, booted: false }), 'withdraw', ACCOUNT, withdraw, {
        owner: w.address,
        signature,
        useCounter: '0',
      }),
    ).toMatchObject({ ok: false, code: 'wrong-account' });
  });

  it('refuses malformed bodies and authorisations', async () => {
    const w = Wallet.createRandom();
    const rt = fakeRuntime({ owner: w.address });
    const { signature } = await sign(w, withdraw);
    expect(
      await checkGatedCall(
        rt,
        'withdraw',
        ACCOUNT,
        { ...withdraw, amount: '-1' },
        { owner: w.address, signature, useCounter: '0' },
      ),
    ).toMatchObject({ ok: false, code: 'malformed' });
    expect(await checkGatedCall(rt, 'withdraw', ACCOUNT, withdraw, { owner: w.address, signature })).toMatchObject({
      ok: false,
      code: 'malformed',
    });
    expect(
      await checkGatedCall(rt, 'withdraw', undefined, withdraw, { owner: w.address, signature, useCounter: '0' }),
    ).toMatchObject({ ok: false, code: 'malformed' });
  });

  it('checks an AppendInbox call the same way', async () => {
    const w = Wallet.createRandom();
    const body: AppendInboxPayload = { entry: 'cd'.repeat(192), authNonce: '3' };
    const { signature } = await sign(w, body);
    expect(
      await checkGatedCall(fakeRuntime({ owner: w.address }), 'append-inbox', ACCOUNT, body, {
        owner: w.address,
        signature,
        useCounter: '0',
      }),
    ).toMatchObject({ ok: true });
  });
});

/** A sponsor whose wallet is busy for the whole test: a queued job stays running. */
class BusySponsor extends FakeSponsor {
  override async withWallet<T>(): Promise<T> {
    return new Promise<T>(() => {});
  }
}

describe('the passport-call routes (withdraw, append-inbox)', () => {
  const setup = (owner: string) => {
    const rt = fakeRuntime({ owner });
    const replay = new DigestReplayGuard(600);
    const catalogue = accountCatalogue({
      runtime: () => rt,
      sponsor: new BusySponsor(),
      vaultAddress: 'ee'.repeat(32),
      network: 'undeployed',
      chainId: 11155111,
      replay,
      entitlements: testEntitlements(),
      log: silentLog(),
    });
    return {
      h: harness({ catalogue, sponsor: new BusySponsor(), passportCall: passportCallAuthoriser(() => rt, replay) }),
      replay,
    };
  };

  it('queues a correctly signed withdraw once, and refuses its replay while it runs, and an unsigned one', async () => {
    const w = Wallet.createRandom();
    const { h } = setup(w.address);
    const { signature } = await sign(w, withdraw);
    const body = {
      account: ACCOUNT,
      payload: withdraw,
      passportAuth: { owner: w.address, signature, useCounter: '0' },
    };
    expect((await post(h, 'withdraw', body)).status).toBe(202);
    const again = await post(h, 'withdraw', body);
    expect(again.status).toBe(401);
    expect(((await again.json()) as { error: { detail: string } }).error.detail).toBe('replayed');
    const unsigned = await post(h, 'withdraw', { account: ACCOUNT, payload: withdraw });
    expect(unsigned.status).toBe(401);
    // A RelayAction signature is not accepted for a gated call.
    const relayOnly = await post(h, 'withdraw', {
      account: ACCOUNT,
      payload: withdraw,
      auth: { message: {}, signature: '0x' },
    });
    expect([400, 401]).toContain(relayOnly.status);
    expect(h.queue.stats().jobs).toBe(1); // only the first call was queued
  });

  it('releases the digest when the job fails, so the customer can retry the same signature', async () => {
    const w = Wallet.createRandom();
    const rt = fakeRuntime({ owner: w.address });
    const replay = new DigestReplayGuard(600);
    const catalogue = accountCatalogue({
      runtime: () => rt,
      sponsor: new FakeSponsor(), // the fake runtime cannot prove: the job fails at once
      vaultAddress: 'ee'.repeat(32),
      network: 'undeployed',
      chainId: 11155111,
      replay,
      entitlements: testEntitlements(),
      log: silentLog(),
    });
    const h = harness({ catalogue, passportCall: passportCallAuthoriser(() => rt, replay) });
    const { signature } = await sign(w, withdraw);
    const body = {
      account: ACCOUNT,
      payload: withdraw,
      passportAuth: { owner: w.address, signature, useCounter: '0' },
    };
    const first = (await (await post(h, 'withdraw', body)).json()) as { job: { requestId: string } };
    const done = await h.queue.settled(first.job.requestId);
    expect(done?.state).toBe('failed');
    expect(done?.error?.code).toBe('internal-error'); // no internals leak
    expect((await post(h, 'withdraw', body)).status).toBe(202);
  });

  it('an append whose job fails gives its entitlement back, so the customer can retry (F-B3)', async () => {
    const w = Wallet.createRandom();
    const rt = fakeRuntime({ owner: w.address });
    const replay = new DigestReplayGuard(600);
    const entitlements = testEntitlements();
    const catalogue = accountCatalogue({
      runtime: () => rt,
      sponsor: new FakeSponsor(), // the fake runtime cannot prove: the job fails at once
      vaultAddress: 'ee'.repeat(32),
      network: 'undeployed',
      chainId: 11155111,
      replay,
      entitlements,
      log: silentLog(),
    });
    const h = harness({ catalogue, passportCall: passportCallAuthoriser(() => rt, replay) });
    const token = entitlements.issue(ACCOUNT, 'withdraw:tx-9');
    const payload: AppendInboxPayload = { entry: 'ab'.repeat(192), authNonce: '3', entitlement: token };
    const { signature } = await sign(w, payload);
    const body = { account: ACCOUNT, payload, passportAuth: { owner: w.address, signature, useCounter: '0' } };
    const first = (await (await post(h, 'append-inbox', body)).json()) as { job: { requestId: string } };
    expect((await h.queue.settled(first.job.requestId))?.state).toBe('failed');
    expect((await post(h, 'append-inbox', body)).status).toBe(202);
  });

  it('the executor checks the envelope again: a key changed after admission never reaches a proof (F-B6)', async () => {
    const w = Wallet.createRandom();
    const rt = fakeRuntime({ owner: w.address });
    const replay = new DigestReplayGuard(600);
    const deps = {
      runtime: () => rt,
      sponsor: new FakeSponsor(), // the fake runtime cannot prove: an accepted job fails there
      vaultAddress: 'ee'.repeat(32),
      network: 'undeployed',
      chainId: 11155111,
      replay,
      entitlements: testEntitlements(),
      log: silentLog(),
    };
    const { signature } = await sign(w, withdraw);
    const payload = { ...withdraw, recipientEncryptionKey: '55'.repeat(32) };
    const message = buildRelayActionMessage({
      action: 'withdraw',
      network: 'undeployed',
      owner: w.address,
      account: ACCOUNT,
      payload,
      nonce: `0x${'42'.repeat(32)}`,
      expiry: Math.floor(Date.now() / 1000) + 60,
    });
    const auth = { message, signature: await w.signTypedData(relayDomain(), RELAY_ACTION_TYPES, message) };
    const queue = new JobQueue({ ttlSeconds: 60, maxJobs: 10, log: silentLog() });
    const run = async (p: Record<string, unknown>) => {
      const job = queue.submit({
        action: 'withdraw',
        lane: 'prover',
        payload: {
          ...p,
          auth,
          account: ACCOUNT,
          signer: w.address,
          passportAuth: { owner: w.address, signature, useCounter: '0' },
        },
        executor: withdrawExecutor(deps),
      })!;
      return queue.settled(job.requestId);
    };
    const tampered = await run({ ...payload, recipientEncryptionKey: '66'.repeat(32) });
    expect(tampered?.error).toMatchObject({ code: 'unauthorised', message: expect.stringContaining('relay envelope') });
    const honest = await run(payload);
    expect(honest?.error?.code).toBe('internal-error'); // past the check, it failed only at the (fake) proof
  });

  it('refuses a withdraw whose body is not a withdraw', async () => {
    const w = Wallet.createRandom();
    const { h } = setup(w.address);
    const res = await post(h, 'withdraw', { account: ACCOUNT, payload: { amount: '1' }, passportAuth: {} });
    expect(res.status).toBe(400);
  });
});
