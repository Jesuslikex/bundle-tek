'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { EVM_NETWORKS } from '@/lib/evm-network';
import type { ImportedTokenProject } from '@/lib/imported-token-project';
import { ImportedTokenHistory } from './imported-token-history';
import { ImportedPreparationHistory } from './imported-preparation-history';
import { ImportedApprovalHistory } from './imported-approval-history';
import { ImportedTradeHistory } from './imported-trade-history';
import { ImportedTokenQuote } from './imported-token-quote';
import { ImportedTokenMarket } from './imported-token-market';
import { ImportedSupplyTracker } from './imported-supply-tracker';
import { HolderIndexPanel } from './holder-index-panel';
import { ImportedEvmWalletBalances } from './imported-evm-wallet-balances';
import type { ImportedSwapReceipt } from '@/lib/imported-approval-history';
import { importedChartWorkspaceId } from '@/lib/imported-chart-workspace';
import {
  importedSellHandoff,
  type ImportedSellHandoff,
} from '@/lib/imported-sell-handoff';

function supply(raw: string, decimals: number) {
  if (!decimals) return raw;
  const digits = raw.padStart(decimals + 1, '0');
  const fraction = digits.slice(-decimals).replace(/0+$/, '');
  return digits.slice(0, -decimals) + (fraction ? '.' + fraction : '');
}

export function ImportedTokenProjects({
  initialId = '',
  onProjectsChange,
}: {
  initialId?: string;
  onProjectsChange?: (projects: ImportedTokenProject[]) => void;
}) {
  const [projects, setProjects] = useState<ImportedTokenProject[]>([]);
  const [chain, setChain] = useState('Solana');
  const [address, setAddress] = useState('');
  const [archived, setArchived] = useState(false);
  const [selected, setSelected] = useState(initialId);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [compactWorkspace, setCompactWorkspace] = useState(true);
  const request = useRef<AbortController | null>(null);
  const current = projects.find((p) => p.id === selected);
  const [sellSelection, setSellSelection] = useState<{
    sequence: number;
    handoff: ImportedSellHandoff;
  } | null>(null);
  const sellSequence = useRef(0),
    swapReview = useRef<HTMLElement | null>(null);
  const chartReview = useRef<HTMLElement | null>(null);
  function openChart() {
    const chart =
      chartReview.current?.querySelector<HTMLElement>(
        '[aria-label="Inspect chart candles"]',
      ) ?? chartReview.current;
    chart?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    chart?.focus({ preventScroll: true });
  }
  const selectedHandoff =
    current &&
    sellSelection?.handoff.projectId === current.id &&
    sellSelection.handoff.projectRevision === current.revision &&
    !current.archived
      ? sellSelection
      : null;
  function reviewBuy(receipt: ImportedSwapReceipt) {
    if (!current || busy) return;
    try {
      const handoff = importedSellHandoff(receipt, current);
      setSellSelection({ sequence: ++sellSequence.current, handoff });
      setError('');
      requestAnimationFrame(() => {
        swapReview.current?.scrollIntoView({
          block: 'start',
          behavior: 'smooth',
        });
        swapReview.current?.focus({ preventScroll: true });
      });
    } catch (error) {
      setError(
        error instanceof Error ? error.message : 'Sell handoff unavailable.',
      );
    }
  }

  const load = useCallback(
    async (signal: AbortSignal) => {
      const response = await fetch('/api/imported-projects', { signal });
      const data = (await response.json()) as {
        error?: string;
        projects: ImportedTokenProject[];
      };
      if (!response.ok)
        throw new Error(data.error || 'Imported projects unavailable.');
      if (!signal.aborted) {
        setProjects(data.projects);
        onProjectsChange?.(data.projects);
        if (initialId) {
          const requested = data.projects.find((p) => p.id === initialId);
          if (!requested)
            setError('Imported project is unavailable. Reload projects.');
          else setArchived(requested.archived);
        }
      }
    },
    [initialId, onProjectsChange],
  );
  useEffect(() => {
    const controller = new AbortController();
    request.current = controller;
    void Promise.resolve()
      .then(() => load(controller.signal))
      .catch((e) => {
        if (!controller.signal.aborted)
          setError(e instanceof Error ? e.message : 'Projects unavailable.');
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false);
      });
    return () => request.current?.abort();
  }, [load]);

  async function run(
    action: 'reload' | 'import' | 'refresh' | 'archive' | 'restore',
    project?: ImportedTokenProject,
  ) {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setError('');
    try {
      if (action === 'reload') await load(controller.signal);
      else {
        const response = await fetch('/api/imported-projects', {
          method: 'POST',
          signal: controller.signal,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(
            action === 'import'
              ? { action, chain, address: address.trim() }
              : {
                  action,
                  id: project?.id,
                  expectedRevision: project?.revision,
                },
          ),
        });
        const data = (await response.json()) as {
          error?: string;
          project?: ImportedTokenProject;
        };
        if (!response.ok)
          throw new Error(
            data.error ||
              'Project change unavailable. Reload to check its state.',
          );
        if (!data.project)
          throw new Error('Reload to check the saved project.');
        const saved = data.project;
        if (!controller.signal.aborted) {
          onProjectsChange?.([saved]);
          setProjects((previous) => [
            saved,
            ...previous.filter((p) => p.id !== saved.id),
          ]);
          setSelected(data.project.id);
          setSellSelection(null);
          setArchived(data.project.archived);
          if (action === 'import') setAddress('');
        }
      }
    } catch (e) {
      if (!controller.signal.aborted)
        setError(
          e instanceof Error ? e.message : 'Project change unavailable.',
        );
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  return (
    <section
      className="settings-panel imported-projects"
      aria-label="Imported token projects"
    >
      <div className="page-title">
        <span className="eyebrow">EXISTING TOKENS</span>
        <h1>{current ? 'Token workspace' : 'Import a token'}</h1>
        <p>
          Save an existing token by network and contract address, then inspect
          its on-chain identity.
        </p>
      </div>
      <details className="token-project-picker" open={!current}>
        <summary>Choose or import a token</summary>
        <p>
          Importing does not launch a token or establish authenticity. Supported
          Solana swaps require a fresh preparation, your exact wallet signature
          and a separate mainnet submission.
        </p>
        <form
          className="imported-project-form"
          onSubmit={(e) => {
            e.preventDefault();
            void run('import');
          }}
        >
          <label>
            Token network{' '}
            <select
              aria-label="Token network"
              value={chain}
              disabled={busy}
              onChange={(e) => setChain(e.target.value)}
            >
              {['Solana', ...Object.keys(EVM_NETWORKS)].map((network) => (
                <option key={network}>{network}</option>
              ))}
            </select>
          </label>
          <label>
            Token address{' '}
            <Input
              aria-label="Token address"
              placeholder="Enter a mint or contract address"
              value={address}
              disabled={busy}
              maxLength={44}
              onChange={(e) => setAddress(e.target.value)}
              required
            />
          </label>
          <Button type="submit" disabled={busy || !address.trim()}>
            {busy ? 'Loading…' : 'Import token'}
          </Button>
        </form>
        <div className="wallet-roster-actions">
          <h2>Imported projects</h2>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => void run('reload')}
          >
            Reload imported projects
          </Button>
          <Button
            variant="outline"
            aria-pressed={archived}
            disabled={busy}
            onClick={() => {
              setArchived(!archived);
              setSelected('');
              setSellSelection(null);
            }}
          >
            {archived ? 'Show active imports' : 'Show archived imports'}
          </Button>
        </div>
        {!projects.some((p) => p.archived === archived) && !busy && (
          <p>No {archived ? 'archived' : 'active'} imports.</p>
        )}
        <div className="warmup-history">
          {projects
            .filter((p) => p.archived === archived)
            .map((project) => (
              <article key={project.id}>
                <strong>
                  {project.document.token.name} ({project.document.token.symbol}
                  )
                </strong>
                <p>
                  {project.document.token.chain} · r{project.revision} ·{' '}
                  {project.archived ? 'Archived' : 'Active'}
                </p>
                <code className="warmup-address">
                  {project.document.token.address}
                </code>
                <div>
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() => {
                      setSelected(project.id);
                      setSellSelection(null);
                    }}
                  >
                    Open import {project.document.token.symbol}
                  </Button>
                </div>
              </article>
            ))}
        </div>
      </details>
      {error && <p role="alert">{error}</p>}
      {current && (
        <section
          aria-label="Imported token details"
          className="wallet-warmup-panel"
        >
          <h2>
            {current.document.token.name} ({current.document.token.symbol})
          </h2>
          <p>
            {current.document.token.chain} ·{' '}
            {current.archived ? 'Archived' : 'Active'} · revision{' '}
            {current.revision}
          </p>
          <code className="warmup-address">
            {current.document.token.address}
          </code>
          <details className="token-identity-review">
            <summary>Token identity and supply</summary>
            <p>
              Supply:{' '}
              {supply(
                current.document.token.totalSupplyRaw,
                current.document.token.decimals,
              )}{' '}
              · {current.document.token.decimals} decimals
            </p>
            <p>
              Identity observed{' '}
              {new Date(current.document.token.observedAt).toLocaleString()} ·{' '}
              {current.document.token.source}
              {current.document.token.contextSlot !== undefined
                ? ` · slot ${current.document.token.contextSlot}`
                : ''}
              {current.document.token.blockNumber !== undefined
                ? ` · block ${current.document.token.blockNumber}`
                : ''}
            </p>
            <p>
              Network and address are fixed for this project. Identity can
              become stale. Supply is not a price or liquidity measurement.
            </p>
            <details>
              <summary>Exact token units</summary>
              <p>Raw supply: {current.document.token.totalSupplyRaw}</p>
              {current.document.token.tokenProgram && (
                <p>Token program: {current.document.token.tokenProgram}</p>
              )}
            </details>
          </details>
          <div className="wallet-roster-actions">
            {!current.archived && (
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => void run('refresh', current)}
              >
                Refresh imported identity
              </Button>
            )}
            <Button
              variant="outline"
              disabled={busy}
              onClick={() =>
                void run(current.archived ? 'restore' : 'archive', current)
              }
            >
              {current.archived
                ? 'Restore imported project'
                : 'Archive imported project'}
            </Button>
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setSelected('');
                setSellSelection(null);
              }}
            >
              Close imported details
            </Button>
          </div>
          <Button variant="outline" onClick={openChart}>
            Open token chart and supply workspace
          </Button>
          <div
            className="imported-workspace-layout-controls"
            aria-label="Trading workspace layout"
          >
            <Button
              variant="outline"
              aria-pressed={compactWorkspace}
              onClick={() => setCompactWorkspace(true)}
            >
              Keep chart visible
            </Button>
            <Button
              variant="outline"
              aria-pressed={!compactWorkspace}
              onClick={() => setCompactWorkspace(false)}
            >
              Full page review
            </Button>
          </div>
          <div
            className={`imported-live-workspace${compactWorkspace ? ' imported-live-workspace--compact' : ''}`}
          >
            <section
              ref={chartReview}
              id={importedChartWorkspaceId(current.id)}
              data-token-mint={current.document.token.address}
              data-token-chain={current.document.token.chain}
              tabIndex={-1}
              aria-label="Open token chart"
            >
              <ImportedTokenMarket
                key={`market:${current.id}:${current.revision}`}
                project={current}
              />
            </section>
            <section
              className="imported-workspace-trading"
              ref={swapReview}
              tabIndex={-1}
              aria-label="Imported transaction review"
            >
              <ImportedTokenQuote
                key={`quote:${current.id}:${current.revision}:${selectedHandoff?.sequence ?? 0}`}
                project={current}
                handoff={selectedHandoff?.handoff}
                onReviewBuy={reviewBuy}
                onSaved={(saved) => {
                  onProjectsChange?.([saved]);
                  setProjects((items) =>
                    items.map((item) =>
                      item.id === saved.id && item.revision < saved.revision
                        ? saved
                        : item,
                    ),
                  );
                }}
              />
            </section>
            <ImportedSupplyTracker
              key={`supply:${current.id}:${current.revision}`}
              project={current}
              onOpenChart={openChart}
            />
            {current.document.token.chain === 'Solana' && (
              <HolderIndexPanel
                key={`holder-index:${current.id}:${current.revision}`}
                project={current}
                onOpenChart={openChart}
              />
            )}
          </div>
          {current.document.token.chain !== 'Solana' && (
            <ImportedEvmWalletBalances
              key={`evm-balance:${current.id}:${current.revision}`}
              project={current}
            />
          )}
          <ImportedTokenHistory
            key={`${current.id}:${current.revision}`}
            id={current.id}
            revision={current.revision}
          />
          <ImportedPreparationHistory
            key={`preparations:${current.id}`}
            id={current.id}
            revision={current.revision}
          />
          {current.document.token.chain === 'Solana' && (
            <ImportedTradeHistory
              key={`trades:${current.id}:${current.revision}`}
              project={current}
              onReviewBuy={reviewBuy}
            />
          )}
          {current.document.token.chain === 'Solana' && (
            <ImportedApprovalHistory
              key={`approvals:${current.id}:${current.revision}`}
              project={current}
              onReviewBuy={reviewBuy}
            />
          )}
        </section>
      )}
    </section>
  );
}
