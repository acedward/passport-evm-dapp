// The Local data tab (spec US4, FR-004, Q11): every record the bank keeps in this browser, with
// secrets masked until revealed, and Export, Import and CLEAR ALL.

import { useMemo, useRef, useState, type ChangeEvent } from 'react';

import { useStore } from '../store/StoreContext.js';
import { ImportError, type RecordView } from '../store/store.js';
import { useWallet } from '../wallet/WalletContext.js';

export const CLEAR_ALL_PHRASE = 'CLEAR ALL';

const short = (s: string, head = 6, tail = 4) =>
  s.length <= head + tail + 1 ? s : `${s.slice(0, head)}…${s.slice(-tail)}`;
const when = (ms: number | null) => (ms === null ? '—' : new Date(ms).toISOString().replace('T', ' ').slice(0, 19));

function download(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function LocalData({ network }: { network: string }) {
  const { status, store, revision } = useStore();
  const wallet = useWallet();
  const [revealed, setRevealed] = useState<ReadonlySet<string>>(new Set());
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [phrase, setPhrase] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);

  // `revision` changes on every write here or in another tab.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const records = useMemo<RecordView[]>(() => store?.list() ?? [], [store, revision]);
  const scope = wallet.address ? { network, evmAddress: wallet.address } : null;
  const mine = scope
    ? records.filter(
        (r) =>
          !r.parsed.scope.global &&
          r.parsed.scope.network === network &&
          r.parsed.scope.evmAddress === scope.evmAddress.toLowerCase(),
      )
    : [];
  const wallets = new Set(
    records
      .filter((r) => !r.parsed.scope.global)
      .map((r) => (r.parsed.scope.global ? '' : `${r.parsed.scope.network}/${r.parsed.scope.evmAddress}`)),
  );

  const exportMine = () => {
    if (!store || !scope) return;
    const file = store.exportWallet(scope);
    const date = new Date().toISOString().slice(0, 10);
    download(
      `mn-bank-${network}-${scope.evmAddress.toLowerCase().slice(0, 10)}-${date}.json`,
      `${JSON.stringify(file, null, 2)}\n`,
    );
    setMessage({
      kind: 'ok',
      text: `Exported ${file.records.length} records. Keep the file safe: it holds your account's viewing secret.`,
    });
  };

  const onImport = async (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f || !store) return;
    if (!scope) {
      setMessage({ kind: 'error', text: 'Connect the wallet the file belongs to before importing it.' });
      return;
    }
    try {
      const json: unknown = JSON.parse(await f.text());
      const r = store.importWallet(json, scope);
      setMessage({
        kind: 'ok',
        text: `Imported ${r.imported} records${r.replaced ? ` (${r.replaced} replaced)` : ''}.`,
      });
    } catch (err) {
      setMessage({
        kind: 'error',
        text:
          err instanceof ImportError
            ? err.message
            : 'This file could not be read as an MN Bank export. Nothing was imported.',
      });
    }
  };

  const clearAll = () => {
    if (!store || phrase !== CLEAR_ALL_PHRASE) return;
    const n = store.clearAll();
    setConfirming(false);
    setPhrase('');
    setRevealed(new Set());
    setMessage({ kind: 'ok', text: `Removed ${n} keys. MN Bank keeps nothing in this browser now.` });
  };

  const toggle = (key: string) =>
    setRevealed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <section aria-labelledby="local-data-title" data-testid="local-data">
      <h2 id="local-data-title">Local data</h2>
      <p>
        Everything MN Bank keeps about you stays in this browser: your account, its encryption secret, your coins,
        transfers and offers. The bank's servers keep none of it. Without this data your account's funds cannot be
        spent, so export it and keep the file safe.
      </p>

      {status !== 'ok' && (
        <div role="alert" className="notice error" data-testid="storage-blocked">
          {status === 'full'
            ? 'This browser has no room left for MN Bank data. Free some site data, then reload.'
            : 'This browser is not letting MN Bank keep data (a private window, or site data is blocked). You cannot open or use an account here.'}
        </div>
      )}
      {store?.readOnly && (
        <div role="alert" className="notice error" data-testid="store-read-only">
          This browser holds data from a newer version of MN Bank. This page will not change it.
        </div>
      )}

      <div className="actions">
        <button
          type="button"
          data-testid="export"
          onClick={exportMine}
          disabled={!store || !scope || mine.length === 0}
        >
          Export this wallet's data
        </button>
        <button
          type="button"
          data-testid="import"
          onClick={() => fileInput.current?.click()}
          disabled={!store || !scope}
        >
          Import
        </button>
        <input
          ref={fileInput}
          type="file"
          accept="application/json,.json"
          hidden
          data-testid="import-file"
          onChange={(e) => void onImport(e)}
        />
        <button
          type="button"
          className="danger"
          data-testid="clear-all"
          onClick={() => setConfirming(true)}
          disabled={!store || records.length === 0}
        >
          CLEAR ALL
        </button>
      </div>
      {!scope && store && <p className="hint">Connect your wallet to export or import its data.</p>}
      {message && (
        <p role="status" className={`notice ${message.kind}`} data-testid="local-message">
          {message.text}
        </p>
      )}

      {records.length === 0 ? (
        <p data-testid="records-empty">MN Bank keeps nothing in this browser.</p>
      ) : (
        <div className="table-wrap">
          <table data-testid="records">
            <thead>
              <tr>
                <th scope="col">Network</th>
                <th scope="col">Wallet</th>
                <th scope="col">Account</th>
                <th scope="col">Record</th>
                <th scope="col">Size</th>
                <th scope="col">Updated (UTC)</th>
                <th scope="col">Value</th>
              </tr>
            </thead>
            <tbody>
              {records.map((r) => {
                const s = r.parsed.scope;
                const value = r.record ? JSON.stringify(r.record.data) : '(unreadable)';
                const shown = !r.sensitive || revealed.has(r.key);
                return (
                  <tr key={r.key} data-testid="record-row" data-kind={r.parsed.kind} data-key={r.key}>
                    <td>{s.global ? 'all' : s.network}</td>
                    <td title={s.global ? undefined : s.evmAddress}>{s.global ? 'all' : short(s.evmAddress)}</td>
                    <td title={s.global || !s.account ? undefined : s.account}>
                      {s.global || !s.account ? '—' : short(s.account, 8, 6)}
                    </td>
                    <td>
                      {r.parsed.kind}
                      {r.parsed.id ? ` / ${r.parsed.id}` : ''}
                    </td>
                    <td>{r.bytes} B</td>
                    <td>{when(r.updatedAt)}</td>
                    <td className="value">
                      {shown ? (
                        <code data-testid="record-value">{value.length > 240 ? `${value.slice(0, 240)}…` : value}</code>
                      ) : (
                        <span data-testid="record-masked">••••••••</span>
                      )}
                      {r.sensitive && (
                        <button type="button" className="link" data-testid="reveal" onClick={() => toggle(r.key)}>
                          {shown ? 'Hide' : 'Reveal'}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {confirming && (
        <div className="overlay">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="clear-title"
            className="dialog"
            data-testid="clear-dialog"
          >
            <h3 id="clear-title">Clear all MN Bank data from this browser?</h3>
            <p>
              This removes all {records.length} records MN Bank keeps here, for {wallets.size} wallet
              {wallets.size === 1 ? '' : 's'}. Your account's coins can only be spent with this data: unless you have a
              recent export, export it first.
            </p>
            {scope && mine.length > 0 && (
              <button type="button" data-testid="clear-export-first" onClick={exportMine}>
                Export this wallet's data first
              </button>
            )}
            <label htmlFor="clear-phrase">
              Type <strong>{CLEAR_ALL_PHRASE}</strong> to confirm
            </label>
            <input
              id="clear-phrase"
              data-testid="clear-confirm-input"
              autoComplete="off"
              value={phrase}
              onChange={(e) => setPhrase(e.target.value)}
            />
            <div className="actions">
              <button
                type="button"
                className="danger"
                data-testid="clear-confirm"
                disabled={phrase !== CLEAR_ALL_PHRASE}
                onClick={clearAll}
              >
                Clear all data
              </button>
              <button
                type="button"
                data-testid="clear-cancel"
                onClick={() => {
                  setConfirming(false);
                  setPhrase('');
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
