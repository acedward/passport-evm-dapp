import { beforeEach, describe, expect, it } from 'vitest';

import { SCHEMA_KEY, STORE_PREFIX, StoreKeyError, parseKey, recordKey, type WalletScope } from '../src/store/schema.js';
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

const seed = (store: LocalStore) => {
  store.put(ME, 'profile', { firstSeen: 1 });
  store.put(ME, 'account', { address: ACC, device: '0x01' }, { account: ACC });
  store.put(ME, 'secret', { encSecretKey: 'ff'.repeat(32) }, { account: ACC });
  store.put(ME, 'coins', [{ value: '60000000' }, { value: '40000000' }], { account: ACC });
  store.put(ME, 'bridge', { stage: 'mpc' }, { account: ACC, id: 'req-1' });
  store.put(ME, 'account', { address: ACC2 }, { account: ACC2 });
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
      'ff'.repeat(32),
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
      list: [{ value: '60000000' }, { value: '40000000' }],
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
    const store = new LocalStore(localStorage, { version: 2, migrations: [v2] });
    store.importWallet(file, ME);
    expect(store.get(recordKey(ME, 'coins', { account: ACC }))?.data).toEqual({
      list: [{ value: '60000000' }, { value: '40000000' }],
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
});
