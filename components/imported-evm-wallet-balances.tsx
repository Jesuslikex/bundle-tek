'use client';
import { useEffect, useRef, useState } from 'react';
import { Button } from './ui/button';
import type { WorkspaceWallet } from '@/lib/wallet-workspace';
import type { ImportedTokenProject } from '@/lib/imported-token-project';
import type { ImportedEvmBalance } from '@/lib/imported-evm-balance';
type Result = {
  id: string;
  revision: number;
  observations: ImportedEvmBalance[];
  executionAllowed: boolean;
  error?: string;
};
export function ImportedEvmWalletBalances({
  project,
}: {
  project: ImportedTokenProject;
}) {
  const [wallets, setWallets] = useState<WorkspaceWallet[]>([]),
    [selected, setSelected] = useState(''),
    [saved, setSaved] = useState<ImportedEvmBalance[]>([]),
    [busy, setBusy] = useState(true),
    [error, setError] = useState('');
  const pending = useRef<AbortController | null>(null);
  const valid = (data: Result) =>
    data.id === project.id &&
    data.revision === project.revision &&
    data.executionAllowed === false &&
    Array.isArray(data.observations) &&
    data.observations.length <= 20 &&
    data.observations.every(
      (r) =>
        r.snapshot.chain === project.document.token.chain &&
        r.snapshot.holdings.length === 1 &&
        r.snapshot.holdings[0].contract === project.document.token.address,
    );
  useEffect(() => {
    const c = new AbortController();
    pending.current = c;
    void Promise.all([
      fetch('/api/wallet-workspace', { signal: c.signal, cache: 'no-store' }),
      fetch(
        `/api/imported-projects/evm-balance?${new URLSearchParams({ id: project.id, revision: String(project.revision) })}`,
        { signal: c.signal, cache: 'no-store' },
      ),
    ])
      .then(async ([roster, response]) => {
        const [workspace, data] = await Promise.all([
          roster.json() as Promise<{
            wallets: WorkspaceWallet[];
            error?: string;
          }>,
          response.json() as Promise<Result>,
        ]);
        if (!roster.ok || !Array.isArray(workspace.wallets))
          throw new Error(workspace.error || 'Wallet roster unavailable.');
        if (!response.ok)
          throw new Error(data.error || 'Saved project balances unavailable.');
        if (
          data.id !== project.id ||
          data.revision !== project.revision ||
          data.executionAllowed !== false ||
          !Array.isArray(data.observations) ||
          data.observations.length > 20 ||
          data.observations.some(
            (r) =>
              r.snapshot.chain !== project.document.token.chain ||
              r.snapshot.holdings.length !== 1 ||
              r.snapshot.holdings[0].contract !==
                project.document.token.address,
          )
        )
          throw new Error('Project balance context mismatch.');
        if (!c.signal.aborted) {
          setWallets(
            workspace.wallets.filter(
              (w) => w.chain === project.document.token.chain,
            ),
          );
          setSaved(data.observations);
          setSelected(data.observations[0]?.snapshot.address ?? '');
        }
      })
      .catch((e) => {
        if (!c.signal.aborted)
          setError(
            e instanceof Error
              ? e.message
              : 'Project wallet balances unavailable.',
          );
      })
      .finally(() => {
        if (!c.signal.aborted) setBusy(false);
      });
    return () => pending.current?.abort();
  }, [
    project.id,
    project.revision,
    project.document.token.chain,
    project.document.token.address,
  ]);
  const wallet = wallets.find((w) => w.address === selected),
    report = saved.find((r) => r.snapshot.address === selected),
    holding = report?.snapshot.holdings[0];
  async function refresh() {
    if (!wallet || wallet.archived || project.archived || busy) return;
    const c = new AbortController();
    pending.current?.abort();
    pending.current = c;
    setBusy(true);
    setError('');
    try {
      const response = await fetch('/api/imported-projects/evm-balance', {
        method: 'POST',
        signal: c.signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: project.id,
          revision: project.revision,
          wallet: wallet.address,
          walletRevision: wallet.revision,
        }),
      });
      const data = (await response.json()) as Result;
      if (!response.ok)
        throw new Error(data.error || 'Project token balance unavailable.');
      if (!valid(data)) throw new Error('Project balance context mismatch.');
      if (!c.signal.aborted) setSaved(data.observations);
    } catch (e) {
      if (!c.signal.aborted)
        setError(
          e instanceof Error ? e.message : 'Project token balance unavailable.',
        );
    } finally {
      if (!c.signal.aborted) setBusy(false);
    }
  }
  return (
    <section aria-label="Imported EVM wallet balance">
      <h3>Project token balance</h3>
      <p>
        Inspect this saved contract in a wallet from the same network. Selecting
        a public address does not connect its signer. Retains the latest balance
        for up to 20 wallets per project. These are token units, not a swap
        quote, fee check or execution approval.
      </p>
      <label>
        Project balance wallet{' '}
        <select
          aria-label="Project balance wallet"
          value={selected}
          disabled={busy}
          onChange={(e) => {
            setSelected(e.target.value);
            setError('');
          }}
        >
          <option value="">
            Select a saved {project.document.token.chain} wallet
          </option>
          {wallets.map((w) => (
            <option key={w.address} value={w.address}>
              {w.label || w.address} ·{' '}
              {w.archived ? 'Archived' : `r${w.revision}`}
            </option>
          ))}
          {saved
            .filter(
              (r) => !wallets.some((w) => w.address === r.snapshot.address),
            )
            .map((r) => (
              <option key={r.snapshot.address} value={r.snapshot.address}>
                {r.snapshot.address} · Saved observation
              </option>
            ))}
        </select>
      </label>
      <Button
        variant="outline"
        disabled={busy || !wallet || wallet.archived || project.archived}
        onClick={() => void refresh()}
      >
        {busy ? 'Loading project balances…' : 'Check project token balance'}
      </Button>
      {error && <p role="alert">{error}</p>}
      {project.archived && (
        <p>Archived project. Saved wallet observations remain readable.</p>
      )}
      {report && holding ? (
        <>
          <p>
            <strong>
              {holding.amount} {project.document.token.symbol}
            </strong>{' '}
            · {holding.decimals} decimals
          </p>
          <p>
            Wallet:{' '}
            <code className="warmup-address">{report.snapshot.address}</code>
          </p>
          <p>
            Contract: <code className="warmup-address">{holding.contract}</code>
          </p>
          <p>Raw units: {holding.raw}</p>
          <p>
            Observed {new Date(report.snapshot.observedAt).toLocaleString()} ·{' '}
            {report.snapshot.source} · block {report.snapshot.blockNumber} ·
            captured project r{report.projectRevision}, wallet r
            {report.walletRevision}
          </p>
          {(report.projectRevision !== project.revision ||
            report.walletRevision !== wallet?.revision) && (
            <p>
              Project or wallet metadata changed since this read. The balance
              remains a historical observation.
            </p>
          )}
          <details>
            <summary>Balance observation block hash</summary>
            <code className="warmup-address">{report.snapshot.blockHash}</code>
          </details>
        </>
      ) : (
        !busy && <p>No saved balance for this project and selected wallet.</p>
      )}
    </section>
  );
}
