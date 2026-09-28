// The Local data tab (spec US4, FR-004, Q11): every record the bank keeps in this browser, with
// secrets masked until revealed, and Export, Import and CLEAR ALL. Styled with the MN Bank design
// system (plan P1.5): a ruled record table that stacks on a phone, and the CLEAR ALL dialog with
// "Export first" and a typed confirmation.

import { useMemo, useRef, useState, type ChangeEvent } from 'react';

import {
  Button,
  ButtonRow,
  Cell,
  EmptyState,
  Notice,
  PageHead,
  Panel,
  StatementTable,
  Sub,
  TypedConfirmDialog,
} from '../design/index.js';
import { RelayClient } from '../relay/client.js';
import { storageText } from '../store/messages.js';
import { useStore } from '../store/StoreContext.js';
import { MAX_IMPORT_FILE_BYTES, SCHEMA_VERSION, STORE_PREFIX } from '../store/schema.js';
import { ImportError, type LocalStore, type RecordView } from '../store/store.js';
import { useWallet } from '../wallet/WalletContext.js';

export const CLEAR_ALL_PHRASE = 'CLEAR ALL';

const short = (s: string, head = 6, tail = 4) =>
  s.length <= head + tail + 1 ? s : `${s.slice(0, head)}…${s.slice(-tail)}`;
const when = (ms: number | null) => (ms === null ? '—' : new Date(ms).toISOString().replace('T', ' ').slice(0, 19));
const size = (bytes: number) => (bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`);

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

/**
 * Import as one change (security review F-B5): check the whole file first; an encryption secret it
 * would replace with a different one is accepted only when the new public key is the account's
 * on-chain key (so a file cannot swap in a key that opens nothing); then write it all or nothing.
 */
export async function importFile(
  store: LocalStore,
  relay: Pick<RelayClient, 'accountState'>,
  file: unknown,
  scope: { network: string; evmAddress: string },
): Promise<{ imported: number; replaced: number }> {
  const plan = store.prepareImport(file, scope);
  const approved = new Set<string>();
  for (const c of plan.secretChanges) {
    if (!c.account) continue;
    const state = await relay.accountState(c.account).catch(() => null);
    if (state && state.encKey === c.encPublicKey) approved.add(c.account);
  }
  return store.commitImport(plan, { approvedSecretReplacements: approved });
}

export function LocalData({ network, relayUrl }: { network: string; relayUrl: string }) {
  const { status, store, revision } = useStore();
  const wallet = useWallet();
  const [revealed, setRevealed] = useState<ReadonlySet<string>>(new Set());
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [confirming, setConfirming] = useState(false);
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
  const totalBytes = records.reduce((n, r) => n + r.bytes, 0);

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
    if (f.size > MAX_IMPORT_FILE_BYTES) {
      setMessage({
        kind: 'error',
        text: 'This file is larger than an MN Bank export can be (5 MB). Nothing was imported.',
      });
      return;
    }
    try {
      const json: unknown = JSON.parse(await f.text());
      const r = await importFile(store, new RelayClient(relayUrl), json, scope);
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
    if (!store) return;
    const n = store.clearAll();
    setConfirming(false);
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
      <PageHead
        eyebrow="Your records"
        title="Local data"
        titleId="local-data-title"
        lede="Everything MN Bank keeps about you stays in this browser: your account, its encryption secret, your coins, transfers and offers. The bank's servers keep none of it. Without this data your account's funds cannot be spent, so export it and keep the file safe."
      />

      {status !== 'ok' && (
        <Notice
          tone="danger"
          role="alert"
          className="panel-intro"
          data-testid="storage-blocked"
          data-status={status}
          title={storageText(status).title}
        >
          {storageText(status).text}
        </Notice>
      )}
      {store?.readOnly && (
        <Notice tone="danger" role="alert" className="panel-intro" data-testid="store-read-only">
          This browser holds data from a newer version of MN Bank. This page will not change it.
        </Notice>
      )}
      {message && (
        <Notice
          tone={message.kind === 'error' ? 'danger' : 'success'}
          role="status"
          className="panel-intro"
          data-testid="local-message"
        >
          {message.text}
        </Notice>
      )}

      <Panel>
        <p className="ns-line">
          Stored under <span className="mono">{STORE_PREFIX}v1/…</span> · schema version {SCHEMA_VERSION} ·{' '}
          {records.length} {records.length === 1 ? 'record' : 'records'} ·{' '}
          <span className="num">{size(totalBytes)}</span>
          {wallets.size > 1 ? ` · ${wallets.size} wallets` : ''}
        </p>

        {records.length === 0 ? (
          <EmptyState data-testid="records-empty" title="Nothing stored">
            MN Bank keeps nothing in this browser.
          </EmptyState>
        ) : (
          <StatementTable
            data-testid="records"
            caption="Records kept in this browser"
            columns={[
              { label: 'Record' },
              { label: 'Contents' },
              { label: 'Size', align: 'right' },
              { label: 'Updated', sub: 'UTC', align: 'right' },
            ]}
          >
            {records.map((r) => {
              const s = r.parsed.scope;
              const value = r.record ? JSON.stringify(r.record.data) : '(unreadable)';
              const shown = !r.sensitive || revealed.has(r.key);
              return (
                <tr key={r.key} data-testid="record-row" data-kind={r.parsed.kind} data-key={r.key}>
                  <Cell block>
                    <strong>
                      {r.parsed.kind}
                      {r.parsed.id ? ` / ${r.parsed.id}` : ''}
                    </strong>
                    <Sub multiline>
                      {s.global ? (
                        'all networks and wallets'
                      ) : (
                        <>
                          {s.network} · wallet <span title={s.evmAddress}>{short(s.evmAddress)}</span>
                          {s.account ? (
                            <>
                              {' '}
                              · account <span title={s.account}>{short(s.account, 8, 6)}</span>
                            </>
                          ) : null}
                        </>
                      )}
                    </Sub>
                  </Cell>
                  <Cell label="Contents">
                    <span className="record-contents">
                      {shown ? (
                        <code data-testid="record-value">{value.length > 240 ? `${value.slice(0, 240)}…` : value}</code>
                      ) : (
                        <span className="secret-mask" data-testid="record-masked">
                          <span aria-hidden="true">••••••••••••••••</span>
                          <span className="sr-only">hidden until you reveal it</span>
                        </span>
                      )}
                      {r.sensitive && (
                        <Button
                          variant="secondary"
                          size="small"
                          data-testid="reveal"
                          aria-pressed={shown}
                          onClick={() => toggle(r.key)}
                        >
                          {shown ? 'Hide' : 'Reveal'}
                        </Button>
                      )}
                    </span>
                  </Cell>
                  <Cell label="Size" align="right" num>
                    {r.bytes} B
                  </Cell>
                  <Cell label="Updated" align="right" num>
                    {when(r.updatedAt)}
                  </Cell>
                </tr>
              );
            })}
          </StatementTable>
        )}

        <div className="danger-zone">
          <div>
            <ButtonRow>
              <Button
                variant="secondary"
                data-testid="export"
                onClick={exportMine}
                disabled={!store || !scope || mine.length === 0}
              >
                Export this wallet&apos;s data
              </Button>
              <Button
                variant="secondary"
                data-testid="import"
                onClick={() => fileInput.current?.click()}
                disabled={!store || !scope}
              >
                Import
              </Button>
              <input
                ref={fileInput}
                type="file"
                accept="application/json,.json"
                hidden
                data-testid="import-file"
                onChange={(e) => void onImport(e)}
              />
            </ButtonRow>
            <p className="explain">
              {scope
                ? `Export saves this wallet's records as a JSON file, including the encryption secret: keep it as safe as a bank card. Import accepts only a file for ${network} and this wallet.`
                : 'Connect your wallet to export or import its data.'}
            </p>
          </div>
          <Button
            variant="danger"
            data-testid="clear-all"
            onClick={() => setConfirming(true)}
            disabled={!store || records.length === 0}
          >
            CLEAR ALL
          </Button>
        </div>
      </Panel>

      <TypedConfirmDialog
        open={confirming}
        title="Clear all MN Bank data from this browser?"
        phrase={CLEAR_ALL_PHRASE}
        testIdPrefix="clear"
        warning={
          <>
            <strong>Without an export you cannot spend these funds again.</strong> Your account&apos;s coins can only be
            spent with this data: unless you have a recent export, export it first.
          </>
        }
        onExportFirst={scope && mine.length > 0 ? exportMine : undefined}
        exportLabel="Export this wallet's data first"
        confirmLabel="Clear all data"
        onConfirm={clearAll}
        onCancel={() => setConfirming(false)}
      >
        <p>
          This removes all {records.length} records MN Bank keeps here, for {wallets.size} wallet
          {wallets.size === 1 ? '' : 's'}. The bank&apos;s servers have no copy.
        </p>
      </TypedConfirmDialog>
    </section>
  );
}
