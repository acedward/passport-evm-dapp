import { beforeEach, describe, expect, it } from 'vitest';

import { encPublicKeyOf } from '@mnbank/core';

import { exportFileText, importFile } from '../src/pages/LocalData.js';
import {
  MAX_IMPORT_FILE_BYTES,
  MAX_IMPORT_READ_BYTES,
  SCHEMA_KEY,
  STORE_PREFIX,
  StoreKeyError,
  parseKey,
  recordKey,
  type WalletScope,
} from '../src/store/schema.js';
import { ImportError, LocalStore, StoreReadOnlyError, type Migration } from '../src/store/store.js';

const ME: WalletScope = { network: 'stagenet', evmAddress: '0xAbCdEf0123456789aBcDeF0123456789AbCdEf01' };
const OTHER: WalletScope = { network: 'stagenet', evmAddress: `0x${'22'.repeat(20)}` };
const ACC = '5a'.repeat(32);
const ACC2 = '6b'.repeat(32);

const snapshot = () => {
  const out: Record<string, string> = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i)!;
    out[k] = localStorage.getItem(k)!;
  }
  return out;
};

const COLOUR = '5e'.repeat(32);
const DEVICE = ME.evmAddress.toLowerCase();
/** Records as the page writes them (security review F-B4: Import accepts only these shapes). */
const accountRecord = (address: string) => ({
  address,
  device: DEVICE,
  network: 'stagenet',
  vault: 'ee'.repeat(32),
  createdAt: 1,
  txs: { waveOne: '00ab', waveTwo: '00cd', activation: '00ef' },
});
const coin = (value: string, n: string) => ({
  nonce: n.repeat(32),
  color: COLOUR,
  value,
  mtIndex: '100',
  commitment: `c${n}`.repeat(21).slice(0, 64).padEnd(64, '0'),
  origin: 'inbox',
  inInbox: true,
  inboxIndex: '0',
  spent: false,
});
const pair = (secret: string) => ({ encSecretKey: secret, encPublicKey: encPublicKeyOf(secret) });
const SECRET_A = pair('ff'.repeat(31) + '7f');
const SECRET_B = pair('11'.repeat(32));
const TRANSFER_ID = '0123456789abcdef';
const transferRecord = {
  id: TRANSFER_ID,
  kind: 'deposit',
  account: ACC,
  symbol: 'stkA',
  midnightName: 'wStkA',
  erc20: '0x2Ab7BE0769e3BBD5c7d047B422CB383fCC06FB52',
  colour: COLOUR,
  decimals: 6,
  amount: '1000000',
  depositAddress: '0xEb5A392eeee639C23434C1FA8bccbF6bC730377C',
  createdAt: 1,
  updatedAt: 2,
  state: 'running',
  jobIds: ['1'.padStart(32, '0')],
  requestId: 'a1'.repeat(32),
  stages: [{ stage: 'mpc-signed', at: 3, detail: { evmNonce: '0' } }],
};
const seed = (store: LocalStore) => {
  store.put(ME, 'profile', { firstSeen: 1 });
  store.put(ME, 'account', accountRecord(ACC), { account: ACC });
  store.put(ME, 'secret', SECRET_A, { account: ACC });
  store.put(ME, 'coins', [coin('60000000', '01'), coin('40000000', '02')], { account: ACC });
  store.put(ME, 'bridge', transferRecord, { account: ACC, id: TRANSFER_ID });
  store.put(ME, 'account', accountRecord(ACC2), { account: ACC2 });
  store.put(OTHER, 'profile', { firstSeen: 2 });
  store.put('global', 'settings', { grouping: true });
};

beforeEach(() => localStorage.clear());

describe('keys', () => {
  it('namespace by network, EVM address (lowercased) and account', () => {
    const k = recordKey(ME, 'coins', { account: `0x${ACC.toUpperCase()}` });
    expect(k).toBe(`mn-bank/v1/stagenet/${ME.evmAddress.toLowerCase()}/${ACC}/coins`);
    expect(parseKey(k)).toEqual({
      scope: { global: false, network: 'stagenet', evmAddress: ME.evmAddress.toLowerCase(), account: ACC },
      kind: 'coins',
    });
    expect(parseKey(recordKey(ME, 'bridge', { account: ACC, id: 'req-1' }))?.id).toBe('req-1');
    expect(parseKey(recordKey('global', 'settings'))).toEqual({ scope: { global: true }, kind: 'settings' });
    expect(recordKey(ME, 'profile')).toContain('/-/profile');
  });

  it('refuse malformed parts, and parse nothing foreign', () => {
    expect(() => recordKey({ network: 'Stage Net', evmAddress: ME.evmAddress }, 'profile')).toThrow(StoreKeyError);
    expect(() => recordKey({ network: 'stagenet', evmAddress: '0x12' }, 'profile')).toThrow(StoreKeyError);
    expect(() => recordKey(ME, 'coins', { account: 'xyz' })).toThrow(StoreKeyError);
    expect(() => recordKey(ME, 'bridge', { id: 'a/b' })).toThrow(StoreKeyError);
    for (const k of [
      'other/key',
      'mn-bank/v1/stagenet/0x12/-/profile',
      `mn-bank/v1/stagenet/${OTHER.evmAddress}/-/nope`,
      `mn-bank/v1/_global/settings/a/b`,
    ]) {
      expect(parseKey(k)).toBeNull();
    }
  });
});

describe('the store', () => {
  it('writes nothing until the first record, then marks the schema version', () => {
    new LocalStore(localStorage);
    expect(localStorage.length).toBe(0);
    const store = new LocalStore(localStorage);
    store.put(ME, 'profile', { firstSeen: 1 });
    expect(localStorage.getItem(SCHEMA_KEY)).toBe('1');
  });

  it('lists records per wallet, marks secrets sensitive, and reports sizes', () => {
    const store = new LocalStore(localStorage);
    seed(store);
    const mine = store.list(ME);
    expect(mine.map((v) => v.parsed.kind).sort()).toEqual([
      'account',
      'account',
      'bridge',
      'coins',
      'profile',
      'secret',
    ]);
    expect(mine.filter((v) => v.sensitive).map((v) => v.parsed.kind)).toEqual(['secret']);
    expect(mine.every((v) => v.bytes > 0 && v.updatedAt !== null)).toBe(true);
    expect(store.list()).toHaveLength(8);
    expect(store.get<{ encSecretKey: string }>(recordKey(ME, 'secret', { account: ACC }))?.data.encSecretKey).toBe(
      SECRET_A.encSecretKey,
    );
  });

  it("notifies subscribers of its own writes and of other tabs' writes", () => {
    const store = new LocalStore(localStorage);
    let n = 0;
    const off = store.subscribe(() => n++);
    const detach = store.attach(window);
    store.put(ME, 'profile', {});
    window.dispatchEvent(new StorageEvent('storage', { key: recordKey(ME, 'profile') }));
    window.dispatchEvent(new StorageEvent('storage', { key: null })); // another tab cleared storage
    window.dispatchEvent(new StorageEvent('storage', { key: 'someone-else/key' }));
    expect(n).toBe(3);
    off();
    detach();
    store.put(ME, 'profile', {});
    expect(n).toBe(3);
  });
});

describe('schema migrations', () => {
  const v2: Migration = {
    from: 1,
    to: 2,
    migrate: (entries) =>
      entries.map(([k, v]) => {
        const r = JSON.parse(v) as { kind: string; data: unknown };
        return r.kind === 'coins' ? [k, JSON.stringify({ ...r, data: { list: r.data } })] : [k, v];
      }),
  };

  it('migrate stored data to the new version on open', () => {
    seed(new LocalStore(localStorage));
    const store = new LocalStore(localStorage, { version: 2, migrations: [v2] });
    expect(store.readOnly).toBe(false);
    expect(localStorage.getItem(SCHEMA_KEY)).toBe('2');
    expect(store.get(recordKey(ME, 'coins', { account: ACC }))?.data).toEqual({
      list: [coin('60000000', '01'), coin('40000000', '02')],
    });
    expect(store.get(recordKey(ME, 'profile'))?.data).toEqual({ firstSeen: 1 });
  });

  it('are read-only when the data is newer than the page, or when no path exists', () => {
    seed(new LocalStore(localStorage));
    localStorage.setItem(SCHEMA_KEY, '3');
    const newer = new LocalStore(localStorage, { version: 2, migrations: [v2] });
    expect(newer.readOnly).toBe(true);
    expect(() => newer.put(ME, 'profile', {})).toThrow(StoreReadOnlyError);
    localStorage.setItem(SCHEMA_KEY, '1');
    expect(new LocalStore(localStorage, { version: 3, migrations: [v2] }).readOnly).toBe(true);
    expect(localStorage.getItem(SCHEMA_KEY)).toBe('1'); // nothing was rewritten
  });

  it('migrate an older export on import', () => {
    const old = new LocalStore(localStorage);
    seed(old);
    const file = old.exportWallet(ME);
    localStorage.clear();
    // Version 2 brings its own record shapes (here: any), as a real schema change would.
    const store = new LocalStore(localStorage, { version: 2, migrations: [v2], recordCheck: () => null });
    store.importWallet(file, ME);
    expect(store.get(recordKey(ME, 'coins', { account: ACC }))?.data).toEqual({
      list: [coin('60000000', '01'), coin('40000000', '02')],
    });
  });
});

describe('Export, CLEAR ALL and Import (Q11, SC-005)', () => {
  it("round-trip one wallet's data exactly", () => {
    const store = new LocalStore(localStorage);
    seed(store);
    const before = snapshot();
    const file = JSON.parse(JSON.stringify(store.exportWallet(ME))) as unknown; // as downloaded
    expect(file).toMatchObject({
      format: 'mn-bank-local-data',
      formatVersion: 1,
      schemaVersion: 1,
      network: 'stagenet',
      evmAddress: ME.evmAddress.toLowerCase(),
    });
    expect((file as { records: unknown[] }).records).toHaveLength(6); // not OTHER's, not global

    expect(store.clearAll()).toBe(9); // 8 records + the schema marker
    expect(Object.keys(snapshot()).filter((k) => k.startsWith(STORE_PREFIX))).toEqual([]);

    const r = store.importWallet(file, {
      network: 'stagenet',
      evmAddress: ME.evmAddress.toUpperCase().replace('0X', '0x'),
    });
    expect(r).toEqual({ imported: 6, replaced: 0 });
    const after = snapshot();
    for (const [k, v] of Object.entries(before)) {
      if (k.includes(ME.evmAddress.toLowerCase())) expect(after[k]).toBe(v);
    }
    expect(store.importWallet(file, ME)).toEqual({ imported: 6, replaced: 6 });
  });

  it("CLEAR ALL leaves keys that are not the bank's", () => {
    localStorage.setItem('another-app/key', 'x');
    const store = new LocalStore(localStorage);
    seed(store);
    store.clearAll();
    expect(snapshot()).toEqual({ 'another-app/key': 'x' });
  });

  it('refuse a file for another network or another wallet, and write nothing', () => {
    const store = new LocalStore(localStorage);
    seed(store);
    const file = store.exportWallet(ME);
    store.clearAll();
    expect(() => store.importWallet(file, { network: 'undeployed', evmAddress: ME.evmAddress })).toThrow(
      /stagenet network/,
    );
    expect(() => store.importWallet(file, OTHER)).toThrow(/another wallet/);
    expect(localStorage.length).toBe(0);
  });

  it('refuse anything that is not an export, and a file with a foreign record, all or nothing', () => {
    const store = new LocalStore(localStorage);
    seed(store);
    const file = store.exportWallet(ME);
    store.clearAll();
    for (const bad of [null, 'text', {}, { ...file, format: 'other' }, { ...file, records: 'x' }]) {
      expect(() => store.importWallet(bad, ME), JSON.stringify(bad)?.slice(0, 40)).toThrow(ImportError);
    }
    const foreign = {
      ...file,
      records: [
        ...file.records,
        { key: recordKey(OTHER, 'profile'), value: { v: 1, kind: 'profile', updatedAt: 1, data: {} } },
      ],
    };
    expect(() => store.importWallet(foreign, ME)).toThrow(/does not belong/);
    const mismatched = {
      ...file,
      records: [{ key: recordKey(ME, 'profile'), value: { v: 1, kind: 'secret', updatedAt: 1, data: {} } }],
    };
    expect(() => store.importWallet(mismatched, ME)).toThrow(/does not belong/);
    const newer = { ...file, schemaVersion: 99 };
    expect(() => store.importWallet(newer, ME)).toThrow(/newer version/);
    expect(localStorage.length).toBe(0);
  });

  // Security review F-B4: Import accepts only records this page writes, field by field.
  it('refuse a record of the wrong shape for its kind, or one that disagrees with its key', () => {
    const store = new LocalStore(localStorage);
    seed(store);
    const file = store.exportWallet(ME);
    store.clearAll();
    const withRecord = (key: string, kind: string, data: unknown) => ({
      ...file,
      records: [...file.records.filter((r) => r.key !== key), { key, value: { v: 1, kind, updatedAt: 1, data } }],
    });
    const bridgeKey = recordKey(ME, 'bridge', { account: ACC, id: TRANSFER_ID });
    const cases: Array<[unknown, RegExp]> = [
      // an unknown field
      [withRecord(bridgeKey, 'bridge', { ...transferRecord, redirectTo: '0x00' }), /not in the shape/],
      // an ill-typed deposit address, token, amount or colour
      [withRecord(bridgeKey, 'bridge', { ...transferRecord, depositAddress: 'attacker' }), /not in the shape/],
      [withRecord(bridgeKey, 'bridge', { ...transferRecord, erc20: 'javascript:alert(1)' }), /not in the shape/],
      [withRecord(bridgeKey, 'bridge', { ...transferRecord, amount: '-1' }), /not in the shape/],
      [withRecord(bridgeKey, 'bridge', { ...transferRecord, colour: 'zz' }), /not in the shape/],
      // filed under another account or id than it names
      [withRecord(bridgeKey, 'bridge', { ...transferRecord, account: ACC2 }), /does not match its key/],
      [
        withRecord(recordKey(ME, 'bridge', { account: ACC, id: 'fedcba9876543210' }), 'bridge', transferRecord),
        /does not match its key/,
      ],
      // an account record for another device, or naming another account than its key
      [
        withRecord(recordKey(ME, 'account', { account: ACC }), 'account', {
          ...accountRecord(ACC),
          device: `0x${'33'.repeat(20)}`,
        }),
        /another device/,
      ],
      [withRecord(recordKey(ME, 'account', { account: ACC }), 'account', accountRecord(ACC2)), /another account/],
      // coins, secrets, offers and jobs of the wrong shape
      [withRecord(recordKey(ME, 'coins', { account: ACC }), 'coins', [{ value: '1' }]), /not in the shape/],
      [withRecord(recordKey(ME, 'secret', { account: ACC }), 'secret', { encSecretKey: 'ff' }), /not in the shape/],
      [withRecord(recordKey(ME, 'offer', { account: ACC, id: 'make-x' }), 'offer', {}), /not in the shape/],
      [withRecord(recordKey(ME, 'job', { account: ACC, id: 'j' }), 'job', { requestId: 'j' }), /not in the shape/],
      // a record kind that needs an account, filed without one
      [withRecord(recordKey(ME, 'coins'), 'coins', []), /not filed under an account/],
    ];
    for (const [bad, message] of cases) {
      expect(() => store.importWallet(bad, ME), JSON.stringify(bad).slice(-160)).toThrow(message);
    }
    expect(localStorage.length).toBe(0);
    // The page's own export still imports.
    expect(store.importWallet(file, ME)).toEqual({ imported: 6, replaced: 0 });
  });
});

/** localStorage with a size quota, like a browser's: a write that would take the total past
 *  `capacity` characters fails with the quota error and changes nothing. */
class FullStorage implements Storage {
  constructor(
    private readonly inner: Storage,
    public capacity: number,
  ) {}
  used(): number {
    let n = 0;
    for (let i = 0; i < this.inner.length; i++) {
      const k = this.inner.key(i)!;
      n += k.length + this.inner.getItem(k)!.length;
    }
    return n;
  }
  get length() {
    return this.inner.length;
  }
  clear() {
    this.inner.clear();
  }
  getItem(k: string) {
    return this.inner.getItem(k);
  }
  key(i: number) {
    return this.inner.key(i);
  }
  removeItem(k: string) {
    this.inner.removeItem(k);
  }
  setItem(k: string, v: string) {
    const old = this.inner.getItem(k);
    const next = this.used() - (old === null ? 0 : k.length + old.length) + k.length + v.length;
    if (next > this.capacity) throw Object.assign(new Error('quota'), { name: 'QuotaExceededError' });
    this.inner.setItem(k, v);
  }
}

describe('Import is one change (security review F-B5)', () => {
  /** The seeded wallet's export, changed: other coins, a new transfer, and (optionally) another secret. */
  const changedFile = (store: LocalStore, secret?: { encSecretKey: string; encPublicKey: string }) => {
    const file = store.exportWallet(ME);
    const records = file.records.map((r) => {
      const k = parseKey(r.key)!;
      const v = r.value as { v: 1; kind: string; updatedAt: number; data: unknown };
      if (k.kind === 'coins') return { ...r, value: { ...v, data: [coin('1', '09')] } };
      if (k.kind === 'secret' && secret) return { ...r, value: { ...v, data: secret } };
      return r;
    });
    const id = 'fedcba9876543210';
    records.push({
      key: recordKey(ME, 'bridge', { account: ACC, id }),
      value: { v: 1, kind: 'bridge', updatedAt: 5, data: { ...transferRecord, id } },
    });
    return { ...file, records };
  };

  it('a storage failure part-way puts every key back and says nothing was imported', () => {
    const full = new FullStorage(localStorage, 1_000_000);
    const store = new LocalStore(full);
    seed(store);
    const before = snapshot();
    const file = changedFile(store, SECRET_B);
    // Room for the smaller coin list and a few bytes more, not for the new transfer: the import
    // fails part-way, after some keys were already replaced.
    full.capacity = full.used() + 100;
    const newCoins = JSON.stringify(
      (file.records.find((r) => parseKey(r.key)?.kind === 'coins')!.value as { data: unknown }).data,
    );
    let newCoinsWritten = false;
    const set = full.setItem.bind(full);
    full.setItem = (k, v) => {
      set(k, v);
      if (v.includes(newCoins)) newCoinsWritten = true;
    };
    expect(() => store.importWallet(file, ME, { approvedSecretReplacements: new Set([ACC]) })).toThrow(
      /no room for the file, so nothing was imported \(everything is as it was\)/,
    );
    expect(newCoinsWritten).toBe(true); // it really failed part-way, after replacing the coins …
    expect(snapshot()).toEqual(before); // … and the old secret, the old coins are back, no new transfer
    full.capacity = 1_000_000;
    expect(store.importWallet(file, ME, { approvedSecretReplacements: new Set([ACC]) })).toMatchObject({
      imported: 7,
      replaced: 6,
    });
  });

  it('says so, accurately, when a failed import cannot be fully undone', () => {
    const full = new FullStorage(localStorage, 1_000_000);
    const store = new LocalStore(full);
    seed(store);
    const file = changedFile(store);
    full.capacity = full.used() + 100;
    full.removeItem = () => {
      throw new Error('storage broken');
    };
    expect(() => store.importWallet(file, ME)).toThrow(
      /could not be fully undone: up to \d+ of 7 records may have changed/,
    );
  });

  it('writes secrets last', () => {
    const full = new FullStorage(localStorage, 1_000_000);
    const store = new LocalStore(full);
    seed(store);
    const file = changedFile(store, SECRET_B);
    const order: string[] = [];
    const set = full.setItem.bind(full);
    full.setItem = (k, v) => {
      order.push(parseKey(k)?.kind ?? k);
      set(k, v);
    };
    store.importWallet(file, ME, { approvedSecretReplacements: new Set([ACC]) });
    expect(order.at(-1)).toBe('secret');
  });

  it("refuses to replace an account's secret with another one unless its public key is the on-chain key", async () => {
    const store = new LocalStore(localStorage);
    seed(store);
    const before = snapshot();
    const file = changedFile(store, SECRET_B);
    expect(() => store.importWallet(file, ME)).toThrow(/replace the encryption secret of account 5a5a5a5a/);
    expect(snapshot()).toEqual(before);
    // The page asks the chain: another key there (or no answer) → refused; the new key → imported.
    const relay = (encKey: string | null) => ({
      accountState: async () => (encKey === null ? Promise.reject(new Error('down')) : ({ encKey } as never)),
    });
    await expect(importFile(store, relay(SECRET_A.encPublicKey), file, ME)).rejects.toThrow(/encryption secret/);
    await expect(importFile(store, relay(null), file, ME)).rejects.toThrow(/could not be reached/);
    expect(snapshot()).toEqual(before);
    await importFile(store, relay(SECRET_B.encPublicKey), file, ME);
    expect(store.get(recordKey(ME, 'secret', { account: ACC }))?.data).toEqual(SECRET_B);
    // The same secret again is no replacement.
    expect(store.importWallet(store.exportWallet(ME), ME)).toMatchObject({ imported: 7 });
  });

  it("refuses a secret whose public key is not its own, and never replaces a registration's key", () => {
    const store = new LocalStore(localStorage);
    seed(store);
    const bad = changedFile(store, { encSecretKey: SECRET_B.encSecretKey, encPublicKey: SECRET_A.encPublicKey });
    expect(() => store.importWallet(bad, ME, { approvedSecretReplacements: new Set([ACC]) })).toThrow(
      /public key is not its secret's/,
    );
    store.put(ME, 'secret', { ...SECRET_A, pending: true }, { account: null });
    const pending = {
      ...store.exportWallet(ME),
      records: [
        {
          key: recordKey(ME, 'secret', { account: null }),
          value: { v: 1, kind: 'secret', updatedAt: 1, data: SECRET_B },
        },
      ],
    };
    expect(() => store.importWallet(pending, ME)).toThrow(/registration in progress/);
  });

  it('bounds the file: its size, and the same record twice', () => {
    const store = new LocalStore(localStorage);
    seed(store);
    const file = store.exportWallet(ME);
    const big = {
      ...file,
      records: [
        ...file.records,
        ...Array.from({ length: 30 }, (_, i) => ({
          key: recordKey(ME, 'offer', { account: ACC, id: `make-${'ab'.repeat(32)}` }).replace(
            /ab$/,
            i.toString(16).padStart(2, '0'),
          ),
          value: { v: 1, kind: 'offer', updatedAt: 1, data: { pad: 'x'.repeat(200_000) } },
        })),
      ],
    };
    expect(() => store.importWallet(big, ME)).toThrow(/more than an MN Bank export can/);
    const twice = { ...file, records: [...file.records, file.records[0]!] };
    expect(() => store.importWallet(twice, ME)).toThrow(/same record twice/);
  });
});

describe('Import takes every export the page can write (security review F-B8)', () => {
  it('the fullest wallet the size bound allows exports to a file Import reads, and it round-trips', () => {
    const store = new LocalStore(localStorage);
    store.put(ME, 'profile', { firstSeen: 1 });
    store.put(ME, 'account', accountRecord(ACC), { account: ACC });
    store.put(ME, 'secret', SECRET_A, { account: ACC });
    const hex = (n: number) => n.toString(16).padStart(64, '0');
    const many = (count: number) =>
      Array.from({ length: count }, (_, i) => ({
        ...coin(String(1_000_000 + i), '01'),
        nonce: hex(i),
        commitment: hex(0xc000_0000 + i),
        mtIndex: String(i),
        inboxIndex: String(i),
        spent: i % 2 === 0,
      }));
    // As many coins as fit the records bound (what localStorage itself holds), less 2 KB.
    const limit = MAX_IMPORT_FILE_BYTES - 2_048;
    const sizeWith = (n: number) => {
      store.put(ME, 'coins', many(n), { account: ACC });
      return store.usage().bytes;
    };
    const perCoin = (sizeWith(11_000) - sizeWith(10_000)) / 1_000;
    let count = 11_000 + Math.floor((limit - sizeWith(11_000)) / perCoin);
    while (sizeWith(count) > limit) count -= 5;
    expect(count).toBeGreaterThan(10_000);
    expect(store.usage().bytes).toBeGreaterThan(limit - 6 * perCoin);

    const file = store.exportWallet(ME);
    const bytes = (t: string) => new TextEncoder().encode(t).length;
    // The file as the page downloads it is within what Import reads …
    expect(bytes(exportFileText(file))).toBeLessThanOrEqual(MAX_IMPORT_READ_BYTES);
    // … and so is the same export written the old way, indented, which the old 5 MB file bound
    // refused although its records fit.
    const indented = bytes(`${JSON.stringify(file, null, 2)}\n`);
    expect(indented).toBeGreaterThan(MAX_IMPORT_FILE_BYTES);
    expect(indented).toBeLessThanOrEqual(MAX_IMPORT_READ_BYTES);

    const before = snapshot();
    store.clearAll();
    expect(store.importWallet(JSON.parse(exportFileText(file)), ME)).toEqual({ imported: 4, replaced: 0 });
    expect(snapshot()).toEqual(before);
  });
});
