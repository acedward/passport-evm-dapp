// Plan P1 testing: queue rules. One proof at a time; bridge deposits one at a time per account;
// bridge withdrawals one at a time across the relay; jobs resumable by request id; state in
// memory with a TTL; the payload dropped when a job ends.

import { describe, expect, it } from 'vitest';

import { FifoLock } from '../src/queue/fifo-lock.js';
import { JobQueue, PublicError, type JobExecutor } from '../src/queue/jobs.js';
import { silentLog } from './harness.js';

/** An executor that records overlap and waits until released by the test. */
function probe() {
  let active = 0;
  let maxActive = 0;
  const order: string[] = [];
  const gates = new Map<string, () => void>();
  const executor =
    (name: string, opts: { prove?: boolean } = {}): JobExecutor =>
    async (_payload, ctx) => {
      const body = async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        order.push(`start ${name}`);
        await new Promise<void>((r) => gates.set(name, r));
        order.push(`end ${name}`);
        active--;
      };
      if (opts.prove) await ctx.prove(body);
      else await body();
      return { name };
    };
  const release = async (name: string) => {
    for (let i = 0; i < 50 && !gates.has(name); i++) await new Promise((r) => setTimeout(r, 1));
    const g = gates.get(name);
    if (!g) throw new Error(`${name} never started`);
    gates.delete(name);
    g();
    await new Promise((r) => setTimeout(r, 1));
  };
  return { executor, release, order, stats: () => ({ active, maxActive }), started: (n: string) => gates.has(n) };
}

const tick = () => new Promise((r) => setTimeout(r, 2));
const queue = (over: Partial<ConstructorParameters<typeof JobQueue>[0]> = {}) =>
  new JobQueue({ ttlSeconds: 60, maxJobs: 100, log: silentLog(), ...over });

describe('FifoLock', () => {
  it('grants in order and reports positions', async () => {
    const lock = new FifoLock();
    const r1 = await lock.acquire('a');
    const p2 = lock.acquire('b');
    const p3 = lock.acquire('c');
    expect([lock.position('a'), lock.position('b'), lock.position('c'), lock.position('x')]).toEqual([
      0,
      1,
      2,
      undefined,
    ]);
    r1();
    r1(); // double release is harmless
    const r2 = await p2;
    expect(lock.position('c')).toBe(1);
    r2();
    (await p3)();
    expect(lock.idle).toBe(true);
  });
});

describe('the prover lane', () => {
  it('runs one proving job at a time, first in first out, and shows queue positions', async () => {
    const q = queue();
    const p = probe();
    const a = q.submit({ action: 'register', lane: 'prover', payload: {}, executor: p.executor('a') })!;
    const b = q.submit({
      action: 'withdraw',
      lane: 'prover',
      account: '11'.repeat(32),
      payload: {},
      executor: p.executor('b'),
    })!;
    const c = q.submit({ action: 'open-swap', lane: 'prover', payload: {}, executor: p.executor('c') })!;
    await tick();
    expect(q.get(a.requestId)?.state).toBe('running');
    expect(q.get(b.requestId)).toMatchObject({ state: 'queued', position: 1 });
    expect(q.get(c.requestId)).toMatchObject({ state: 'queued', position: 2 });
    expect(q.stats().lanes.prover).toEqual({ running: 1, waiting: 2 });
    await p.release('a');
    await p.release('b');
    await p.release('c');
    await q.settled(c.requestId);
    expect(p.stats().maxActive).toBe(1);
    expect(p.order).toEqual(['start a', 'end a', 'start b', 'end b', 'start c', 'end c']);
    expect(q.get(c.requestId)).toMatchObject({ state: 'succeeded', result: { name: 'c' } });
  });

  it('bridge jobs take the prover lane only around their proofs', async () => {
    const q = queue();
    const p = probe();
    // A long bridge deposit that proves once, and a register that proves the whole time.
    const reg = q.submit({ action: 'register', lane: 'prover', payload: {}, executor: p.executor('reg') })!;
    const dep = q.submit({
      action: 'bridge-deposit',
      lane: 'deposit',
      account: '11'.repeat(32),
      payload: {},
      executor: p.executor('dep', { prove: true }),
    })!;
    await tick();
    expect(p.started('reg')).toBe(true);
    expect(p.started('dep')).toBe(false); // holds its deposit lane, waits for the prover
    expect(q.get(dep.requestId)?.stage).toBe('waiting-for-prover');
    await p.release('reg');
    await q.settled(reg.requestId);
    await tick();
    expect(q.get(dep.requestId)?.stage).toBe('proving');
    await p.release('dep');
    await q.settled(dep.requestId);
    expect(p.stats().maxActive).toBe(1);
  });
});

describe('the deposit lane', () => {
  it('runs deposits for one account one at a time, and different accounts side by side', async () => {
    const q = queue();
    const p = probe();
    const A = 'aa'.repeat(32);
    const B = 'bb'.repeat(32);
    const a1 = q.submit({
      action: 'bridge-deposit',
      lane: 'deposit',
      account: A,
      payload: {},
      executor: p.executor('a1'),
    })!;
    const a2 = q.submit({
      action: 'bridge-deposit',
      lane: 'deposit',
      account: `0x${A.toUpperCase()}`,
      payload: {},
      executor: p.executor('a2'),
    })!;
    const b1 = q.submit({
      action: 'bridge-deposit',
      lane: 'deposit',
      account: B,
      payload: {},
      executor: p.executor('b1'),
    })!;
    await tick();
    expect(p.started('a1')).toBe(true);
    expect(p.started('b1')).toBe(true); // another account's deposit runs at the same time
    expect(p.started('a2')).toBe(false);
    expect(q.get(a2.requestId)).toMatchObject({ state: 'queued', position: 1 });
    expect(q.stats().lanes.deposit).toEqual({ running: 2, waiting: 1 });
    await p.release('a1');
    await tick();
    expect(p.started('a2')).toBe(true);
    await p.release('a2');
    await p.release('b1');
    await Promise.all([q.settled(a1.requestId), q.settled(a2.requestId), q.settled(b1.requestId)]);
    expect(p.order.indexOf('end a1')).toBeLessThan(p.order.indexOf('start a2'));
    expect(q.stats().lanes.deposit).toEqual({ running: 0, waiting: 0 });
  });

  it('needs an account', () => {
    expect(() =>
      queue().submit({ action: 'bridge-deposit', lane: 'deposit', payload: {}, executor: async () => ({}) }),
    ).toThrow();
  });
});

describe('the withdrawal lane', () => {
  it('runs withdrawals one at a time across every account', async () => {
    const q = queue();
    const p = probe();
    q.submit({
      action: 'bridge-withdraw',
      lane: 'withdrawal',
      account: 'aa'.repeat(32),
      payload: {},
      executor: p.executor('w1'),
    })!;
    const w2 = q.submit({
      action: 'bridge-withdraw',
      lane: 'withdrawal',
      account: 'bb'.repeat(32),
      payload: {},
      executor: p.executor('w2'),
    })!;
    await tick();
    expect(p.started('w1')).toBe(true);
    expect(p.started('w2')).toBe(false);
    expect(q.get(w2.requestId)).toMatchObject({ state: 'queued', position: 1 });
    await p.release('w1');
    await p.release('w2');
    await q.settled(w2.requestId);
    expect(p.stats().maxActive).toBe(1);
  });
});

describe('job state', () => {
  it('drops the payload when a job ends and keeps only the public outcome', async () => {
    const q = queue();
    let seen: unknown;
    const job = q.submit({
      action: 'withdraw',
      lane: 'prover',
      payload: { coin: { nonce: 'secret-ish' } },
      executor: async (payload, ctx) => {
        seen = payload;
        ctx.stage('submitted', { txHash: '00ab' });
        return { txHash: '00ab' };
      },
    })!;
    const done = await q.settled(job.requestId);
    expect(seen).toEqual({ coin: { nonce: 'secret-ish' } });
    expect(JSON.stringify(done)).not.toContain('secret-ish');
    expect(done?.stages.map((s) => s.stage)).toEqual(['queued', 'running', 'submitted', 'succeeded']);
    expect(done?.stages[2]?.detail).toEqual({ txHash: '00ab' });
  });

  it('shows public errors, and hides internal ones', async () => {
    const q = queue();
    const a = q.submit({
      action: 'take',
      lane: 'prover',
      payload: {},
      executor: async () => {
        throw new PublicError('offer-gone', 'the offer was taken first');
      },
    })!;
    const b = q.submit({
      action: 'take',
      lane: 'prover',
      payload: {},
      executor: async () => {
        throw new Error('ECONNREFUSED http://internal:6300 seed=deadbeef');
      },
    })!;
    expect((await q.settled(a.requestId))?.error).toEqual({ code: 'offer-gone', message: 'the offer was taken first' });
    const hidden = await q.settled(b.requestId);
    expect(hidden?.error?.code).toBe('internal-error');
    expect(JSON.stringify(hidden)).not.toContain('internal:6300');
  });

  it('forgets finished jobs after the TTL, never queued or running ones', async () => {
    let now = 1_000;
    const q = queue({ ttlSeconds: 10, now: () => now });
    const p = probe();
    const done = q.submit({ action: 'withdraw', lane: 'prover', payload: {}, executor: async () => ({}) })!;
    await q.settled(done.requestId);
    const running = q.submit({ action: 'register', lane: 'prover', payload: {}, executor: p.executor('r') })!;
    await tick();
    now += 11;
    q.sweep();
    expect(q.get(done.requestId)).toBeUndefined();
    expect(q.get(running.requestId)?.state).toBe('running');
    await p.release('r');
    await q.settled(running.requestId);
    expect(q.get(running.requestId)?.expiresAt).toBe(now + 10);
  });

  // Security review F-B2: outcomes kept for their TTL must never refuse new work.
  it('a flood of failed jobs cannot fill the capacity: finished outcomes make room, failed ones first', async () => {
    const q = queue({ maxJobs: 10, ttlSeconds: 86_400 });
    const ok = q.submit({ action: 'withdraw', lane: 'prover', payload: {}, executor: async () => ({ ok: true }) })!;
    await q.settled(ok.requestId);
    const failed: string[] = [];
    for (let i = 0; i < 50; i++) {
      const job = q.submit({
        action: 'bridge-resume',
        lane: 'deposit',
        account: 'ab'.repeat(32),
        payload: {},
        executor: async () => {
          throw new PublicError('unauthorised', 'not a device');
        },
      });
      expect(job).not.toBeNull();
      failed.push(job!.requestId);
      await q.settled(job!.requestId);
    }
    expect(q.stats().jobs).toBeLessThanOrEqual(10);
    // The customer's succeeded outcome outlived 50 failures: failed outcomes are dropped first.
    expect(q.get(ok.requestId)?.state).toBe('succeeded');
    expect(q.get(failed[0]!)).toBeUndefined();
    expect(q.get(failed[49]!)?.state).toBe('failed');
    // And a real customer's action is still admitted.
    expect(q.submit({ action: 'register', lane: 'prover', payload: {}, executor: async () => ({}) })).not.toBeNull();
  });

  it('is busy only when maxJobs jobs are waiting or running', async () => {
    const q = queue({ maxJobs: 10 });
    const p = probe();
    for (let i = 0; i < 10; i++)
      expect(
        q.submit({ action: 'register', lane: 'prover', payload: {}, executor: p.executor(`j${i}`) }),
      ).not.toBeNull();
    expect(q.submit({ action: 'register', lane: 'prover', payload: {}, executor: p.executor('late') })).toBeNull();
    await p.release('j0');
    expect(q.submit({ action: 'register', lane: 'prover', payload: {}, executor: p.executor('next') })).not.toBeNull();
    for (let i = 1; i < 10; i++) await p.release(`j${i}`);
    await p.release('next');
  });

  it('refuses new jobs when full', async () => {
    const q = queue({ maxJobs: 2 });
    const p = probe();
    q.submit({ action: 'register', lane: 'prover', payload: {}, executor: p.executor('x') });
    q.submit({ action: 'register', lane: 'prover', payload: {}, executor: p.executor('y') });
    expect(q.submit({ action: 'register', lane: 'prover', payload: {}, executor: p.executor('z') })).toBeNull();
    await p.release('x');
    await p.release('y');
  });
});
