'use client';
import { useCallback, useEffect, useState } from 'react';
import { Archive, Clock3, Plus, Save, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { FundingWalletPicker } from './funding-wallet-picker';
import { FundingFeeReviewPanel } from './funding-fee-review';
import { SolanaFundingReview } from './solana-funding-review';
import { DevnetFundingExecution } from './devnet-funding-execution';
import { MainnetFundingExecution } from './mainnet-funding-execution';
import { MainnetFundingHistoryPanel } from './mainnet-funding-history';
import { FundingExecutionHistoryPanel } from './funding-execution-history';
import { chainQuoteAssets } from '@/lib/quote-catalog';
import { LaunchFundingPicker } from './launch-funding-picker';
import type { LaunchWalletAssignments } from '@/lib/launch-wallets';
import {
  CHAINS,
  CURRENCIES_BY_CHAIN,
  type LaunchPlanInput,
} from '@/lib/launch-plan';
import {
  validateFunding,
  type FundingInput,
  type SavedFunding,
} from '@/lib/funding-plan';

function localTime(iso: string) {
  const date = new Date(iso);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 19);
}
export function FundingPlanner({
  plan,
  launchWallets,
}: {
  plan: LaunchPlanInput;
  launchWallets?: LaunchWalletAssignments;
}) {
  const [draft, setDraft] = useState<Omit<FundingInput, 'recipients'>>({
    name: `${plan.tokenName} funding`,
    chain: plan.chain,
    currency: CURRENCIES_BY_CHAIN[plan.chain][0],
    source: 'Manual',
    sourceLabel: '',
    funderAddress: '',
    startAt: '',
    delaySeconds: 10,
  });
  const [assetSearch, setAssetSearch] = useState('');
  const fundingAssets = chainQuoteAssets(draft.chain);
  const visibleAssets = fundingAssets
    .filter((a) =>
      `${a.symbol} ${a.address}`
        .toLowerCase()
        .includes(assetSearch.toLowerCase()),
    )
    .slice(0, 40);
  const selectedAsset = fundingAssets.find(
    (a) => a.address === draft.assetAddress,
  );
  const [lines, setLines] = useState('');
  const [saved, setSaved] = useState<SavedFunding[]>([]);
  const [selected, setSelected] = useState<{
    id: string;
    revision: number;
  } | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [handoffBusy, setHandoffBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const [historyId, setHistoryId] = useState<string | null>(null);
  const [executionRevision, setExecutionRevision] = useState(0);
  const refreshExecution = useCallback(
    () => setExecutionRevision((value) => value + 1),
    [],
  );
  const historyDraft = saved.find((row) => row.id === historyId);
  const mainnetPlan = saved.find(
    (row) => row.id === selected?.id && row.revision === selected.revision,
  );
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch('/api/funding', {
          cache: 'no-store',
          signal: controller.signal,
        });
        const data = (await response.json()) as {
          plans: SavedFunding[];
          error?: string;
        };
        if (!response.ok)
          throw new Error(data.error || 'Funding plans unavailable.');
        if (!controller.signal.aborted) {
          setSaved(data.plans);
          setError('');
          setDraft((v) =>
            v.startAt
              ? v
              : { ...v, startAt: new Date(Date.now() + 300000).toISOString() },
          );
        }
      } catch (e) {
        if (!controller.signal.aborted)
          setError(
            e instanceof Error ? e.message : 'Funding plans unavailable.',
          );
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [reload]);
  let preview: ReturnType<typeof validateFunding> | null = null;
  let invalid = '';
  try {
    const recipients = lines
      .trim()
      .split(/\r?\n/)
      .filter((line) => line.trim())
      .map((line) => {
        const parts = line.trim().split(/[\s,]+/);
        if (parts.length === 2) return { address: parts[0], amount: parts[1] };
        if (parts.length > 3 && parts[2] === 'via')
          return {
            address: parts[0],
            amount: parts[1],
            proxies: parts.slice(3),
          };
        throw new Error(
          'Use one public address and amount per line, optionally followed by via and 1 to 3 proxy wallets.',
        );
      });
    preview = validateFunding({ ...draft, recipients });
  } catch (e) {
    invalid = e instanceof Error ? e.message : 'Check the funding plan.';
  }
  const change = (patch: Partial<typeof draft>) => {
    setDraft((v) => ({ ...v, ...patch }));
    setNotice('');
  };
  const open = (row: SavedFunding) => {
    setHistoryId(row.id);
    setDraft(row.document);
    setLines(
      row.document.recipients
        .map(
          (r) =>
            `${r.address} ${r.amount}${r.proxies ? ' via ' + r.proxies.join(' ') : ''}`,
        )
        .join('\n'),
    );
    setSelected({ id: row.id, revision: row.revision });
    setNotice('');
    setError('');
  };
  const fresh = () => {
    setHistoryId(null);
    setSelected(null);
    setLines('');
    setNotice('');
    setError('');
    setDraft({
      name: `${plan.tokenName} funding`,
      chain: plan.chain,
      currency: CURRENCIES_BY_CHAIN[plan.chain][0],
      source: 'Manual',
      sourceLabel: '',
      funderAddress: '',
      startAt: new Date(Date.now() + 300000).toISOString(),
      delaySeconds: 10,
    });
  };
  async function persist(
    action: 'save' | 'archive' | 'restore',
    row?: SavedFunding,
  ) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const id = row?.id ?? selected?.id ?? crypto.randomUUID();
      const response = await fetch('/api/funding', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action,
          id,
          expectedRevision: row?.revision ?? selected?.revision ?? 0,
          document: action === 'save' ? preview : undefined,
        }),
      });
      const data = (await response.json()) as {
        revision: number;
        error?: string;
      };
      if (!response.ok)
        throw new Error(data.error || 'Funding plan could not be saved.');
      if (action === 'save') {
        setSelected({ id, revision: data.revision });
        setHistoryId(id);
      } else if (selected?.id === id) setSelected(null);
      setNotice(
        action === 'save'
          ? 'Funding draft saved. No funds moved.'
          : action === 'archive'
            ? 'Funding draft archived.'
            : 'Funding draft restored.',
      );
      setReload((v) => v + 1);
      setLoading(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Funding plan unavailable.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="funding-planner" aria-label="Funding plan editor">
      <header>
        <div>
          <span className="eyebrow">SAVED FUNDING PLANS</span>
          <h2>Plan every allocation.</h2>
          <p>
            Saved wallet drafts support EVM fee checks and Solana funding
            reviews. Solana mainnet transfers require one exact recipient,
            individual signing approval and separate submission approval.
            Immediate SOL and standard SPL drafts also support approved devnet
            transfers. Exchange connections and background scheduled execution
            remain unavailable.
          </p>
        </div>
        <Button
          variant="outline"
          disabled={busy || handoffBusy}
          onClick={fresh}
        >
          <Plus /> New plan
        </Button>
      </header>
      <fieldset disabled={busy || handoffBusy} className="funding-editor">
        <div className="funding-wide">
          <LaunchFundingPicker
            key={`${draft.chain}/${draft.currency}/${draft.assetAddress ?? 'legacy'}`}
            onBusyChange={setHandoffBusy}
            selection={launchWallets}
            plan={plan}
            chain={draft.chain}
            currency={draft.currency}
            assetAddress={draft.assetAddress}
            onApply={(recipients) => {
              validateFunding({ ...draft, recipients });
              setLines(
                recipients.map((r) => `${r.address} ${r.amount}`).join('\n'),
              );
              setNotice(
                'Launch allocations copied. Review the independent funding draft before saving.',
              );
            }}
          />
          <FundingWalletPicker
            chain={draft.chain}
            onApply={(addresses, amount) => {
              validateFunding({
                ...draft,
                recipients: addresses.map((address) => ({ address, amount })),
              });
              setLines(
                addresses.map((address) => `${address} ${amount}`).join('\n'),
              );
              setNotice(
                'Wallet folder recipients copied into the draft. Review before saving.',
              );
            }}
          />
        </div>
        <label htmlFor="funding-name">
          Plan name
          <Input
            id="funding-name"
            value={draft.name}
            maxLength={80}
            onChange={(e) => change({ name: e.target.value })}
          />
        </label>
        <label>
          Chain
          <select
            value={draft.chain}
            onChange={(e) => {
              const chain = e.target.value as FundingInput['chain'];
              change({
                chain,
                currency: CURRENCIES_BY_CHAIN[chain][0],
                assetAddress: undefined,
              });
            }}
          >
            {CHAINS.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </label>
        <label>
          Currency
          <select
            value={draft.currency}
            onChange={(e) =>
              change({ currency: e.target.value, assetAddress: undefined })
            }
          >
            {!CURRENCIES_BY_CHAIN[draft.chain].includes(draft.currency) && (
              <option>{draft.currency}</option>
            )}
            {CURRENCIES_BY_CHAIN[draft.chain].map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </label>
        <details className="funding-wide progressive-section">
          <summary>
            Funding asset{' '}
            {selectedAsset
              ? `: ${selectedAsset.symbol}`
              : ': legacy currency profile'}
          </summary>
          <p>
            Choose the exact captured token address to use its decimal
            precision. Catalog entries do not establish transfer availability.
          </p>
          {selectedAsset && (
            <p>
              <code>{selectedAsset.address}</code> · {selectedAsset.decimals}{' '}
              decimal places
            </p>
          )}
          <label htmlFor="funding-asset-search">
            Search funding assets
            <Input
              id="funding-asset-search"
              value={assetSearch}
              onChange={(e) => setAssetSearch(e.target.value)}
              placeholder="Symbol or token address"
            />
          </label>
          <label>
            Funding token address
            <select
              aria-label="Funding token address"
              value={draft.assetAddress ?? ''}
              onChange={(e) => {
                const asset = fundingAssets.find(
                  (a) => a.address === e.target.value,
                );
                change(
                  asset
                    ? { currency: asset.symbol, assetAddress: asset.address }
                    : {
                        currency: CURRENCIES_BY_CHAIN[draft.chain][0],
                        assetAddress: undefined,
                      },
                );
              }}
            >
              <option value="">Legacy currency profile</option>
              {selectedAsset &&
                !visibleAssets.some(
                  (a) => a.address === selectedAsset.address,
                ) && (
                  <option value={selectedAsset.address}>
                    {selectedAsset.symbol} · {selectedAsset.address}
                  </option>
                )}
              {visibleAssets.map((a) => (
                <option key={a.address} value={a.address}>
                  {a.symbol} · {a.address}
                </option>
              ))}
            </select>
          </label>
          <p>
            {visibleAssets.length} results shown. Search to narrow the catalog.
            Changing assets does not convert amounts; review each allocation.
          </p>
        </details>
        <label>
          Source type
          <select
            value={draft.source}
            onChange={(e) =>
              change({ source: e.target.value as FundingInput['source'] })
            }
          >
            {['Manual', 'Wallet', 'CEX'].map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </label>
        <label htmlFor="funding-source-label">
          Source label
          <Input
            id="funding-source-label"
            placeholder="Treasury or exchange name"
            maxLength={80}
            value={draft.sourceLabel}
            onChange={(e) => change({ sourceLabel: e.target.value })}
          />
        </label>
        <label className="funding-wide" htmlFor="funding-funder">
          Funder public address (optional)
          <Input
            id="funding-funder"
            placeholder="Public address only"
            value={draft.funderAddress}
            onChange={(e) => change({ funderAddress: e.target.value })}
          />
        </label>
        <div>
          <label htmlFor="funding-start">
            Start time (your local time)
            <Input
              id="funding-start"
              type="datetime-local"
              step={1}
              value={draft.startAt ? localTime(draft.startAt) : ''}
              onChange={(e) => {
                const d = new Date(e.target.value);
                change({
                  startAt: Number.isFinite(d.getTime()) ? d.toISOString() : '',
                });
              }}
            />
          </label>
          <Button
            type="button"
            variant="outline"
            onClick={() =>
              change({ startAt: new Date().toISOString(), delaySeconds: 0 })
            }
          >
            Use immediate timing
          </Button>
        </div>
        <label htmlFor="funding-delay">
          Delay between recipients (seconds)
          <Input
            id="funding-delay"
            type="number"
            min={0}
            max={86400}
            step={1}
            value={draft.delaySeconds}
            onChange={(e) => change({ delaySeconds: Number(e.target.value) })}
          />
        </label>
        <label className="funding-wide">
          Recipients and amounts
          <textarea
            aria-label="Funding recipients"
            rows={5}
            value={lines}
            placeholder="One public address and amount per line"
            onChange={(e) => {
              setLines(e.target.value);
              setNotice('');
            }}
          />
          <small>
            Up to 100 unique recipients. Example format: publicAddress 0.01.
            Classic proxy route (SOL only): publicAddress 0.01 via proxy1 proxy2
          </small>
        </label>
      </fieldset>
      {preview ? (
        <>
          <div className="funding-summary">
            <span>
              <small>TOTAL ALLOCATION</small>
              <strong>
                {preview.total} {draft.currency}
              </strong>
            </span>
            <span>
              <Clock3 size={18} />
              {preview.items.length} recipients · {draft.delaySeconds}s spacing
            </span>
          </div>
          <div className="funding-schedule">
            <table className="project-table">
              <thead>
                <tr>
                  <th>Recipient</th>
                  <th>Amount</th>
                  <th>Scheduled (local)</th>
                </tr>
              </thead>
              <tbody>
                {preview.items.map((r, i) => (
                  <tr key={r.address}>
                    <td>
                      <span className="funding-address" title={r.address}>
                        {i + 1}. {r.address}
                      </span>
                    </td>
                    <td>
                      {r.amount} {draft.currency}
                    </td>
                    <td>{new Date(r.scheduledAt).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : (
        <p className="funding-hint">
          {lines.trim()
            ? invalid
            : 'Add recipients to preview the itemized schedule.'}
        </p>
      )}
      <div className="funding-actions">
        <Button
          disabled={busy || handoffBusy || loading || !preview}
          onClick={() => void persist('save')}
        >
          <Save />
          {busy ? 'Saving…' : selected ? 'Save changes' : 'Save funding draft'}
        </Button>
        <Button
          variant="outline"
          disabled={busy || handoffBusy || loading}
          onClick={() => {
            setLoading(true);
            setReload((v) => v + 1);
          }}
        >
          Reload saved plans
        </Button>
        <span>{selected ? `Revision ${selected.revision}` : 'New draft'}</span>
      </div>
      {error && (
        <p role="alert" className="tracker-error">
          {error}
        </p>
      )}
      {notice && <output className="funding-notice">{notice}</output>}
      {selected && preview && preview.chain === 'Solana' && (
        <SolanaFundingReview
          key={
            selected.id +
            '/' +
            selected.revision +
            '/' +
            JSON.stringify(preview)
          }
          id={selected.id}
          revision={selected.revision}
          enabled={
            !busy &&
            !loading &&
            !handoffBusy &&
            saved.some(
              (row) =>
                row.id === selected.id &&
                !row.archived &&
                row.revision === selected.revision &&
                JSON.stringify(row.document) === JSON.stringify(preview),
            )
          }
        />
      )}
      {selected && preview && preview.chain !== 'Solana' && (
        <FundingFeeReviewPanel
          key={
            selected.id +
            '/' +
            selected.revision +
            '/' +
            JSON.stringify(preview)
          }
          id={selected.id}
          revision={selected.revision}
          enabled={
            !busy &&
            !loading &&
            !handoffBusy &&
            saved.some(
              (row) =>
                row.id === selected.id &&
                !row.archived &&
                row.revision === selected.revision &&
                JSON.stringify(row.document) === JSON.stringify(preview),
            )
          }
        />
      )}
      {selected &&
        preview?.chain === 'Solana' &&
        (preview.assetAddress || preview.currency === 'SOL') &&
        preview.source === 'Wallet' &&
        preview.funderAddress &&
        preview.delaySeconds === 0 && (
          <DevnetFundingExecution
            onReceiptChange={refreshExecution}
            key={
              selected.id +
              '/' +
              selected.revision +
              '/' +
              JSON.stringify(preview)
            }
            id={selected.id}
            revision={selected.revision}
            enabled={
              !busy &&
              !loading &&
              !handoffBusy &&
              saved.some(
                (row) =>
                  row.id === selected.id &&
                  !row.archived &&
                  row.revision === selected.revision &&
                  JSON.stringify(row.document) === JSON.stringify(preview),
              )
            }
          />
        )}
      {selected &&
        preview &&
        preview.chain === 'Solana' &&
        (preview.currency === 'SOL' || Boolean(preview.assetAddress)) &&
        mainnetPlan &&
        preview.source === 'Wallet' &&
        preview.funderAddress && (
          <MainnetFundingExecution
            key={`${selected.id}:${selected.revision}:${JSON.stringify(preview)}`}
            plan={mainnetPlan}
            enabled={
              !busy &&
              !loading &&
              !handoffBusy &&
              saved.some(
                (row) =>
                  row.id === selected.id &&
                  !row.archived &&
                  row.revision === selected.revision &&
                  JSON.stringify(row.document) === JSON.stringify(preview),
              )
            }
          />
        )}
      {historyDraft && (
        <MainnetFundingHistoryPanel
          key={`mainnet:${historyDraft.id}`}
          id={historyDraft.id}
          revision={historyDraft.revision}
          name={historyDraft.document.name}
        />
      )}
      {historyDraft && (
        <FundingExecutionHistoryPanel
          key={historyDraft.id}
          id={historyDraft.id}
          revision={historyDraft.revision}
          name={historyDraft.document.name}
          externalRevision={executionRevision}
        />
      )}
      <div className="funding-saved">
        <h3>
          Saved plans <small>{saved.length}/100</small>
        </h3>
        {loading ? (
          <p>Loading saved plans…</p>
        ) : !saved.length ? (
          <p>Your funding drafts will appear here.</p>
        ) : (
          saved.map((row) => (
            <div className="funding-saved-row" key={row.id}>
              <button
                disabled={busy || handoffBusy || row.archived}
                onClick={() => open(row)}
              >
                <strong>{row.document.name}</strong>
                <small>
                  {row.document.chain} · {row.document.total}{' '}
                  {row.document.currency} ·{' '}
                  {row.archived
                    ? 'Archived'
                    : `${row.document.items.length} recipients`}{' '}
                  · r{row.revision}
                </small>
              </button>
              <Button
                variant="outline"
                disabled={busy || handoffBusy}
                aria-label={`View execution history for ${row.document.name}`}
                onClick={() => setHistoryId(row.id)}
              >
                View execution history
              </Button>
              <Button
                variant="outline"
                disabled={busy || handoffBusy}
                aria-label={`${row.archived ? 'Restore' : 'Archive'} ${row.document.name}`}
                onClick={() =>
                  void persist(row.archived ? 'restore' : 'archive', row)
                }
              >
                {row.archived ? <RotateCcw /> : <Archive />}
                {row.archived ? 'Restore' : 'Archive'}
              </Button>
            </div>
          ))
        )}
      </div>
    </section>
  );
}
