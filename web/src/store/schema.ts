// The browser store's layout (spec FR-003, FR-004, Q5, Q11). Every per-user record the bank
// keeps lives in this browser's localStorage, under one prefix, namespaced by Midnight network,
// EVM address and Passport account:
//
//   mn-bank/schema                                          the schema version (an integer)
//   mn-bank/v1/_global/<kind>                               settings for this browser
//   mn-bank/v1/<network>/<0xevm lowercase>/-/<kind>[/<id>]  a wallet's records with no account
//   mn-bank/v1/<network>/<0xevm lowercase>/<account>/<kind>[/<id>]
//
// Each value is JSON: {"v": 1, "kind", "updatedAt" (ms), "data"}. Records of a SENSITIVE kind
// (the account's encryption secret) are masked in the Local data tab until revealed.

import { z } from 'zod';

export const STORE_PREFIX = 'mn-bank/';
export const SCHEMA_KEY = 'mn-bank/schema';
export const SCHEMA_VERSION = 1;
const V1 = 'mn-bank/v1/';

export const RECORD_KINDS = [
  'profile',
  'account',
  'secret',
  'coins',
  'roster',
  'bridge',
  'offer',
  'job',
  'settings',
] as const;
export type RecordKind = (typeof RECORD_KINDS)[number];

/** Kinds whose value is a secret: masked until the customer reveals it. */
export const SENSITIVE_KINDS: ReadonlySet<RecordKind> = new Set(['secret']);

export interface WalletScope {
  network: string;
  /** 0x-prefixed, lowercase. */
  evmAddress: string;
}

export type RecordScope =
  { global: true } | { global: false; network: string; evmAddress: string; account: string | null };

const NETWORK_RE = /^[a-z0-9-]{1,32}$/;
const EVM_RE = /^0x[0-9a-f]{40}$/;
const ACCOUNT_RE = /^[0-9a-f]{64}$/;
const ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

export class StoreKeyError extends Error {
  override name = 'StoreKeyError';
}

export function normaliseScope(scope: WalletScope): WalletScope {
  const s = { network: scope.network, evmAddress: scope.evmAddress.toLowerCase() };
  if (!NETWORK_RE.test(s.network)) throw new StoreKeyError(`bad network "${scope.network}"`);
  if (!EVM_RE.test(s.evmAddress)) throw new StoreKeyError('bad EVM address');
  return s;
}

/** The localStorage key of a record. */
export function recordKey(
  scope: WalletScope | 'global',
  kind: RecordKind,
  opts: { account?: string | null; id?: string } = {},
): string {
  const id = opts.id;
  if (id !== undefined && !ID_RE.test(id)) throw new StoreKeyError(`bad record id "${id}"`);
  const tail = id === undefined ? kind : `${kind}/${id}`;
  if (scope === 'global') return `${V1}_global/${tail}`;
  const s = normaliseScope(scope);
  const account = opts.account ? opts.account.replace(/^0x/, '').toLowerCase() : '-';
  if (account !== '-' && !ACCOUNT_RE.test(account)) throw new StoreKeyError('bad account address');
  return `${V1}${s.network}/${s.evmAddress}/${account}/${tail}`;
}

export interface ParsedKey {
  scope: RecordScope;
  kind: RecordKind;
  id?: string;
}

/** Parse a v1 record key; null for anything that is not one. */
export function parseKey(key: string): ParsedKey | null {
  if (!key.startsWith(V1)) return null;
  const parts = key.slice(V1.length).split('/');
  const isKind = (k: string | undefined): k is RecordKind => (RECORD_KINDS as readonly string[]).includes(k ?? '');
  if (parts[0] === '_global') {
    const [, kind, id, ...rest] = parts;
    if (!isKind(kind) || rest.length > 0 || (id !== undefined && !ID_RE.test(id))) return null;
    return { scope: { global: true }, kind, ...(id !== undefined ? { id } : {}) };
  }
  const [network, evm, account, kind, id, ...rest] = parts;
  if (!network || !NETWORK_RE.test(network) || !evm || !EVM_RE.test(evm)) return null;
  if (account !== '-' && !ACCOUNT_RE.test(account ?? '')) return null;
  if (!isKind(kind) || rest.length > 0 || (id !== undefined && !ID_RE.test(id))) return null;
  return {
    scope: { global: false, network, evmAddress: evm, account: account === '-' ? null : account! },
    kind,
    ...(id !== undefined ? { id } : {}),
  };
}

export function inWalletScope(parsed: ParsedKey, scope: WalletScope): boolean {
  const s = normaliseScope(scope);
  return !parsed.scope.global && parsed.scope.network === s.network && parsed.scope.evmAddress === s.evmAddress;
}

export const StoredRecordSchema = z.object({
  v: z.literal(1),
  kind: z.enum(RECORD_KINDS),
  updatedAt: z.number().int().nonnegative(),
  data: z.unknown(),
});
export type StoredRecord<T = unknown> = { v: 1; kind: RecordKind; updatedAt: number; data: T };

export function encodeRecord<T>(kind: RecordKind, data: T, updatedAt: number): string {
  return JSON.stringify({ v: 1, kind, updatedAt, data });
}

// ── Export files (Q11) ──────────────────────────────────────────────────────

export const EXPORT_FORMAT = 'mn-bank-local-data';
export const EXPORT_FORMAT_VERSION = 1;

export const ExportFileSchema = z.object({
  format: z.literal(EXPORT_FORMAT),
  formatVersion: z.literal(EXPORT_FORMAT_VERSION),
  schemaVersion: z.number().int().positive(),
  exportedAt: z.string(),
  network: z.string().regex(NETWORK_RE),
  evmAddress: z.string().regex(EVM_RE),
  records: z.array(z.object({ key: z.string().startsWith(STORE_PREFIX).max(512), value: z.unknown() })).max(10_000),
});
export type ExportFile = z.infer<typeof ExportFileSchema>;
