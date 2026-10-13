'use client';
import { readPanelJson } from './read-panel-json';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import type { ImportedTokenProject } from '@/lib/imported-token-project';
import {
  importedLotPage,
  importedLotAssignmentPreview,
  type ImportedLotPage,
} from '@/lib/imported-lot-links';
import {
  formatNativeBalance,
  signedBalanceAmount,
} from '@/lib/wallet-balance-format';

export function ImportedLinkedResults({ page }: { page: ImportedLotPage }) {
  const p = page.performance;
  return (
    <div>
      {page.expenses.storageUnavailable && (
        <p role="alert">
          Bundle cost storage is unavailable. Known trade fees remain visible,
          but complete profit totals are withheld.
        </p>
      )}
      <p>
        Retained bundle tips:{' '}
        {page.expenses.storageUnavailable
          ? 'Unavailable'
          : formatNativeBalance(page.expenses.bundleTipLamports, 9) + ' SOL'}
        . Tip transaction fees:{' '}
        {page.expenses.storageUnavailable
          ? 'Unavailable'
          : formatNativeBalance(page.expenses.bundleFeeLamports, 9) + ' SOL'}
        .
      </p>
      {!!page.expenses.missingBundleCostCount && (
        <p role="alert">
          {page.expenses.missingBundleCostCount} bundles have incomplete cost
          evidence. Linked results include known costs only.
        </p>
      )}
      <p>
        Linked sales: {p.linkedSaleCount}. Sales without an assigned
        acquisition: {p.unlinkedSaleCount}.
      </p>
      <dl>
        <dt>Assigned buy cost, including allocated buy fees</dt>
        <dd>{formatNativeBalance(p.assignedCostLamports, 9)} SOL</dd>
        <dt>Assigned sell proceeds after sell fees</dt>
        <dd>{signedBalanceAmount(p.netAssignedProceedsLamports, 9)} SOL</dd>
        <dt>Result for linked sales</dt>
        <dd>
          {p.linkedSaleCount
            ? signedBalanceAmount(p.assignedResultLamports, 9) + ' SOL'
            : 'No linked sales'}
        </dd>
        <dt>Result across all saved sales</dt>
        <dd>
          {p.realizedResultLamports === null
            ? p.linkedSaleCount + p.unlinkedSaleCount === 0
              ? 'No finalized sales recorded'
              : page.expenses.missingBundleCostCount ||
                  page.expenses.storageUnavailable
                ? 'Unavailable until bundle cost evidence is complete'
                : 'Unavailable until every sale has an acquisition link'
            : signedBalanceAmount(p.realizedResultLamports, 9) + ' SOL'}
        </dd>
      </dl>
      <p>
        Buy costs are allocated proportionally in exact integer lamports. Full
        allocation includes any rounding remainder. Retained Jito tips and tip
        transaction fees are included in buy cost or deducted from sell
        proceeds. Rent and failed transaction fees remain separate. These
        user-recorded accounting links do not prove the origin of fungible
        tokens, current wallet inventory, external cost basis or total account
        return. Unassigned acquired units are bookkeeping capacity, not
        permission to sell.
      </p>
    </div>
  );
}
export function ImportedRecordedLinks({
  page,
  decimals,
  symbol,
}: {
  page: ImportedLotPage;
  decimals: number;
  symbol: string;
}) {
  const [requested, setRequested] = useState(0);
  const index = Math.min(
    requested,
    Math.max(0, Math.ceil(page.links.length / 50) - 1),
  );
  if (!page.links.length) return null;
  return (
    <section aria-label="Saved acquisition links">
      <h4>Saved acquisition links</h4>
      <div className="project-table-wrap">
        <table className="project-table">
          <caption className="sr-only">
            Immutable saved acquisition assignments
          </caption>
          <thead>
            <tr>
              <th>Buy receipt</th>
              <th>Sell receipt</th>
              <th>Assigned units</th>
              <th>Recorded</th>
            </tr>
          </thead>
          <tbody>
            {page.links.slice(index * 50, (index + 1) * 50).map((link) => (
              <tr key={link.id}>
                <td>
                  <code>{link.buyReceiptId}</code>
                  <br />
                  <a
                    href={`https://solscan.io/tx/${link.buySignature}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Buy transaction
                  </a>
                </td>
                <td>
                  <code>{link.sellReceiptId}</code>
                  <br />
                  <a
                    href={`https://solscan.io/tx/${link.sellSignature}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Sell transaction
                  </a>
                </td>
                <td>
                  {formatNativeBalance(link.unitsRaw, decimals)} {symbol}
                </td>
                <td>{new Date(link.createdAt).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p>
        Links {index * 50 + 1} to{' '}
        {Math.min((index + 1) * 50, page.links.length)} of {page.links.length}
      </p>
      <Button
        variant="outline"
        disabled={index === 0}
        onClick={() => setRequested(index - 1)}
      >
        Previous links
      </Button>
      <Button
        variant="outline"
        disabled={(index + 1) * 50 >= page.links.length}
        onClick={() => setRequested(index + 1)}
      >
        Next links
      </Button>
    </section>
  );
}
export function ImportedLotLinks({
  project,
}: {
  project: ImportedTokenProject;
}) {
  const [page, setPage] = useState<ImportedLotPage | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [sellId, setSellId] = useState(''),
    [buyId, setBuyId] = useState(''),
    [search, setSearch] = useState('');
  const [salePage, setSalePage] = useState(0),
    [buyPage, setBuyPage] = useState(0);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  const token = project.document.token;
  async function request(save = false) {
    controller.current?.abort();
    const current = new AbortController();
    controller.current = current;
    setBusy(true);
    setError('');
    if (!save) {
      setPage(null);
      setSellId('');
      setBuyId('');
      setSalePage(0);
      setBuyPage(0);
      setSearch('');
    }
    try {
      const response = await fetch(
        save
          ? '/api/imported-projects/lot-links'
          : `/api/imported-projects/lot-links?projectId=${encodeURIComponent(project.id)}`,
        {
          cache: 'no-store',
          signal: current.signal,
          ...(save
            ? {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                  projectId: project.id,
                  revision: page!.revision,
                  buyReceiptId: buyId,
                  sellReceiptId: sellId,
                  buyDocumentSha256: page!.receiptDocumentHashes[buyId],
                  sellDocumentSha256: page!.receiptDocumentHashes[sellId],
                }),
              }
            : {}),
        },
      );
      const body = await readPanelJson(
        response,
        save
          ? 'Acquisition link could not be confirmed. Reload and review history before retrying.'
          : 'Acquisition history unavailable. No partial accounting is shown.',
      );
      if (!response.ok)
        throw new Error(
          save
            ? 'Acquisition link could not be confirmed. Reload and review history before retrying.'
            : 'Acquisition history unavailable. No partial accounting is shown.',
        );
      const parsed = importedLotPage(
        body,
        project.id,
        token.address,
        token.decimals,
      );
      if (!current.signal.aborted) {
        setPage(parsed);
        setSellId('');
        setBuyId('');
      }
    } catch (e) {
      if (!current.signal.aborted) {
        if (save) setPage(null);
        setError(
          e instanceof Error ? e.message : 'Acquisition history unavailable.',
        );
      }
    } finally {
      if (!current.signal.aborted) setBusy(false);
    }
  }
  const linkedIds = new Set(page?.links.map((l) => l.sellReceiptId) ?? []);
  const sales =
    page?.receipts.filter(
      (r) => r.document.side === 'Sell' && !linkedIds.has(r.id),
    ) ?? [];
  const selectedSell = page?.receipts.find((r) => r.id === sellId);
  const available = new Map(
    page?.performance.lots.map((l) => [
      l.buyReceiptId,
      BigInt(l.unassignedRaw),
    ]) ?? [],
  );
  const buys = selectedSell
    ? page!.receipts.filter(
        (r) =>
          r.document.side === 'Buy' &&
          r.document.wallet === selectedSell.document.wallet &&
          r.document.slot < selectedSell.document.slot &&
          (available.get(r.id) ?? 0n) >=
            BigInt(selectedSell.document.tokenUnitsRaw) &&
          `${r.id} ${r.document.signature}`
            .toLowerCase()
            .includes(search.toLowerCase()),
      )
    : [];
  const preview = useMemo(() => {
    if (!page || !sellId || !buyId) return null;
    try {
      return importedLotAssignmentPreview(page, buyId, sellId);
    } catch {
      return null;
    }
  }, [page, buyId, sellId]);
  const saleIndex = Math.min(
      salePage,
      Math.max(0, Math.ceil(sales.length / 50) - 1),
    ),
    buyIndex = Math.min(buyPage, Math.max(0, Math.ceil(buys.length / 50) - 1));
  return (
    <section
      className="account-costs-panel imported-lot-links"
      aria-label="Recorded acquisition links"
    >
      <h3>Recorded acquisition links</h3>
      <p>
        Review saved acquisition assignments. An unassigned finalized sale can
        be linked to one earlier buy from the same wallet. Multi-source sales
        retain the allocations approved before signing.
      </p>
      <Button variant="outline" onClick={() => request()} disabled={busy}>
        {busy
          ? 'Checking acquisition history…'
          : page
            ? 'Reload acquisition history'
            : 'Review acquisition history'}
      </Button>
      {error && <p role="alert">{error}</p>}
      {page && (
        <>
          <ImportedLinkedResults page={page} />
          <ImportedRecordedLinks
            page={page}
            decimals={token.decimals}
            symbol={token.symbol}
          />
          {sales.length > 0 && (
            <>
              <h4>Choose an unlinked sell</h4>
              <div className="project-table-wrap">
                <table className="project-table">
                  <caption className="sr-only">
                    Unlinked finalized sells
                  </caption>
                  <thead>
                    <tr>
                      <th>Receipt / wallet</th>
                      <th>Tokens sold</th>
                      <th>Slot</th>
                      <th>Review</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sales
                      .slice(saleIndex * 50, (saleIndex + 1) * 50)
                      .map((r) => (
                        <tr key={r.id}>
                          <td>
                            <code>{r.id}</code>
                            <br />
                            <code>{r.document.wallet}</code>
                          </td>
                          <td>
                            {formatNativeBalance(
                              r.document.tokenUnitsRaw,
                              token.decimals,
                            )}{' '}
                            {token.symbol}
                          </td>
                          <td>{r.document.slot}</td>
                          <td>
                            <Button
                              variant="outline"
                              disabled={busy}
                              onClick={() => {
                                setSellId(r.id);
                                setBuyId('');
                                setSearch('');
                                setBuyPage(0);
                              }}
                            >
                              Choose sell {r.id}
                            </Button>
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
              <p>
                Sales {saleIndex * 50 + 1} to{' '}
                {Math.min((saleIndex + 1) * 50, sales.length)} of {sales.length}
              </p>
              <Button
                variant="outline"
                disabled={busy || saleIndex === 0}
                onClick={() => setSalePage(saleIndex - 1)}
              >
                Previous sells
              </Button>
              <Button
                variant="outline"
                disabled={busy || (saleIndex + 1) * 50 >= sales.length}
                onClick={() => setSalePage(saleIndex + 1)}
              >
                Next sells
              </Button>
            </>
          )}
          {selectedSell && (
            <div>
              <h4>Choose the acquisition for sell {selectedSell.id}</h4>
              <p>
                Entire finalized sale:{' '}
                {formatNativeBalance(
                  selectedSell.document.tokenUnitsRaw,
                  token.decimals,
                )}{' '}
                {token.symbol}, wallet{' '}
                <code>{selectedSell.document.wallet}</code>. Only earlier buys
                with sufficient unassigned units are eligible.
              </p>
              <Input
                aria-label="Search eligible acquisitions"
                placeholder="Buy receipt or signature"
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setBuyPage(0);
                  setBuyId('');
                }}
                disabled={busy}
              />
              {buys.length === 0 && (
                <p>
                  No eligible single acquisition. Multi-acquisition sales and
                  external basis are not supported here.
                </p>
              )}
              <div className="project-table-wrap">
                <table className="project-table">
                  <caption className="sr-only">Eligible acquisitions</caption>
                  <thead>
                    <tr>
                      <th>Buy receipt</th>
                      <th>Unassigned units</th>
                      <th>Slot</th>
                      <th>Review</th>
                    </tr>
                  </thead>
                  <tbody>
                    {buys.slice(buyIndex * 50, (buyIndex + 1) * 50).map((r) => (
                      <tr key={r.id}>
                        <td>
                          <code>{r.id}</code>
                        </td>
                        <td>
                          {formatNativeBalance(
                            available.get(r.id)!.toString(),
                            token.decimals,
                          )}{' '}
                          {token.symbol}
                        </td>
                        <td>{r.document.slot}</td>
                        <td>
                          <Button
                            variant="outline"
                            disabled={busy}
                            onClick={() => setBuyId(r.id)}
                          >
                            Choose buy {r.id}
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {buys.length > 50 && (
                <>
                  <p>
                    Acquisitions {buyIndex * 50 + 1} to{' '}
                    {Math.min((buyIndex + 1) * 50, buys.length)} of{' '}
                    {buys.length}
                  </p>
                  <Button
                    variant="outline"
                    disabled={busy || buyIndex === 0}
                    onClick={() => setBuyPage(buyIndex - 1)}
                  >
                    Previous acquisitions
                  </Button>
                  <Button
                    variant="outline"
                    disabled={busy || (buyIndex + 1) * 50 >= buys.length}
                    onClick={() => setBuyPage(buyIndex + 1)}
                  >
                    Next acquisitions
                  </Button>
                </>
              )}
            </div>
          )}
          {preview && (
            <section aria-label="Acquisition link review">
              <h4>Review acquisition link</h4>
              {(!!preview.missingBundleCostCount ||
                preview.storageUnavailable) && (
                <p role="alert">
                  Bundle expenses are incomplete. This preview includes known
                  costs only.
                </p>
              )}
              <p>
                Buy <code>{buyId}</code> → sell <code>{sellId}</code>. Assign{' '}
                {formatNativeBalance(preview.link.unitsRaw, token.decimals)}{' '}
                {token.symbol}.
              </p>
              <p>
                Additional allocated buy cost:{' '}
                {formatNativeBalance(preview.cost, 9)} SOL. Net sell proceeds:{' '}
                {signedBalanceAmount(preview.proceeds, 9)} SOL. Change in linked
                result: {signedBalanceAmount(preview.result, 9)} SOL.
              </p>
              <p>
                This saved accounting link cannot be edited or removed. It does
                not sign or submit a transaction.
              </p>
              <Button disabled={busy} onClick={() => request(true)}>
                Record acquisition link
              </Button>
            </section>
          )}
        </>
      )}
    </section>
  );
}
