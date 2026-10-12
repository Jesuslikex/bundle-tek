'use client';
import { useEffect, useRef, useState } from 'react';
import { Button } from './ui/button';
import { ConditionalLevelCard } from './conditional-level-card';
import { formatNativeBalance } from '@/lib/wallet-balance-format';
import type { ImportedTokenProject } from '@/lib/imported-token-project';
import type { WorkspaceWallet } from '@/lib/wallet-workspace';
import {
  decodeConditionalSellOrder,
  conditionalSellTerms,
  type ConditionalSellOrder,
} from '@/lib/conditional-sell-order';
import {
  conditionalLevelStatuses,
  type ConditionalLevelStatus,
} from '@/lib/conditional-level-status';
import type { MarketTrigger } from '@/lib/market-trigger';
import { ImportedSwapPreparation } from './imported-swap-preparation';
import { ImportedApprovalHistory } from './imported-approval-history';
import type { ConditionalApprovalSelection } from '@/lib/conditional-approval-selection';
import {
  conditionalLevelReviews,
  sampledSavedConditions,
  type ConditionalLevelReview,
} from '@/lib/conditional-level-review';
import { ConditionalLevelPreview } from './conditional-level-preview';
import type { SavedTokenMarket } from '@/lib/token-market';
import { subscribeImportedReceiptSaved } from '@/lib/imported-receipt-events';
type Page = {
  projectId: string;
  orders: ConditionalSellOrder[];
  levels: ConditionalLevelStatus[];
  executionAllowed: false;
  error?: string;
};
type Result = {
  order: ConditionalSellOrder;
  orderId?: string;
  revision?: number;
  reviews: { met: boolean; observedAt: string }[];
  executionAllowed: false;
  error?: string;
};
function FollowedConditionalSample({
  order,
  project,
  pair,
  observation,
  now,
}: {
  order: ConditionalSellOrder;
  project: ImportedTokenProject;
  pair: string;
  observation: SavedTokenMarket;
  now: number;
}) {
  let reviews: ConditionalLevelReview[];
  try {
    reviews = sampledSavedConditions(order, project, pair, observation, now);
  } catch (error) {
    return (
      <output>
        Condition sample unavailable:{' '}
        {error instanceof Error ? error.message : 'Refresh the selected pool.'}
      </output>
    );
  }
  return <ConditionalLevelPreview order={order} reviews={reviews} now={now} />;
}
export function ConditionalSellOrders({
  project,
  pair,
  limit,
  grid,
  observation,
  feedRunning = false,
}: {
  project: ImportedTokenProject;
  pair: string;
  observation?: SavedTokenMarket;
  feedRunning?: boolean;
  limit?: Pick<MarketTrigger, 'direction' | 'targetUsd'> & { amount: string };
  grid?: {
    minimumUsd: string;
    maximumUsd: string;
    lines: number;
    amount: string;
  };
}) {
  const [wallets, setWallets] = useState<WorkspaceWallet[]>([]),
    [selected, setSelected] = useState('');
  const [orders, setOrders] = useState<ConditionalSellOrder[]>([]),
    [loaded, setLoaded] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [message, setMessage] = useState('');
  const [levels, setLevels] = useState<ConditionalLevelStatus[]>([]);
  const [following, setFollowing] = useState(false);
  const [sample, setSample] = useState<{
    orderId: string;
    reviews: ConditionalLevelReview[];
  } | null>(null);
  const [sampleNow, setSampleNow] = useState(() => Date.now());
  useEffect(() => {
    if (!sample && !following) return;
    const timer = window.setInterval(() => setSampleNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [sample, following]);

  const [recovery, setRecovery] = useState<ConditionalApprovalSelection | null>(
    null,
  );
  const pending = useRef<AbortController | null>(null);
  const retry = useRef<{ key: string; id: string } | null>(null);
  const [preparing, setPreparing] = useState<{
    order: ConditionalSellOrder;
    level: number;
    wallet: WorkspaceWallet;
  } | null>(null);
  useEffect(() => {
    let disposed = false;
    void Promise.resolve().then(() => {
      if (following && !disposed) setPreparing(null);
    });
    return () => {
      disposed = true;
    };
  }, [following, observation]);
  useEffect(() => () => pending.current?.abort(), []);
  useEffect(
    () =>
      subscribeImportedReceiptSaved(
        { projectId: project.id, mint: project.document.token.address },
        () => {
          pending.current?.abort();
          pending.current = null;
          setBusy(false);
          setLoaded(false);
          setOrders([]);
          setLevels([]);
          setSample(null);
          setFollowing(false);
          setPreparing(null);
          setRecovery(null);
          setError('');
          setMessage(
            'A trade finalized for this token. Reload saved orders and wallets to review current filled levels and remaining conditions.',
          );
        },
      ),
    [project.id, project.document.token.address],
  );
  const begin = () => {
    setSample(null);
    setPreparing(null);
    setRecovery(null);
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setError('');
    setMessage('');
    return controller;
  };
  async function load() {
    const controller = begin();
    setLoaded(false);
    setOrders([]);
    setLevels([]);
    setWallets([]);
    setSelected('');
    try {
      const responses = await Promise.all([
        fetch('/api/wallet-workspace', {
          signal: controller.signal,
          cache: 'no-store',
        }),
        fetch(
          `/api/imported-projects/conditional-orders?${new URLSearchParams({ projectId: project.id })}`,
          { signal: controller.signal, cache: 'no-store' },
        ),
      ]);
      const [workspace, page] = await Promise.all([
        responses[0].json() as Promise<{
          wallets: WorkspaceWallet[];
          error?: string;
        }>,
        responses[1].json() as Promise<Page>,
      ]);
      if (
        !responses[0].ok ||
        !responses[1].ok ||
        !Array.isArray(workspace.wallets) ||
        workspace.wallets.length > 500 ||
        page.projectId !== project.id ||
        page.executionAllowed !== false ||
        !Array.isArray(page.orders) ||
        page.orders.length > 100
      )
        throw new Error(
          workspace.error ||
            page.error ||
            'Conditional order list unavailable.',
        );
      if (!controller.signal.aborted) {
        setWallets(
          workspace.wallets.filter(
            (w: WorkspaceWallet) => w.chain === 'Solana' && !w.archived,
          ),
        );
        const validated = page.orders.map(decodeConditionalSellOrder);
        if (
          validated.some((o) => o.terms.projectId !== project.id) ||
          new Set(validated.map((o) => o.id)).size !== validated.length
        )
          throw new Error('Saved order context differs.');
        setLevels(conditionalLevelStatuses(page.levels, validated));
        setOrders(validated);
        setLoaded(true);
      }
    } catch (e) {
      if (!controller.signal.aborted)
        setError(
          e instanceof Error ? e.message : 'Saved order list unavailable.',
        );
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  async function write(kind: 'limit' | 'grid') {
    const wallet = wallets.find((w) => w.address === selected);
    const terms = kind === 'limit' ? limit : grid;
    if (!wallet || !terms) return;
    const input = {
      action: 'create',
      projectId: project.id,
      projectRevision: project.revision,
      pair,
      wallet: wallet.address,
      walletRevision: wallet.revision,
      kind,
      ...terms,
      ...(kind === 'grid' ? { direction: 'at-or-above' } : {}),
    };
    const key = JSON.stringify(input);
    if (retry.current?.key !== key)
      retry.current = { key, id: crypto.randomUUID() };
    const controller = begin();
    try {
      const response = await fetch(
        '/api/imported-projects/conditional-orders',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          signal: controller.signal,
          body: JSON.stringify({ ...input, orderId: retry.current.id }),
        },
      );
      const data = (await response.json()) as Result;
      if (!response.ok)
        throw new Error(
          data.error ||
            'Draft save unavailable. Retry with the same terms to recover the same request.',
        );
      if (
        data.executionAllowed !== false ||
        data.order?.id !== retry.current.id ||
        data.order.terms?.projectId !== project.id
      )
        throw new Error('Saved order response differs. Reload saved orders.');
      if (!controller.signal.aborted) {
        const validated = decodeConditionalSellOrder(data.order);
        if (
          JSON.stringify(validated.terms) !==
          JSON.stringify(conditionalSellTerms(input, project.document.token))
        )
          throw new Error(
            'Saved draft terms differ from the requested review.',
          );
        setOrders((old) => [
          validated,
          ...old.filter((o) => o.id !== data.order.id),
        ]);
        retry.current = null;
        setMessage(
          'Draft saved. No inventory reserved or transaction approved.',
        );
      }
    } catch (e) {
      if (!controller.signal.aborted)
        setError(e instanceof Error ? e.message : 'Draft save unavailable.');
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  async function act(order: ConditionalSellOrder, action: 'cancel' | 'review') {
    const controller = begin();
    try {
      const response = await fetch(
        '/api/imported-projects/conditional-orders',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          signal: controller.signal,
          body: JSON.stringify({
            action,
            projectId: project.id,
            orderId: order.id,
            revision: order.revision,
          }),
        },
      );
      const data = (await response.json()) as Result;
      if (!response.ok)
        throw new Error(data.error || 'Order action unavailable.');
      if (data.executionAllowed !== false)
        throw new Error('Unexpected execution permission.');
      if (action === 'cancel') {
        if (
          data.order?.id !== order.id ||
          data.order.state !== 'cancelled' ||
          data.order.revision !== order.revision + 1
        )
          throw new Error('Cancellation response differs. Reload orders.');
        if (!controller.signal.aborted) {
          const validated = decodeConditionalSellOrder(data.order);
          if (JSON.stringify(validated.terms) !== JSON.stringify(order.terms))
            throw new Error('Cancelled order terms changed. Reload orders.');
          setOrders((old) =>
            old.map((o) => (o.id === order.id ? validated : o)),
          );
          setMessage('Draft cancelled.');
        }
      } else {
        const reviews = conditionalLevelReviews(data, order);
        if (!controller.signal.aborted) {
          setSampleNow(Date.now());
          setSample({ orderId: order.id, reviews });
          setMessage(
            `${reviews.filter((r) => r.met).length} of ${reviews.length} conditions met in the server observation at ${reviews[0].observedAt}. This sample does not reserve inventory, approve signing or guarantee a fill.`,
          );
        }
      }
    } catch (e) {
      if (!controller.signal.aborted)
        setError(e instanceof Error ? e.message : 'Order action unavailable.');
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  return (
    <section
      aria-label="Saved conditional sell drafts"
      className="conditional-sell-orders"
    >
      <h5>Saved conditional sells</h5>
      <p>
        Save Limit or Grid terms for later review. Drafts do not run
        automatically. Each trade still needs fresh balance, route and signing
        approval.
      </p>
      <Button variant="outline" disabled={busy} onClick={() => void load()}>
        Load saved orders and wallets
      </Button>
      {loaded && (
        <>
          {observation && (
            <>
              <Button
                variant="outline"
                disabled={busy || project.archived}
                onClick={() => {
                  setSampleNow(Date.now());
                  setFollowing((v) => !v);
                }}
              >
                {following
                  ? 'Stop following market samples'
                  : 'Follow incoming market samples'}
              </Button>
              <p>
                Market sampling is {feedRunning ? 'running' : 'off'}. Following
                uses incoming selected-pool samples from the market panel,
                including manual refreshes. Start market sampling there for
                repeated reads. This does not prepare, sign or submit trades.
              </p>
            </>
          )}
          <label>
            Draft sell wallet
            <select
              disabled={busy || project.archived}
              value={selected}
              onChange={(e) => {
                setSelected(e.target.value);
                setMessage('');
              }}
            >
              <option value="">Choose a wallet</option>
              {wallets.map((w) => (
                <option key={w.address} value={w.address}>
                  {w.label || w.address} · {w.address}
                </option>
              ))}
            </select>
          </label>
          <div className="imported-trade-wallet-filters">
            <Button
              variant="outline"
              disabled={busy || project.archived || !selected || !limit?.amount}
              onClick={() => void write('limit')}
            >
              Save limit draft
            </Button>
            <Button
              variant="outline"
              disabled={busy || project.archived || !selected || !grid}
              onClick={() => void write('grid')}
            >
              Save grid draft
            </Button>
          </div>
          {orders.length === 0 ? (
            <p>No saved conditional orders.</p>
          ) : (
            <ul className="conditional-orders-list">
              {orders.map((order) => (
                <li className="conditional-order" key={order.id}>
                  <strong>
                    {order.terms.kind === 'grid' ? 'Grid' : 'Limit'} ·{' '}
                    {order.state}
                  </strong>{' '}
                  · {order.terms.levels.length} level(s) ·{' '}
                  {formatNativeBalance(
                    order.terms.totalRaw,
                    order.terms.decimals,
                  )}{' '}
                  {project.document.token.symbol} total
                  <details className="conditional-order__details">
                    <summary>Order wallet and saved terms</summary>
                    <p>
                      Wallet <code>{order.terms.wallet}</code>
                    </p>
                    <p>Saved {new Date(order.createdAt).toLocaleString()}</p>
                    <p>
                      Project revision {order.terms.projectRevision}. Wallet
                      revision {order.terms.walletRevision}.
                    </p>
                  </details>
                  <ul
                    className="conditional-level-grid"
                    aria-label="Conditional level status"
                  >
                    {order.terms.levels.map((level) => {
                      const status = levels.find(
                        (s) =>
                          s.orderId === order.id && s.level === level.level,
                      );
                      const wallet = wallets.find(
                        (w) =>
                          w.address === order.terms.wallet &&
                          w.revision === order.terms.walletRevision,
                      );
                      return (
                        <ConditionalLevelCard
                          key={level.level}
                          order={order}
                          level={level}
                          status={status}
                          symbol={project.document.token.symbol}
                          busy={busy}
                          canPrepare={
                            !busy &&
                            !status &&
                            !project.archived &&
                            order.state === 'draft' &&
                            order.terms.projectRevision === project.revision &&
                            Boolean(wallet)
                          }
                          onPrepare={() => {
                            if (!wallet) return;
                            setRecovery(null);
                            setMessage('');
                            setError('');
                            setPreparing({ order, level: level.level, wallet });
                          }}
                          onRecover={() => {
                            if (!status) return;
                            setPreparing(null);
                            setRecovery({
                              intentId: status.intentId,
                              order,
                              level: level.level,
                            });
                          }}
                        />
                      );
                    })}
                  </ul>
                  {following && observation && (
                    <FollowedConditionalSample
                      order={order}
                      project={project}
                      pair={pair}
                      observation={observation}
                      now={sampleNow}
                    />
                  )}
                  {!following && sample?.orderId === order.id && (
                    <ConditionalLevelPreview
                      order={order}
                      reviews={sample.reviews}
                      now={sampleNow}
                    />
                  )}
                  {order.terms.projectRevision !== project.revision && (
                    <p>
                      Project revision changed. Replace this draft before
                      trading.
                    </p>
                  )}
                  <Button
                    variant="outline"
                    disabled={
                      busy ||
                      order.state !== 'draft' ||
                      project.archived ||
                      order.terms.projectRevision !== project.revision
                    }
                    onClick={() => void act(order, 'review')}
                  >
                    Review saved conditions
                  </Button>{' '}
                  <Button
                    variant="outline"
                    disabled={
                      busy ||
                      order.state !== 'draft' ||
                      levels.some(
                        (s) => s.orderId === order.id && s.state !== 'filled',
                      )
                    }
                    onClick={() => void act(order, 'cancel')}
                  >
                    Cancel draft
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      <p>
        Reload saved orders to refresh reserved levels and finalized fills. Use
        level approval recovery to cancel an unsigned approval or recover a
        registered signature.
      </p>
      {busy && <output>Reading or saving order records…</output>}
      {message && <output>{message}</output>}
      {error && <p role="alert">{error}</p>}
      {recovery && (
        <ImportedApprovalHistory
          key={recovery.intentId}
          project={project}
          selection={recovery}
          submissionBlocked={busy || recovery.order.state !== 'draft'}
        />
      )}
      {preparing && (
        <ImportedSwapPreparation
          key={`${preparing.order.id}:${preparing.order.revision}:${preparing.level}`}
          project={project}
          wallet={preparing.wallet}
          side="Sell"
          amount={
            preparing.order.terms.levels.find(
              (l) => l.level === preparing.level,
            )!.amount
          }
          locked={busy}
          conditionalOrder={preparing.order}
          conditional={{
            orderId: preparing.order.id,
            revision: preparing.order.revision,
            level: preparing.level,
          }}
        />
      )}
    </section>
  );
}
