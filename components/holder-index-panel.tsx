'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ImportedTokenProject } from '@/lib/imported-token-project';
import {
  appendHolderIndexPage,
  holderIndexSummary,
  type HolderIndexScan,
} from '@/lib/holder-index';
import { formatNativeBalance } from '@/lib/wallet-balance-format';
import { Button } from './ui/button';
import styles from './holder-index-panel.module.css';
import { holderIndexWithheldFees } from '@/lib/holder-index-withheld';
import {
  readHolderIndexHistory,
  type SavedHolderRun,
} from '@/lib/holder-index-history-client';
import { HOLDER_RUN_RESUME_MS } from '@/lib/holder-index';
import {
  selectIndexedHolders,
  indexedHolderSupplyShare,
  type HolderSort,
} from '@/lib/holder-index-view';
import {
  readHolderIndexPageWithRetry,
  HOLDER_READ_MAX_RETRIES,
  type HolderReadRetry,
} from '@/lib/holder-index-retry';

export function HolderIndexResults({ scan }: { scan: HolderIndexScan }) {
  const summary = useMemo(() => holderIndexSummary(scan), [scan]);
  const fees = useMemo(() => {
    try {
      return { value: holderIndexWithheldFees(scan), error: '' };
    } catch (failure) {
      return {
        value: null,
        error:
          failure instanceof Error
            ? failure.message
            : 'Withheld fee reconciliation unavailable.',
      };
    }
  }, [scan]);
  const [search, setSearch] = useState(''),
    [pageIndex, setPageIndex] = useState(0);
  const [sort, setSort] = useState<HolderSort>('largest');
  const matching = useMemo(
    () => selectIndexedHolders(summary.holders, search, sort),
    [summary.holders, search, sort],
  );
  const pageSize = 50,
    pages = Math.max(1, Math.ceil(matching.length / pageSize)),
    selectedPage = Math.min(pageIndex, pages - 1);
  if (fees.error)
    return (
      <p role="alert">
        {fees.error} Holder totals need a fresh scan before review.
      </p>
    );
  return (
    <div>
      <output>
        {scan.status === 'enumerated'
          ? 'Provider enumeration exhausted'
          : scan.status === 'limit'
            ? 'Scan limit reached. Coverage remains partial'
            : 'Partial enumeration'}{' '}
        · {scan.accounts.size.toLocaleString()} token accounts ·{' '}
        {summary.holders.length.toLocaleString()} owners with positive balances.
      </output>
      <p>
        {summary.coveredPercent.toFixed(4)}% of reference supply in scanned
        owner balances. Remainder outside those balances:{' '}
        {formatNativeBalance(summary.remainderRaw, scan.decimals)} tokens.
      </p>
      {scan.status === 'enumerated' && (
        <p>
          {summary.remainderRaw === '0'
            ? 'All reference supply units reconcile with the enumerated provider account set.'
            : fees.value?.remainderAfterObservedFeesRaw === '0'
              ? 'Reference supply units reconcile with visible balances and the observed fees. This does not establish complete hidden-balance coverage.'
              : 'Enumeration ended with unreconciled supply. Full supply coverage is not established.'}
        </p>
      )}
      <p>
        Top 10 scanned owners: {summary.top10Percent.toFixed(4)}% of reference
        supply. Includes pool and team accounts; owner roles have not been
        inferred.
      </p>
      <p className={styles.context}>
        {fees.value && fees.value.reportedAccounts > 0 ? (
          <span>
            Observed account-withheld fees:{' '}
            {formatNativeBalance(fees.value.raw, scan.decimals)} tokens in{' '}
            {fees.value.reportedAccounts} accounts. These are not spendable by
            the listed owners and are excluded from holdings and
            concentration.{' '}
          </span>
        ) : scan.tokenProgram ===
          'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb' ? (
          <span>
            Account-withheld fees have not been measured for this Token-2022
            scan.{' '}
          </span>
        ) : null}
        {scan.tokenProgram === 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb' &&
          fees.value && (
            <span>
              {fees.value.mintRaw === null ? (
                'Mint-harvested fees remain unmeasured. '
              ) : (
                <>
                  Observed mint-harvested fees:{' '}
                  {formatNativeBalance(fees.value.mintRaw, scan.decimals)}{' '}
                  tokens, excluded from owner holdings. Mint observation slots{' '}
                  {scan.minMintSlot} to {scan.maxMintSlot}.{' '}
                </>
              )}
              Unexplained remainder after observed fees:{' '}
              {formatNativeBalance(
                fees.value.remainderAfterObservedFeesRaw,
                scan.decimals,
              )}{' '}
              tokens.{' '}
              {fees.value.extensionAccounts < scan.accounts.size &&
                'Some account extensions were not reported. '}
              {fees.value.unparseableAccounts > 0 &&
                'Some account extensions could not be parsed. '}
              {(fees.value.confidentialAccounts > 0 ||
                fees.value.confidentialMint) &&
                'Confidential extensions detected. Encrypted balances and encrypted fees are not measured by this scan. '}
              {fees.value.incompleteMintExtensions &&
                'Some mint extensions could not be parsed. '}
            </span>
          )}
        Index slots {scan.minIndexedSlot} to {scan.maxIndexedSlot} ·{' '}
        {scan.pages} pages · {scan.source}. Pages are live index reads, not an
        atomic on-chain snapshot. Exhaustion means the provider returned a{' '}
        {scan.enumeration ? 'terminal cursor' : 'empty page'}, not proof of
        globally complete or current chain coverage. Read from{' '}
        {new Date(scan.firstObservedAt).toLocaleString()} to{' '}
        {new Date(scan.lastObservedAt).toLocaleString()}. Reference supply slots{' '}
        {scan.minSupplySlot} to {scan.maxSupplySlot}.
      </p>
      <label>
        Search indexed owners
        <input
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
            setPageIndex(0);
          }}
          placeholder="Wallet address or fragment"
        />
      </label>
      <label>
        Sort indexed owners
        <select
          value={sort}
          onChange={(event) => {
            setSort(event.target.value as HolderSort);
            setPageIndex(0);
          }}
        >
          <option value="largest">Largest holdings</option>
          <option value="smallest">Smallest holdings</option>
          <option value="owner">Wallet address</option>
          <option value="accounts">Most token accounts</option>
        </select>
      </label>
      <div className={styles.tableWrap}>
        <table>
          <caption>
            {matching.length.toLocaleString()} matching owners in scanned
            accounts · page {selectedPage + 1} of {pages}
          </caption>
          <thead>
            <tr>
              <th scope="col">Owner</th>
              <th scope="col">Tokens</th>
              <th scope="col">Reference supply</th>
              <th scope="col">Accounts</th>
            </tr>
          </thead>
          <tbody>
            {matching
              .slice(selectedPage * pageSize, (selectedPage + 1) * pageSize)
              .map((holder) => (
                <tr key={holder.owner}>
                  <th scope="row">
                    <code>{holder.owner}</code>
                  </th>
                  <td>
                    {formatNativeBalance(holder.raw.toString(), scan.decimals)}
                  </td>
                  <td>
                    {indexedHolderSupplyShare(holder.raw, scan.totalSupplyRaw)}
                  </td>
                  <td>{holder.accountCount}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
      <div className={styles.actions}>
        <Button
          variant="outline"
          disabled={selectedPage === 0}
          onClick={() => setPageIndex(selectedPage - 1)}
        >
          Previous owners
        </Button>
        <Button
          variant="outline"
          disabled={selectedPage >= pages - 1}
          onClick={() => setPageIndex(selectedPage + 1)}
        >
          Next owners
        </Button>
      </div>
    </div>
  );
}

export function HolderIndexPanel({
  project,
  onOpenChart,
}: {
  project: ImportedTokenProject;
  onOpenChart: () => void;
}) {
  const [scan, setScan] = useState<HolderIndexScan | null>(null);
  const [runId, setRunId] = useState<string | null>(null),
    [runs, setRuns] = useState<SavedHolderRun[]>([]);
  const [historyReady, setHistoryReady] = useState(false);
  const [enumeration, setEnumeration] = useState<
    'das-cursor' | 'program-accounts-v2'
  >('das-cursor');
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(timer);
  }, []);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [retry, setRetry] = useState<HolderReadRetry | null>(null);
  const pending = useRef<AbortController | null>(null);
  const loadHistory = useCallback(
    async (selected: string | null = null) => {
      if (pending.current) return;
      const controller = new AbortController();
      pending.current = controller;
      setBusy(true);
      setError('');
      setHistoryReady(false);
      try {
        const result = await readHolderIndexHistory(
          {
            id: project.id,
            revision: project.revision,
            mint: project.document.token.address,
            decimals: project.document.token.decimals,
          },
          selected,
          controller.signal,
        );
        setScan(result.scan);
        setRunId(result.runId);
        setRuns(result.runs);
        setHistoryReady(true);
      } catch (failure) {
        if (!controller.signal.aborted)
          setError(
            failure instanceof Error
              ? failure.message
              : 'Saved holder history unavailable.',
          );
      } finally {
        if (pending.current === controller) {
          pending.current = null;
          setBusy(false);
        }
      }
    },
    [
      project.id,
      project.revision,
      project.document.token.address,
      project.document.token.decimals,
    ],
  );
  useEffect(() => {
    const initialRead = setTimeout(() => void loadHistory(), 0);
    return () => {
      clearTimeout(initialRead);
      pending.current?.abort();
    };
  }, [loadHistory]);
  useEffect(() => {
    const pause = () => {
      if (
        pending.current &&
        (document.visibilityState === 'hidden' || !navigator.onLine)
      ) {
        pending.current?.abort();
        setError(
          'Holder scan paused. Return online to resume the partial enumeration.',
        );
      }
    };
    document.addEventListener('visibilitychange', pause);
    window.addEventListener('offline', pause);
    return () => {
      pending.current?.abort();
      document.removeEventListener('visibilitychange', pause);
      window.removeEventListener('offline', pause);
    };
  }, []);
  async function run(restart: boolean) {
    if (
      pending.current ||
      project.archived ||
      !navigator.onLine ||
      document.visibilityState === 'hidden'
    )
      return;
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setError('');
    let accumulated = restart ? null : scan;
    const activeRun = restart ? crypto.randomUUID() : runId;
    if (!activeRun) {
      pending.current = null;
      setBusy(false);
      setError('Reload saved holder runs or start a fresh scan.');
      return;
    }
    setRunId(activeRun);
    if (restart) setScan(null);
    try {
      do {
        setRetry(null);
        const data = await readHolderIndexPageWithRetry(
          {
            id: project.id,
            revision: project.revision,
            runId: activeRun,
            page: (accumulated?.pages ?? 0) + 1,
            ...(restart
              ? { enumeration }
              : accumulated?.enumeration
                ? { enumeration: accumulated.enumeration }
                : {}),
          },
          controller.signal,
          setRetry,
          accumulated
            ? Date.parse(accumulated.lastObservedAt) + HOLDER_RUN_RESUME_MS
            : undefined,
        );
        setRetry(null);
        if (
          data.id !== project.id ||
          data.revision !== project.revision ||
          data.runId !== activeRun ||
          !data.page
        )
          throw new Error('Holder page differs from this project.');
        controller.signal.throwIfAborted();
        accumulated = appendHolderIndexPage(
          accumulated,
          data.page,
          project.document.token.address,
          project.document.token.decimals,
        );
        setScan(accumulated);
        const saved: SavedHolderRun = {
          id: activeRun,
          revision: project.revision,
          pages: accumulated.pages,
          status: accumulated.status,
          updatedAt: new Date().toISOString(),
          createdAt: accumulated.firstObservedAt,
        };
        setRuns((before) =>
          [saved, ...before.filter((item) => item.id !== activeRun)].slice(
            0,
            20,
          ),
        );
        if (accumulated.status !== 'partial') break;
        // Keep provider calls paced and let the UI render between pages.
        await new Promise<void>((resolve, reject) => {
          const abort = () => {
            clearTimeout(timer);
            reject(new Error('Scan paused.'));
          };
          const timer = setTimeout(() => {
            controller.signal.removeEventListener('abort', abort);
            resolve();
          }, 1000);
          controller.signal.addEventListener('abort', abort, { once: true });
          if (controller.signal.aborted) abort();
        });
      } while (!controller.signal.aborted);
    } catch (failure) {
      if (!controller.signal.aborted)
        setError(
          failure instanceof Error
            ? failure.message
            : 'Holder scan unavailable.',
        );
    } finally {
      if (pending.current === controller) {
        pending.current = null;
        setBusy(false);
        setRetry(null);
      }
    }
  }
  async function removeSavedRun() {
    if (!runId || pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setError('');
    try {
      const params = new URLSearchParams({
        id: project.id,
        revision: String(project.revision),
        run: runId,
      });
      const response = await fetch(
        `/api/imported-projects/holder-index?${params}`,
        {
          method: 'DELETE',
          credentials: 'same-origin',
          signal: controller.signal,
        },
      );
      const result = (await response.json()) as {
        removed?: string;
        error?: string;
      };
      if (!response.ok || result.removed !== runId)
        throw new Error(result.error || 'Saved run removal unavailable.');
      setScan(null);
      setRunId(null);
      setRuns((before) => before.filter((item) => item.id !== result.removed));
      pending.current = null;
      await loadHistory();
    } catch (failure) {
      if (!controller.signal.aborted)
        setError(
          failure instanceof Error
            ? failure.message
            : 'Saved run removal unavailable.',
        );
    } finally {
      if (pending.current === controller) {
        pending.current = null;
        setBusy(false);
      }
    }
  }
  if (project.document.token.chain !== 'Solana') return null;
  return (
    <section className={styles.panel} aria-label="Mint holder index">
      <h3>Mint holder index</h3>
      <p>
        Scan beyond the largest-account sample. All token accounts returned for
        this mint are combined by owner. Validated pages are saved to your
        project. Reloading reads saved pages and never restarts provider
        requests automatically.
      </p>
      {project.document.token.totalSupplyRaw === '0' && (
        <p>
          This mint reports zero supply, so supply coverage and concentration
          cannot be calculated. Native wrapped SOL does not expose an ordinary
          mint supply.
        </p>
      )}
      <label>
        New holder scan mode
        <select
          value={enumeration}
          disabled={busy}
          onChange={(event) =>
            setEnumeration(event.target.value as typeof enumeration)
          }
        >
          <option value="das-cursor">DAS cursor index</option>
          <option value="program-accounts-v2">
            Parsed program accounts with extension data
          </option>
        </select>
      </label>
      <p>
        Parsed scans require provider support for getProgramAccountsV2. Saved
        scans resume using their original mode. Changing this selection affects
        only a new scan.
      </p>
      <div className={styles.actions}>
        <Button
          variant="outline"
          disabled={
            busy ||
            !historyReady ||
            project.archived ||
            project.document.token.totalSupplyRaw === '0'
          }
          onClick={() => void run(true)}
        >
          Scan mint holders
        </Button>
        {scan?.status === 'partial' && runId && (
          <Button
            variant="outline"
            disabled={
              busy ||
              project.archived ||
              !historyReady ||
              now - Date.parse(scan.lastObservedAt) > HOLDER_RUN_RESUME_MS ||
              runs.find((run) => run.id === runId)?.revision !==
                project.revision
            }
            onClick={() => void run(false)}
          >
            Resume holder scan
          </Button>
        )}
        {busy && (
          <Button
            variant="outline"
            onClick={() => {
              pending.current?.abort();
              setError(
                'Holder scan stopped. Saved pages remain available after reload.',
              );
            }}
          >
            Stop holder scan
          </Button>
        )}
        <Button variant="outline" onClick={onOpenChart}>
          Open token chart
        </Button>
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => void loadHistory()}
        >
          Reload saved holder runs
        </Button>
      </div>
      {runs.length > 0 && (
        <label>
          Saved holder scan
          <select
            value={runId ?? ''}
            disabled={busy}
            onChange={(event) => void loadHistory(event.target.value)}
          >
            {runs.map((run) => (
              <option key={run.id} value={run.id}>
                {new Date(run.createdAt).toLocaleString()} · {run.pages} pages ·{' '}
                {run.status} · r{run.revision}
              </option>
            ))}
          </select>
        </label>
      )}
      {runId && (
        <details>
          <summary>Remove selected saved scan</summary>
          <p>
            This removes the selected run and its stored holder pages. Other
            runs and wallet movement history remain available. Up to 20 holder
            runs can be saved per project.
          </p>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => void removeSavedRun()}
          >
            Delete this saved holder run
          </Button>
        </details>
      )}
      {scan?.status === 'partial' &&
        now - Date.parse(scan.lastObservedAt) > HOLDER_RUN_RESUME_MS && (
          <p>
            This saved scan is too old to resume safely. It remains available
            for review; start a fresh scan for current coverage.
          </p>
        )}
      {busy && (
        <output>
          {retry
            ? `Page ${retry.page}: ${retry.reason} Retrying the same saved run in ${Math.ceil(retry.delayMs / 1000)} seconds (retry ${retry.attempt} of ${HOLDER_READ_MAX_RETRIES}). `
            : ''}
          {historyReady
            ? 'Reading holder pages. Stop or leave this page to pause.'
            : 'Loading saved holder pages.'}
        </output>
      )}
      {scan && <HolderIndexResults scan={scan} />}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
