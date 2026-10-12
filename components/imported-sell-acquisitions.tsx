'use client';
import { useEffect, useRef, useState, useId } from 'react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { ImportedSwapPreparation } from './imported-swap-preparation';
import {
  importedLotPage,
  type ImportedLotPage,
} from '@/lib/imported-lot-links';
import {
  importedSellAcquisitions,
  importedSellSourcePreview,
  importedSellSource,
  importedSellBasketPlan,
  type ImportedSellAllocationDraft,
} from '@/lib/imported-sell-acquisitions';
import { formatNativeBalance } from '@/lib/wallet-balance-format';
import { subscribeImportedReceiptSaved } from '@/lib/imported-receipt-events';
type Props = Omit<
  Parameters<typeof ImportedSwapPreparation>[0],
  'buyReceiptId' | 'buyAllocations' | 'side'
> & { initialBuyReceiptId?: string; onAmountChange: (amount: string) => void };
export function ImportedSellAcquisitions({
  project,
  wallet,
  amount,
  locked,
  onReviewBuy,
  initialBuyReceiptId,
  onAmountChange,
}: Props) {
  const [page, setPage] = useState<ImportedLotPage | null>(null),
    [sourceId, setSourceId] = useState(initialBuyReceiptId ?? ''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [search, setSearch] = useState(''),
    [index, setIndex] = useState(0);
  const [basket, setBasket] = useState(false),
    [drafts, setDrafts] = useState<ImportedSellAllocationDraft[]>([]);
  const [tradeNotice, setTradeNotice] = useState('');
  const field = useId();
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  useEffect(
    () =>
      subscribeImportedReceiptSaved(
        {
          projectId: project.id,
          mint: project.document.token.address,
          wallet: wallet.address,
        },
        () => {
          pending.current?.abort();
          pending.current = null;
          setBusy(false);
          setPage(null);
          setError('');
          setTradeNotice(
            'A trade finalized for this wallet. Review recorded acquisitions again before preparing a linked sell.',
          );
        },
      ),
    [project.id, project.document.token.address, wallet.address],
  );
  async function read() {
    pending.current?.abort();
    const c = new AbortController();
    pending.current = c;
    setPage(null);
    setBusy(true);
    setError('');
    setIndex(0);
    try {
      const response = await fetch(
        '/api/imported-projects/lot-links?projectId=' +
          encodeURIComponent(project.id),
        {
          cache: 'no-store',
          signal: AbortSignal.any([c.signal, AbortSignal.timeout(25000)]),
        },
      );
      const data = await response.json();
      if (!response.ok)
        throw new Error(
          (data as { error?: string })?.error ||
            'Acquisition history unavailable.',
        );
      const value = importedLotPage(
        data,
        project.id,
        project.document.token.address,
        project.document.token.decimals,
      );
      if (!c.signal.aborted && pending.current === c) {
        setPage(value);
        setTradeNotice('');
      }
    } catch (e) {
      if (!c.signal.aborted && pending.current === c)
        setError(
          e instanceof Error ? e.message : 'Acquisition history unavailable.',
        );
    } finally {
      if (!c.signal.aborted && pending.current === c) setBusy(false);
    }
  }
  let source: ReturnType<typeof importedSellSource> | undefined;
  if (sourceId && page)
    try {
      source = importedSellSource(page, wallet.address, sourceId);
    } catch {}
  let preview: ReturnType<typeof importedSellSourcePreview> | undefined,
    sourceError = '';
  if (sourceId && page)
    try {
      preview = importedSellSourcePreview(
        page,
        wallet.address,
        sourceId,
        amount,
      );
    } catch (e) {
      sourceError =
        e instanceof Error ? e.message : 'Selected acquisition unavailable.';
    }
  let plan: ReturnType<typeof importedSellBasketPlan> | undefined,
    basketError = '';
  if (basket && page)
    try {
      plan = importedSellBasketPlan(page, wallet.address, drafts, amount);
    } catch (e) {
      basketError = e instanceof Error ? e.message : 'Allocation unavailable.';
    }
  function choose(id: string) {
    if (!basket) {
      setSourceId(id);
      return;
    }
    if (
      !page ||
      drafts.length >= 8 ||
      drafts.some((d) => d.buyReceiptId === id)
    )
      return;
    const source = importedSellSource(page, wallet.address, id);
    setDrafts((previous) =>
      previous.length >= 8 || previous.some((d) => d.buyReceiptId === id)
        ? previous
        : [...previous, { buyReceiptId: id, amount: source.remainingAmount }],
    );
  }
  const ready = !sourceId || Boolean(preview?.covered);
  const choices = page
    ? importedSellAcquisitions(page, wallet.address, search, index)
    : null;
  return (
    <section
      className="imported-sell-acquisitions"
      aria-label="Sell acquisition selection"
    >
      <h4>Choose sell accounting</h4>
      {tradeNotice && <output className="block">{tradeNotice}</output>}
      <p>
        Select a recorded buy from this wallet, or review an inventory sale
        without a recorded source. Remaining recorded units are accounting
        capacity, not current holdings. Preparation checks the live balance and
        captures fresh source evidence before approval.
      </p>
      <div className="imported-sell-actions">
        <Button
          variant="outline"
          disabled={busy || locked}
          onClick={() => void read()}
        >
          {busy
            ? 'Reading acquisitions…'
            : page
              ? 'Reload recorded acquisitions'
              : 'Review recorded acquisitions'}
        </Button>
        <Button
          variant="outline"
          disabled={locked || (!sourceId && !basket)}
          onClick={() => {
            setBasket(false);
            setDrafts([]);
            setSourceId('');
          }}
        >
          Use unlinked inventory
        </Button>
        <Button
          variant="outline"
          disabled={locked || busy || !page}
          onClick={() => {
            if (basket) {
              setSourceId(drafts[0]?.buyReceiptId ?? sourceId);
              setBasket(false);
              return;
            }
            setDrafts(
              source
                ? [
                    {
                      buyReceiptId: source.buy.id,
                      amount: preview?.covered
                        ? amount
                        : source.remainingAmount,
                    },
                  ]
                : [],
            );
            setBasket(true);
          }}
        >
          {basket ? 'Use one acquisition' : 'Allocate across multiple buys'}
        </Button>
      </div>
      {basket && (
        <section
          className="imported-sell-source"
          aria-label="Multiple sell allocations"
        >
          <h5>Allocate this sale</h5>
          <p>
            Add two to eight recorded buys below. Enter exact units for each
            source, then review their combined amount and cost.
          </p>
          {drafts.map((d) => {
            let remaining = 'Unavailable';
            try {
              if (page)
                remaining = importedSellSource(
                  page,
                  wallet.address,
                  d.buyReceiptId,
                ).remainingAmount;
            } catch {}
            return (
              <div key={d.buyReceiptId}>
                <label htmlFor={field + '-' + d.buyReceiptId}>
                  Units from buy <code>{d.buyReceiptId}</code>
                </label>
                <Input
                  id={field + '-' + d.buyReceiptId}
                  aria-label={'Units from buy ' + d.buyReceiptId}
                  value={d.amount}
                  disabled={locked || busy}
                  inputMode="decimal"
                  onChange={(e) =>
                    setDrafts((previous) =>
                      previous.map((part) =>
                        part.buyReceiptId === d.buyReceiptId
                          ? { ...part, amount: e.target.value }
                          : part,
                      ),
                    )
                  }
                />
                <p>Remaining recorded units: {remaining}.</p>
                <Button
                  variant="outline"
                  disabled={locked || busy}
                  onClick={() =>
                    setDrafts((previous) =>
                      previous.filter(
                        (part) => part.buyReceiptId !== d.buyReceiptId,
                      ),
                    )
                  }
                >
                  Remove acquisition {d.buyReceiptId}
                </Button>
              </div>
            );
          })}
          {basketError && <p role="alert">{basketError}</p>}
          {plan && (
            <>
              <p>
                Allocated input {plan.totalAmount}{' '}
                {project.document.token.symbol}. Combined buy cost, including
                proportional buy fees:{' '}
                {formatNativeBalance(plan.allocatedCostLamports, 9)} SOL.
              </p>
              {!plan.matches && (
                <p role="alert">
                  Allocated units must equal the sell amount. Edit the source
                  units or use the allocated total.
                </p>
              )}
              <Button
                variant="outline"
                disabled={locked || busy}
                onClick={() => onAmountChange(plan.totalAmount)}
              >
                Use allocated total
              </Button>
            </>
          )}
          {!page && (
            <p>Review recorded acquisitions before preparing this sale.</p>
          )}
        </section>
      )}
      {sourceId && !basket && !page && (
        <p>
          Selected buy receipt <code>{sourceId}</code>. Review recorded
          acquisitions before preparing this sell.
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      {!basket && sourceError && <p role="alert">{sourceError}</p>}
      {!basket && source && (
        <section
          className="imported-sell-source"
          aria-label="Selected sell source"
        >
          <h5>Selected buy receipt</h5>
          <p>
            <code>{source.buy.id}</code>. Captured project revision{' '}
            {source.buy.projectRevision}, wallet revision{' '}
            {source.buy.walletRevision}. Finalized slot{' '}
            {source.buy.document.slot}.
          </p>
          <p>
            Acquired{' '}
            {formatNativeBalance(source.lot.acquiredRaw, page!.decimals)}{' '}
            {project.document.token.symbol}. Already assigned{' '}
            {formatNativeBalance(source.lot.assignedSoldRaw, page!.decimals)}.
            Remaining recorded units {source.remainingAmount}.
          </p>
          <Button
            variant="outline"
            disabled={locked || busy || source.lot.unassignedRaw === '0'}
            onClick={() => onAmountChange(source!.remainingAmount)}
          >
            Use remaining recorded units
          </Button>
          {preview?.covered ? (
            <p>
              Allocated buy cost for this sell, including proportional buy fees:{' '}
              {formatNativeBalance(preview.allocatedCostLamports!, 9)} SOL. The
              server rechecks this source before saving and approving.
            </p>
          ) : preview ? (
            <p role="alert">
              {source.lot.unassignedRaw === '0'
                ? 'This acquisition has no remaining recorded units. Choose another recorded buy or explicitly use unlinked inventory.'
                : 'This amount exceeds the selected buy’s remaining recorded units. Reduce the sell amount or explicitly use unlinked inventory.'}
            </p>
          ) : null}
        </section>
      )}
      {page && (
        <details open={basket || !sourceId}>
          <summary>Browse recorded acquisitions ({choices!.total})</summary>
          <p>
            Complete recorded history read {page.observedAt}. Accounting
            revision {page.revision}.
          </p>
          <label htmlFor={field + '-search'}>
            Find a buy receipt
            <Input
              id={field + '-search'}
              aria-label="Find a buy receipt"
              value={search}
              disabled={locked || busy}
              onChange={(e) => {
                setSearch(e.target.value);
                setIndex(0);
              }}
              placeholder="Receipt, signature or project revision"
            />
          </label>
          <ImportedSellAcquisitionChoices
            choices={choices!}
            decimals={page.decimals}
            symbol={project.document.token.symbol}
            selectedId={sourceId}
            locked={locked || busy || (basket && drafts.length >= 8)}
            selectedIds={basket ? drafts.map((d) => d.buyReceiptId) : undefined}
            onSelect={choose}
          />
          <p>
            Acquisition page {choices!.index + 1} of {choices!.pages}.{' '}
            {choices!.total} matching buys with remaining recorded units.
          </p>
          <Button
            variant="outline"
            disabled={locked || busy || choices!.index === 0}
            onClick={() => setIndex(choices!.index - 1)}
          >
            Previous acquisitions
          </Button>
          <Button
            variant="outline"
            disabled={locked || busy || choices!.index + 1 >= choices!.pages}
            onClick={() => setIndex(choices!.index + 1)}
          >
            Next acquisitions
          </Button>
        </details>
      )}
      {!basket && !sourceId && (
        <p>
          No recorded acquisition selected. This sale will remain unlinked
          unless you assign its finalized receipt later.
        </p>
      )}
      <ImportedSwapPreparation
        key={[
          project.revision,
          wallet.revision,
          amount,
          sourceId,
          basket ? JSON.stringify(drafts) : '',
          basket
            ? drafts
                .map(
                  (d) =>
                    page?.receiptDocumentHashes[d.buyReceiptId] ?? 'missing',
                )
                .join(',')
            : '',
          page?.revision ?? 'unread',
          sourceId ? (page?.receiptDocumentHashes[sourceId] ?? 'missing') : '',
        ].join(':')}
        project={project}
        wallet={wallet}
        amount={amount}
        side="Sell"
        buyReceiptId={!basket ? sourceId || undefined : undefined}
        buyAllocations={basket ? plan?.allocations : undefined}
        locked={locked || busy || (basket ? !plan?.matches : !ready)}
        onReviewBuy={onReviewBuy}
      />
    </section>
  );
}
export function ImportedSellAcquisitionChoices({
  choices,
  decimals,
  symbol,
  selectedId,
  selectedIds,
  locked,
  onSelect,
}: {
  choices: ReturnType<typeof importedSellAcquisitions>;
  decimals: number;
  symbol: string;
  selectedId: string;
  selectedIds?: string[];
  locked: boolean;
  onSelect: (id: string) => void;
}) {
  if (!choices.total)
    return (
      <p>No matching recorded buys with remaining units for this wallet.</p>
    );
  return (
    <div className="project-table-wrap">
      <table
        className="project-table"
        aria-label="Available recorded acquisitions"
      >
        <thead>
          <tr>
            <th>Acquisition</th>
            <th>Remaining recorded units</th>
            <th>Unassigned buy cost</th>
            <th>Review</th>
          </tr>
        </thead>
        <tbody>
          {choices.rows.map(({ receipt, lot }) => (
            <tr key={receipt.id}>
              <td>
                <code>{receipt.id}</code>
                <br />
                Project r{receipt.projectRevision} · wallet r
                {receipt.walletRevision} · slot {receipt.document.slot}
              </td>
              <td>
                {formatNativeBalance(lot.unassignedRaw, decimals)} {symbol}
              </td>
              <td>{formatNativeBalance(lot.unassignedCostLamports, 9)} SOL</td>
              <td>
                <Button
                  variant="outline"
                  disabled={
                    locked || Boolean(selectedIds?.includes(receipt.id))
                  }
                  aria-pressed={
                    selectedIds
                      ? selectedIds.includes(receipt.id)
                      : selectedId === receipt.id
                  }
                  onClick={() => onSelect(receipt.id)}
                >
                  {selectedIds
                    ? selectedIds.includes(receipt.id)
                      ? 'Included acquisition'
                      : 'Add acquisition'
                    : selectedId === receipt.id
                      ? 'Selected acquisition'
                      : 'Choose acquisition'}{' '}
                  {receipt.id}
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
