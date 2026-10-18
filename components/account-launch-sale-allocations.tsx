'use client';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { validatedLaunchPurchaseHistory } from '@/lib/account-launch-purchases';
import type { PumpPurchaseCostSource } from '@/lib/pump-purchase-costs';
import {
  rawUnitsInput,
  validatedLaunchSalePlan,
  validatedLaunchSaleRead,
  validatedSaleEvidence,
  type LaunchSaleAllocationPlan,
  type SaleEvidenceSummary,
} from '@/lib/account-launch-sale-allocations';
import styles from './account-launch-sale-allocations.module.css';

type Project = { id: string; label: string };
type Sale = {
  id: string;
  wallet: string;
  tokenUnitsRaw: string;
  slot: string;
  createdAt: string;
};
type Selected = {
  sale: Sale;
  evidence: SaleEvidenceSummary | null;
  saved: LaunchSaleAllocationPlan | null;
};
const API = '/api/account-launch-activity';
const short = (v: string) => `${v.slice(0, 6)}…${v.slice(-4)}`;

/** Owner-driven assignment of recorded launch buys to one finalized sale.
 * Nothing is fetched on mount, nothing retries, and no transaction is signed. */
export function AccountLaunchSaleAllocationsPanel({
  reviewId,
  mint,
}: {
  reviewId: string;
  mint: string;
}) {
  const context = `${reviewId}:${mint}`;
  const [busy, setBusy] = useState(''),
    [error, setError] = useState(''),
    [signIn, setSignIn] = useState(false),
    [projects, setProjects] = useState<Project[] | null>(null),
    [projectId, setProjectId] = useState(''),
    [sales, setSales] = useState<Sale[]>([]),
    [pages, setPages] = useState(0),
    [cursor, setCursor] = useState<string | null>(null),
    [sources, setSources] = useState<PumpPurchaseCostSource[] | null>(null),
    [selected, setSelected] = useState<Selected | null>(null),
    [units, setUnits] = useState<Record<string, string>>({}),
    [plan, setPlan] = useState<LaunchSaleAllocationPlan | null>(null),
    [approved, setApproved] = useState(false),
    [unknownSave, setUnknownSave] = useState(false);
  const active = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      active.current?.abort();
      active.current = null;
    },
    [context],
  );
  const clearPlan = () => {
    setPlan(null);
    setApproved(false);
  };

  async function run<T>(
    label: string,
    task: (signal: AbortSignal) => Promise<T>,
  ) {
    active.current?.abort();
    const c = new AbortController();
    active.current = c;
    setBusy(label);
    setError('');
    setSignIn(false);
    try {
      return await task(
        AbortSignal.any([c.signal, AbortSignal.timeout(65000)]),
      );
    } catch (e) {
      if (c.signal.aborted) return undefined;
      setError(
        e instanceof Error && e.message
          ? e.message
          : 'The request failed. Reload before retrying.',
      );
      return undefined;
    } finally {
      if (active.current === c) {
        active.current = null;
        setBusy('');
      }
    }
  }
  async function getJson(url: string, signal: AbortSignal, init?: RequestInit) {
    const response = await fetch(url, { cache: 'no-store', signal, ...init });
    const text = await response.text();
    if (text.length > 1048576) throw Error('Response is too large.');
    let data: unknown = null;
    try {
      data = JSON.parse(text);
    } catch {
      throw Error('The response could not be read. Reload before retrying.');
    }
    if (response.status === 401) {
      setSignIn(true);
      throw Error('Sign in to review sale acquisitions.');
    }
    if (!response.ok)
      throw Error(
        (data as { error?: string })?.error ||
          'The request failed. Reload before retrying.',
      );
    return data;
  }
  const post = (url: string, body: unknown, signal: AbortSignal) =>
    getJson(url, signal, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  const findProjects = () =>
    run('Loading imported tokens…', async (signal) => {
      const data = (await getJson('/api/imported-projects', signal)) as {
        projects?: {
          id: string;
          archived: boolean;
          document?: {
            token?: { address?: string; symbol?: string; name?: string };
          };
        }[];
      };
      if (!Array.isArray(data?.projects))
        throw Error('Imported tokens unavailable.');
      const list = data.projects
        .filter((p) => !p.archived && p.document?.token?.address === mint)
        .map((p) => ({
          id: p.id,
          label:
            p.document?.token?.symbol || p.document?.token?.name || short(p.id),
        }));
      setProjects(list);
      if (list.length === 1) await loadSales(list[0].id, null, signal);
    });
  async function loadSales(
    id: string,
    after: string | null,
    signal: AbortSignal,
  ) {
    const data = (await getJson(
      `/api/imported-projects/receipts?projectId=${encodeURIComponent(id)}` +
        (after ? `&cursor=${encodeURIComponent(after)}` : ''),
      signal,
    )) as {
      mint?: string;
      receipts?: {
        id: string;
        createdAt: string;
        document: {
          side: string;
          wallet: string;
          tokenUnitsRaw: string;
          slot: string | number;
          commitment: string;
        };
      }[];
      nextCursor?: string | null;
    };
    if (data?.mint !== mint || !Array.isArray(data.receipts))
      throw Error('Finalized trades for this token are unavailable.');
    const found = data.receipts
      .filter(
        (r) =>
          r.document?.side === 'Sell' && r.document.commitment === 'finalized',
      )
      .map((r) => ({
        id: r.id,
        wallet: r.document.wallet,
        tokenUnitsRaw: String(r.document.tokenUnitsRaw),
        slot: String(r.document.slot),
        createdAt: r.createdAt,
      }));
    setProjectId(id);
    setSales((old) => (after ? [...old, ...found] : found));
    setPages((n) => (after ? n + 1 : 1));
    setCursor(data.nextCursor ?? null);
    if (!after) setSelected(null);
  }
  const chooseProject = (id: string) => {
    setSales([]);
    setPages(0);
    setCursor(null);
    setSelected(null);
    clearPlan();
    if (id) void run('Loading finalized sales…', (s) => loadSales(id, null, s));
  };
  const openSale = (sale: Sale) =>
    run('Loading saved sale…', async (signal) => {
      clearPlan();
      setUnknownSave(false);
      const ctx = { saleReceiptId: sale.id, wallet: sale.wallet, mint };
      const q = `?saleReceiptId=${encodeURIComponent(sale.id)}`;
      const evidence = validatedSaleEvidence(
        await getJson(`${API}/sale-evidence${q}`, signal),
        ctx,
      );
      const saved = await validatedLaunchSaleRead(
        await getJson(`${API}/sale-allocations${q}`, signal),
        ctx,
      );
      if (!sources) {
        const history = await validatedLaunchPurchaseHistory(
          await getJson(
            `${API}/purchases?reviewId=${encodeURIComponent(reviewId)}`,
            signal,
          ),
          { reviewId, mint },
        );
        setSources(history.sources);
      }
      setUnits({});
      setSelected({ sale, evidence, saved });
    });
  const capture = () =>
    selected &&
    run('Retaining finalized sale evidence…', async (signal) => {
      const ctx = {
        saleReceiptId: selected.sale.id,
        wallet: selected.sale.wallet,
        mint,
      };
      const evidence = validatedSaleEvidence(
        await post(
          `${API}/sale-evidence`,
          { saleReceiptId: selected.sale.id },
          signal,
        ),
        ctx,
      );
      setSelected({ ...selected, evidence });
    });
  const selection = () =>
    Object.entries(units)
      .filter(([, t]) => t.trim() !== '')
      .map(([originId, t]) => ({ originId, unitsRaw: rawUnitsInput(t) }));
  const review = () =>
    selected &&
    run('Reviewing acquisitions…', async (signal) => {
      clearPlan();
      const picked = selection();
      if (!picked.length || picked.some((p) => p.unitsRaw === null))
        throw Error('Enter whole raw token units for each selected buy.');
      const exact = picked as { originId: string; unitsRaw: string }[];
      const data = (await post(
        `${API}/sale-allocations`,
        {
          action: 'review',
          saleReceiptId: selected.sale.id,
          allocations: exact,
        },
        signal,
      )) as {
        plan?: unknown;
        executionAllowed?: unknown;
        profitCalculated?: unknown;
      };
      if (data?.executionAllowed !== false || data?.profitCalculated !== false)
        throw Error(
          'The sale acquisition response differs. Reload the sale before saving.',
        );
      setPlan(
        await validatedLaunchSalePlan(
          data.plan,
          {
            saleReceiptId: selected.sale.id,
            wallet: selected.sale.wallet,
            mint,
          },
          exact,
        ),
      );
    });
  const save = () =>
    selected &&
    plan &&
    approved &&
    run('Saving acquisitions…', async (signal) => {
      const ctx = {
        saleReceiptId: selected.sale.id,
        wallet: selected.sale.wallet,
        mint,
      };
      const exact = plan.allocations.map((a) => ({
        originId: a.originId,
        unitsRaw: a.unitsRaw,
      }));
      setUnknownSave(true);
      const saved = await validatedLaunchSaleRead(
        await post(
          `${API}/sale-allocations`,
          {
            action: 'record',
            saleReceiptId: selected.sale.id,
            allocations: exact,
            approved: true,
            policy: plan.policy,
            planSha256: plan.sha256,
          },
          signal,
        ),
        ctx,
      );
      if (saved?.sha256 !== plan.sha256)
        throw Error(
          'The saved plan differs from this approval. Reload the sale.',
        );
      setUnknownSave(false);
      clearPlan();
      setSelected({ ...selected, saved });
    });

  const eligible =
    selected && sources
      ? sources.filter(
          (s) => s.wallet === selected.sale.wallet && s.mint === mint,
        )
      : [];
  return (
    <details className={styles.panel}>
      <summary>Sales from these buys</summary>
      <p>
        Record which of these launch buys each finalized sale used. This is
        bookkeeping only. No wallet unlock, transaction or profit figure.
      </p>
      <div className={styles.actions}>
        <Button
          type="button"
          variant="outline"
          disabled={!!busy}
          onClick={() => void findProjects()}
        >
          Find sales
        </Button>
        {busy && (
          <Button
            type="button"
            variant="outline"
            onClick={() => active.current?.abort()}
          >
            Stop
          </Button>
        )}
      </div>
      {busy && <output>{busy}</output>}
      {signIn && (
        <p>
          <Link href="/sign-in">Sign in</Link> to review sale acquisitions.
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      {projects && projects.length === 0 && (
        <p>
          No imported token matches this mint. Import the token in the trading
          workspace first so its finalized sells are recorded here.
        </p>
      )}
      {projects && projects.length > 1 && (
        <label className={styles.field}>
          Imported token
          <select
            value={projectId}
            onChange={(e) => chooseProject(e.target.value)}
            disabled={!!busy}
          >
            <option value="">Choose…</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label} ({short(p.id)})
              </option>
            ))}
          </select>
        </label>
      )}
      {projectId && pages > 0 && (
        <div className={styles.sales}>
          <p>
            Finalized sells in{' '}
            {pages === 1 ? 'the first page' : `the first ${pages} pages`} of
            trade history: {sales.length}
            {cursor ? '. Older trades are not loaded yet.' : '.'}
          </p>
          <ul>
            {sales.map((s) => (
              <li key={s.id}>
                <Button
                  type="button"
                  variant={selected?.sale.id === s.id ? 'default' : 'outline'}
                  disabled={!!busy}
                  onClick={() => void openSale(s)}
                >
                  Wallet {short(s.wallet)}, {s.tokenUnitsRaw} raw units, slot{' '}
                  {s.slot}
                </Button>
              </li>
            ))}
          </ul>
          {cursor && (
            <Button
              type="button"
              variant="outline"
              disabled={!!busy}
              onClick={() =>
                void run('Loading older trades…', (sig) =>
                  loadSales(projectId, cursor, sig),
                )
              }
            >
              Load older trades
            </Button>
          )}
        </div>
      )}
      {selected && (
        <section className={styles.sale} aria-label="Selected sale">
          <h4>Sale by {short(selected.sale.wallet)}</h4>
          {selected.saved ? (
            <>
              <p>Saved. These buys were recorded for this sale:</p>
              <ul>
                {selected.saved.allocations.map((a) => (
                  <li key={a.originId}>
                    Buy <code>{short(a.originId)}</code>: {a.unitsRaw} raw units
                    (units {a.beforeRaw} to {a.afterRaw})
                  </li>
                ))}
              </ul>
              <p>
                Plan <code>{selected.saved.sha256}</code>
              </p>
            </>
          ) : !selected.evidence?.entry ? (
            <>
              <p>
                The finalized evidence for this sale is not retained yet.
                Retaining it reads the finalized transaction once. Nothing is
                signed or sent.
              </p>
              <Button
                type="button"
                disabled={!!busy}
                onClick={() => void capture()}
              >
                Retain sale evidence
              </Button>
            </>
          ) : eligible.length === 0 ? (
            <p>
              None of these launch buys came from the wallet of this sale.
              Choose a different sale or load saved buy costs for another
              launch.
            </p>
          ) : (
            <>
              <p>
                Sold {selected.evidence.entry.tokenUnitsRaw} raw units. Assign
                all of them across the buys below.
              </p>
              {eligible.map((s) => (
                <label key={s.originId} className={styles.field}>
                  Buy {short(s.originId)} ({s.acquiredRaw} raw units bought)
                  <input
                    inputMode="numeric"
                    value={units[s.originId] ?? ''}
                    disabled={!!busy}
                    onChange={(e) => {
                      clearPlan();
                      setUnits({ ...units, [s.originId]: e.target.value });
                    }}
                  />
                </label>
              ))}
              <Button
                type="button"
                variant="outline"
                disabled={!!busy}
                onClick={() =>
                  void (unknownSave ? openSale(selected.sale) : review())
                }
              >
                {unknownSave ? 'Check saved status' : 'Review assignment'}
              </Button>
              {plan && (
                <div className={styles.review}>
                  <ul>
                    {plan.allocations.map((a) => (
                      <li key={a.originId}>
                        Buy <code>{short(a.originId)}</code>: {a.unitsRaw} raw
                        units, used {a.beforeRaw} before, {a.afterRaw} after
                      </li>
                    ))}
                  </ul>
                  <p>
                    Plan <code>{plan.sha256}</code>
                  </p>
                  <label className={styles.check}>
                    <input
                      type="checkbox"
                      checked={approved}
                      disabled={!!busy}
                      onChange={(e) => setApproved(e.target.checked)}
                    />
                    I approve recording exactly these units for this sale.
                  </label>
                  <Button
                    type="button"
                    disabled={!approved || !!busy}
                    onClick={() => void save()}
                  >
                    Save assignment
                  </Button>
                </div>
              )}
            </>
          )}
        </section>
      )}
    </details>
  );
}
