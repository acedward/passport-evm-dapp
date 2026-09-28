// The browser store: every per-user record, in localStorage, with a schema version and
// migrations, cross-tab change events, and Export / Import / CLEAR ALL (spec FR-003, FR-004).

import { recordDataProblem } from './record-schemas.js';
import {
  ExportFileSchema,
  EXPORT_FORMAT,
  EXPORT_FORMAT_VERSION,
  MAX_IMPORT_FILE_BYTES,
  SCHEMA_KEY,
  SCHEMA_VERSION,
  SENSITIVE_KINDS,
  STORE_PREFIX,
  StoredRecordSchema,
  encodeRecord,
  inWalletScope,
  normaliseScope,
  parseKey,
  recordKey,
  type ExportFile,
  type ParsedKey,
  type RecordKind,
  type StoredRecord,
  type WalletScope,
} from './schema.js';

/** One step of the schema: rewrites the raw (key, value) entries from `from` to `to`. */
export interface Migration {
  from: number;
  to: number;
  migrate(entries: Array<[string, string]>): Array<[string, string]>;
}

/** The migrations of the shipped schema. Version 1 is the first; add steps here, never edit old ones. */
export const MIGRATIONS: readonly Migration[] = [];

export class ImportError extends Error {
  override name = 'ImportError';
}

/** An encryption secret an import would replace with a different one (security review F-B5). */
export interface SecretChange {
  key: string;
  /** The account (64 hex), or null for a registration in progress. */
  account: string | null;
  /** The incoming secret's public key (checked to be its pair). */
  encPublicKey: string;
}

/** A checked import, not yet written (`LocalStore.prepareImport`). */
export interface ImportPlan {
  entries: Array<[string, string]>;
  secretChanges: SecretChange[];
}

const isSecretKey = (key: string) => parseKey(key)?.kind === 'secret';

export class StoreReadOnlyError extends Error {
  override name = 'StoreReadOnlyError';
}

/** The browser refused a write because its storage for this site is full (plan P4-A error states). */
export class StoreFullError extends Error {
  override name = 'StoreFullError';
  constructor() {
    super(
      'This browser has no room left for MN Bank’s records, so the last change was not saved. Export your data under Local data, free some site data, then reload.',
    );
  }
}

const isQuotaError = (e: unknown) => {
  const name = (e as { name?: string } | null)?.name ?? '';
  return name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED';
};

export interface RecordView {
  key: string;
  parsed: ParsedKey;
  /** Size of the stored value, in bytes (UTF-16 code units, as localStorage counts them). */
  bytes: number;
  updatedAt: number | null;
  sensitive: boolean;
  record: StoredRecord | null;
}

export interface StoreOptions {
  version?: number;
  migrations?: readonly Migration[];
  /** Why an imported record's data is not one this page writes, or null (default: the shapes of
   *  schema version 1, ./record-schemas.ts; a new schema version brings its own). */
  recordCheck?: (key: ParsedKey, data: unknown) => string | null;
  now?: () => number;
}

function migrate(
  entries: Array<[string, string]>,
  from: number,
  to: number,
  migrations: readonly Migration[],
): Array<[string, string]> | null {
  let version = from;
  let current = entries;
  while (version < to) {
    const step = migrations.find((m) => m.from === version);
    if (!step || step.to <= version) return null;
    current = step.migrate(current);
    version = step.to;
  }
  return version === to ? current : null;
}

export class LocalStore {
  readonly version: number;
  /** True when this browser holds data written by a newer version: the page will not change it. */
  readonly readOnly: boolean;
  private readonly migrations: readonly Migration[];
  private readonly recordCheck: (key: ParsedKey, data: unknown) => string | null;
  private readonly now: () => number;
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly storage: Storage,
    options: StoreOptions = {},
  ) {
    this.version = options.version ?? SCHEMA_VERSION;
    this.migrations = options.migrations ?? MIGRATIONS;
    this.recordCheck = options.recordCheck ?? recordDataProblem;
    this.now = options.now ?? (() => Date.now());
    this.readOnly = !this.openSchema();
  }

  /** Bring stored data to this version; false when it cannot (newer data, or no path). */
  private openSchema(): boolean {
    const raw = this.storage.getItem(SCHEMA_KEY);
    const stored = raw === null ? null : Number(raw);
    const entries = this.rawEntries();
    if (stored === null) {
      // Nothing stored yet (a fresh browser, or right after CLEAR ALL): write nothing until the
      // first record, so opening the page never leaves a key behind.
      if (entries.length > 0) this.storage.setItem(SCHEMA_KEY, String(this.version));
      return true;
    }
    if (!Number.isInteger(stored) || stored > this.version) return false;
    if (stored === this.version) return true;
    const migrated = migrate(entries, stored, this.version, this.migrations);
    if (!migrated) return false;
    const keep = new Set(migrated.map(([k]) => k));
    for (const [k] of entries) if (!keep.has(k)) this.storage.removeItem(k);
    for (const [k, v] of migrated) this.storage.setItem(k, v);
    this.storage.setItem(SCHEMA_KEY, String(this.version));
    return true;
  }

  /** Every (key, value) under the prefix except the schema marker. */
  private rawEntries(): Array<[string, string]> {
    const out: Array<[string, string]> = [];
    for (let i = 0; i < this.storage.length; i++) {
      const k = this.storage.key(i);
      if (k === null || !k.startsWith(STORE_PREFIX) || k === SCHEMA_KEY) continue;
      const v = this.storage.getItem(k);
      if (v !== null) out.push([k, v]);
    }
    return out.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  }

  private markSchema(): void {
    if (this.storage.getItem(SCHEMA_KEY) === null) this.storage.setItem(SCHEMA_KEY, String(this.version));
  }

  // ── change events ────────────────────────────────────────────────────────

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const l of [...this.listeners]) l();
  }

  /** Follow writes made in other tabs (`storage` events fire only in the OTHER tabs). */
  attach(target: Pick<Window, 'addEventListener' | 'removeEventListener'>): () => void {
    const onStorage = (e: StorageEvent) => {
      if (e.key === null || e.key.startsWith(STORE_PREFIX)) this.emit();
    };
    target.addEventListener('storage', onStorage);
    return () => target.removeEventListener('storage', onStorage);
  }

  // ── records ──────────────────────────────────────────────────────────────

  get<T = unknown>(key: string): StoredRecord<T> | null {
    const raw = this.storage.getItem(key);
    if (raw === null) return null;
    try {
      const parsed = StoredRecordSchema.safeParse(JSON.parse(raw));
      return parsed.success ? (parsed.data as StoredRecord<T>) : null;
    } catch {
      return null;
    }
  }

  put<T>(
    scope: WalletScope | 'global',
    kind: RecordKind,
    data: T,
    opts: { account?: string | null; id?: string } = {},
  ): string {
    if (this.readOnly) throw new StoreReadOnlyError('this browser holds data from a newer version of MN Bank');
    const key = recordKey(scope, kind, opts);
    try {
      this.markSchema();
      this.storage.setItem(key, encodeRecord(kind, data, this.now()));
    } catch (e) {
      if (isQuotaError(e)) throw new StoreFullError();
      throw e;
    }
    this.emit();
    return key;
  }

  remove(key: string): void {
    if (this.readOnly) throw new StoreReadOnlyError('this browser holds data from a newer version of MN Bank');
    this.storage.removeItem(key);
    this.emit();
  }

  /** Every record, optionally only one wallet's; unparseable keys under the prefix included. */
  list(scope?: WalletScope): RecordView[] {
    const views: RecordView[] = [];
    for (const [key, value] of this.rawEntries()) {
      const parsed = parseKey(key);
      if (!parsed) continue;
      if (scope && !inWalletScope(parsed, scope)) continue;
      const record = this.get(key);
      views.push({
        key,
        parsed,
        bytes: key.length + value.length,
        updatedAt: record?.updatedAt ?? null,
        sensitive: SENSITIVE_KINDS.has(parsed.kind),
        record,
      });
    }
    return views;
  }

  /** How many keys under the prefix this browser holds, and their total size. */
  usage(): { keys: number; bytes: number } {
    let bytes = 0;
    const entries = this.rawEntries();
    for (const [k, v] of entries) bytes += k.length + v.length;
    return { keys: entries.length, bytes };
  }

  // ── Export / Import / CLEAR ALL (Q11) ──────────────────────────────────────

  /** One wallet's records on one network, as a validated export file. */
  exportWallet(scope: WalletScope): ExportFile {
    const s = normaliseScope(scope);
    const records = this.list(s)
      .filter((v) => v.record !== null)
      .map((v) => ({ key: v.key, value: v.record as StoredRecord }));
    return ExportFileSchema.parse({
      format: EXPORT_FORMAT,
      formatVersion: EXPORT_FORMAT_VERSION,
      schemaVersion: this.version,
      exportedAt: new Date(this.now()).toISOString(),
      network: s.network,
      evmAddress: s.evmAddress,
      records,
    });
  }

  /**
   * Check an export file for the connected wallet, writing nothing (security review F-B4, F-B5):
   * it must be an MN Bank export for THIS network and THIS wallet, within the size bounds, and every
   * record must be one this page writes. Also lists the encryption secrets it would REPLACE with a
   * different one, which `commitImport` refuses unless each is approved (the page checks the new
   * public key against the account's on-chain key first).
   */
  prepareImport(file: unknown, expected: WalletScope): ImportPlan {
    if (this.readOnly)
      throw new ImportError('This browser holds data from a newer version of MN Bank; nothing was imported.');
    const s = normaliseScope(expected);
    const parsed = ExportFileSchema.safeParse(file);
    if (!parsed.success) throw new ImportError('This is not an MN Bank local data export.');
    const f = parsed.data;
    if (f.network !== s.network)
      throw new ImportError(
        `This file is for the ${f.network} network, and this page is on ${s.network}. Nothing was imported.`,
      );
    if (f.evmAddress !== s.evmAddress) {
      throw new ImportError(
        `This file belongs to another wallet (${f.evmAddress.slice(0, 6)}…${f.evmAddress.slice(-4)}). Connect that wallet to import it. Nothing was imported.`,
      );
    }
    if (f.schemaVersion > this.version)
      throw new ImportError('This file was made by a newer version of MN Bank. Nothing was imported.');
    let entries: Array<[string, string]> = f.records.map((r) => [r.key, JSON.stringify(r.value)]);
    if (f.schemaVersion < this.version) {
      const migrated = migrate(entries, f.schemaVersion, this.version, this.migrations);
      if (!migrated)
        throw new ImportError('This file is from a version of MN Bank this page cannot read. Nothing was imported.');
      entries = migrated;
    }
    const bytes = entries.reduce((n, [k, v]) => n + k.length + v.length, 0);
    if (bytes > MAX_IMPORT_FILE_BYTES)
      throw new ImportError('This file holds more than an MN Bank export can (5 MB). Nothing was imported.');
    if (new Set(entries.map(([k]) => k)).size !== entries.length)
      throw new ImportError('The file holds the same record twice. Nothing was imported.');
    const secretChanges: SecretChange[] = [];
    for (const [key, value] of entries) {
      const k = parseKey(key);
      let record: unknown;
      try {
        record = JSON.parse(value);
      } catch {
        record = null;
      }
      const r = StoredRecordSchema.safeParse(record);
      if (!k || !inWalletScope(k, s) || !r.success || r.data.kind !== k.kind) {
        throw new ImportError('The file holds a record that does not belong to this wallet. Nothing was imported.');
      }
      // Security review F-B4: every record must be one this page writes, field by field.
      const problem = this.recordCheck(k, r.data.data);
      if (problem) {
        throw new ImportError(`The file holds a record this page would not write (${problem}). Nothing was imported.`);
      }
      if (k.kind === 'secret' && !k.scope.global) {
        const next = r.data.data as { encSecretKey?: unknown; encPublicKey?: unknown };
        const current = this.get<{ encSecretKey?: unknown }>(key)?.data;
        if (current && current.encSecretKey !== next.encSecretKey) {
          secretChanges.push({ key, account: k.scope.account, encPublicKey: String(next.encPublicKey) });
        }
      }
    }
    return { entries, secretChanges };
  }

  /**
   * Write a prepared import as ONE change (security review F-B5): every key it replaces is
   * snapshotted first; if any write fails (a full storage), every key is put back as it was and
   * nothing is imported. An encryption secret is replaced by a different one only when its
   * account is in `approvedSecretReplacements`; a pending registration's secret never is.
   */
  commitImport(
    plan: ImportPlan,
    opts: { approvedSecretReplacements?: ReadonlySet<string> } = {},
  ): { imported: number; replaced: number } {
    if (this.readOnly)
      throw new ImportError('This browser holds data from a newer version of MN Bank; nothing was imported.');
    for (const c of plan.secretChanges) {
      if (!c.account) {
        throw new ImportError(
          'This file would replace the key of a registration in progress in this browser. Nothing was imported.',
        );
      }
      if (!opts.approvedSecretReplacements?.has(c.account)) {
        throw new ImportError(
          `This file would replace the encryption secret of account ${c.account.slice(0, 8)}… with another one whose public key is not the account's on-chain key (or the bank could not be reached to check it). Nothing was imported.`,
        );
      }
    }
    // Secrets last: everything else is in place before a key changes.
    const ordered = [...plan.entries].sort(([a], [b]) => Number(isSecretKey(a)) - Number(isSecretKey(b)));
    const hadSchema = this.storage.getItem(SCHEMA_KEY) !== null;
    const before = new Map<string, string | null>(ordered.map(([k]) => [k, this.storage.getItem(k)]));
    const written: string[] = [];
    try {
      this.markSchema();
      for (const [key, value] of ordered) {
        this.storage.setItem(key, value);
        written.push(key);
      }
    } catch (e) {
      const undone = this.rollback(written, before, hadSchema);
      this.emit();
      const full = isQuotaError(e);
      if (!undone) {
        throw new ImportError(
          `The import failed part-way${full ? ' (this browser’s storage is full)' : ''} and could not be fully undone: up to ${written.length} of ${ordered.length} records may have changed. Export what you have now and reload before trying again.`,
        );
      }
      throw new ImportError(
        full
          ? 'This browser has no room for the file, so nothing was imported (everything is as it was). Free some site data, then try again.'
          : 'The file could not be written, so nothing was imported (everything is as it was).',
      );
    }
    this.emit();
    const replaced = ordered.filter(([k]) => before.get(k) !== null).length;
    return { imported: ordered.length, replaced };
  }

  /** Put every written key back as it was; false if any restore failed. Every written key is
   *  removed first, so restoring the old values needs no more room than they had before. */
  private rollback(written: string[], before: ReadonlyMap<string, string | null>, hadSchema: boolean): boolean {
    let ok = true;
    for (const k of written) {
      try {
        this.storage.removeItem(k);
      } catch {
        ok = false;
      }
    }
    for (const k of written) {
      const v = before.get(k);
      if (v === null || v === undefined) continue;
      try {
        this.storage.setItem(k, v);
      } catch {
        ok = false;
      }
    }
    if (!hadSchema && this.rawEntries().length === 0) {
      try {
        this.storage.removeItem(SCHEMA_KEY);
      } catch {
        ok = false;
      }
    }
    return ok;
  }

  /**
   * Import an export file into the connected wallet's data, as one change: `prepareImport`, then
   * `commitImport`. All or nothing.
   */
  importWallet(
    file: unknown,
    expected: WalletScope,
    opts: { approvedSecretReplacements?: ReadonlySet<string> } = {},
  ): { imported: number; replaced: number } {
    return this.commitImport(this.prepareImport(file, expected), opts);
  }

  /** Remove EVERY key the bank stored in this browser, for every wallet and network. */
  clearAll(): number {
    const keys: string[] = [];
    for (let i = 0; i < this.storage.length; i++) {
      const k = this.storage.key(i);
      if (k !== null && k.startsWith(STORE_PREFIX)) keys.push(k);
    }
    for (const k of keys) this.storage.removeItem(k);
    this.emit();
    return keys.length;
  }
}
