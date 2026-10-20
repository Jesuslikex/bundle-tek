'use client';
import { subscribeImportedWalletReview } from '@/lib/imported-wallet-review-events';
import { ImportedTradeSessions } from './imported-trade-sessions';
import { AutoSell } from './auto-sell-modal';
import { ImportedPairTradeWalletReview } from './imported-pair-trade-wallet-review';
import { subscribeImportedReceiptSaved } from '@/lib/imported-receipt-events';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useImportedWorkspaceWalletView } from './imported-workspace-frame';
import { readPanelJson } from './read-panel-json';
import { Button } from '@/components/ui/button';
import type { WorkspaceWallet, WalletFolder } from '@/lib/wallet-workspace';
import type { WalletBalance } from '@/lib/wallet-balance-format';
import { ImportedTradeWallets } from './imported-trade-wallets';
import type { ImportedTokenProject } from '@/lib/imported-token-project';
import type { ImportedSwapBalance } from '@/lib/imported-swap-balance';
import { formatNativeBalance } from '@/lib/wallet-balance-format';
import { solanaTokenAtoms } from '@/lib/solana-token-amount';
import { warmupAtoms } from '@/lib/wallet-warmup';
import { ImportedSellAcquisitions } from './imported-sell-acquisitions';
import { ImportedSwapPreparation } from './imported-swap-preparation';
import { ImportedSellPresets } from './imported-sell-presets';
import { validatedImportedBalance } from '@/lib/imported-balance-review';
import type { ImportedSwapReceipt } from '@/lib/imported-approval-history';
import {
  importedHandoffWallet,
  type ImportedSellHandoff,
} from '@/lib/imported-sell-handoff';

async function readTradeWalletRoster(response: Response) {
  const unavailable =
    'Wallet list unavailable. Reload trade wallets to try again.';
  const body = await readPanelJson(response, unavailable);
  const data = body as {
    wallets?: WorkspaceWallet[];
    folders?: WalletFolder[];
    balances?: WalletBalance[];
    error?: unknown;
  } | null;
  if (
    !response.ok ||
    !data ||
    typeof data !== 'object' ||
    Array.isArray(data) ||
    !Array.isArray(data.wallets)
  )
    throw new Error(typeof data?.error === 'string' ? data.error : unavailable);
  return { ...data, wallets: data.wallets };
}

export function ImportedSwapWallet({
  project,
  side,
  amount,
  locked,
  onSaved,
  onSavingChange,
  handoff,
  onReviewBuy,
  onAmountChange,
  onWalletTradeReview,
}: {
  project: ImportedTokenProject;
  side: 'Buy' | 'Sell';
  amount: string;
  locked: boolean;
  onSaved: (project: ImportedTokenProject) => void;
  onSavingChange: (saving: boolean) => void;
  handoff?: ImportedSellHandoff;
  onReviewBuy?: (receipt: ImportedSwapReceipt) => void;
  onAmountChange: (amount: string) => void;
  onWalletTradeReview: (side: 'Buy' | 'Sell', amount?: string) => void;
}) {
  const showWallets = useImportedWorkspaceWalletView();
  const reviewSection = useRef<HTMLDetailsElement>(null);
  const openWalletReview = useCallback(() => {
    showWallets?.();
    requestAnimationFrame(() => {
      const review = reviewSection.current;
      if (!review?.isConnected) return;
      review.open = true;
      const pane = review.closest<HTMLElement>('[role="tabpanel"]');
      const dock = review.closest<HTMLElement>('[data-wallet-dock="docked"]');
      if (pane && dock) {
        pane.scrollTop +=
          review.getBoundingClientRect().top - pane.getBoundingClientRect().top;
      } else {
        review.scrollIntoView({ block: 'nearest' });
      }
      review
        .querySelector<HTMLElement>('summary')
        ?.focus({ preventScroll: true });
    });
  }, [showWallets]);
  const [folders, setFolders] = useState<WalletFolder[]>([]);
  const [balances, setBalances] = useState<WalletBalance[]>([]);
  const [wallets, setWallets] = useState<WorkspaceWallet[]>([]),
    [selected, setSelected] = useState(
      handoff?.wallet ?? project.document.tradeSettings?.wallet ?? '',
    ),
    [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [reviewedCurrentWallet, setReviewedCurrentWallet] = useState(false);
  const pending = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    pending.current = controller;
    void fetch('/api/wallet-workspace', {
      signal: controller.signal,
      cache: 'no-store',
    })
      .then(async (response) => {
        const data = await readTradeWalletRoster(response);
        if (!controller.signal.aborted) {
          setFolders(Array.isArray(data.folders) ? data.folders : []);
          setBalances(Array.isArray(data.balances) ? data.balances : []);
          setWallets(
            data.wallets.filter(
              (wallet) => wallet.chain === 'Solana' && !wallet.archived,
            ),
          );
        }
      })
      .catch((e) => {
        if (!controller.signal.aborted)
          setError(e instanceof Error ? e.message : 'Wallet list unavailable.');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => pending.current?.abort();
  }, []);
  async function reload() {
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    setLoading(true);
    setError('');
    setSelected('');
    setWallets([]);
    setFolders([]);
    setBalances([]);
    try {
      const response = await fetch('/api/wallet-workspace', {
        signal: controller.signal,
        cache: 'no-store',
      });
      const data = await readTradeWalletRoster(response);
      if (!controller.signal.aborted) {
        setFolders(Array.isArray(data.folders) ? data.folders : []);
        setBalances(Array.isArray(data.balances) ? data.balances : []);
        setWallets(
          data.wallets.filter(
            (wallet) => wallet.chain === 'Solana' && !wallet.archived,
          ),
        );
      }
    } catch (e) {
      if (!controller.signal.aborted)
        setError(e instanceof Error ? e.message : 'Wallet list unavailable.');
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }
  useEffect(
    () =>
      subscribeImportedWalletReview(
        {
          projectId: project.id,
          revision: project.revision,
          mint: project.document.token.address,
        },
        (review) => {
          if (locked || saving || loading)
            return 'Wait for the current wallet operation to finish before reviewing another trade.';
          const active = wallets.find(
            (item) =>
              item.address === review.wallet &&
              item.chain === 'Solana' &&
              !item.archived,
          );
          if (!active)
            return 'Save this public wallet in your active Solana wallet workspace before reviewing a trade.';
          setSelected(active.address);
          setReviewedCurrentWallet(true);
          setError('');
          onWalletTradeReview(review.side);
          openWalletReview();
          return null;
        },
      ),
    [
      project.id,
      project.revision,
      project.document.token.address,
      wallets,
      locked,
      saving,
      loading,
      onWalletTradeReview,
      openWalletReview,
    ],
  );
  const selectedWallet = wallets.find((item) => item.address === selected);
  const wallet =
    handoff && !reviewedCurrentWallet
      ? selected === handoff.wallet
        ? (importedHandoffWallet(handoff, wallets) ?? undefined)
        : undefined
      : selectedWallet;
  async function save() {
    if (!wallet) return;
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    setSaving(true);
    onSavingChange(true);
    setError('');
    try {
      const response = await fetch('/api/imported-projects', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          action: 'settings',
          id: project.id,
          expectedRevision: project.revision,
          settings: {
            side,
            amount,
            wallet: wallet.address,
            walletRevision: wallet.revision,
          },
        }),
      });
      const data = (await response.json()) as {
        project?: ImportedTokenProject;
        error?: string;
      };
      if (!response.ok)
        throw new Error(data.error || 'Trade settings could not be saved.');
      if (
        !data.project ||
        data.project.id !== project.id ||
        data.project.revision <= project.revision ||
        data.project.document.executionAllowed !== false
      )
        throw new Error(
          'Saved project does not match this import. Reload projects.',
        );
      if (!controller.signal.aborted) onSaved(data.project);
    } catch (e) {
      if (!controller.signal.aborted)
        setError(
          e instanceof Error ? e.message : 'Trade settings could not be saved.',
        );
    } finally {
      if (!controller.signal.aborted) {
        setSaving(false);
        onSavingChange(false);
      }
    }
  }
  const rosterActions = (
    <Button
      variant="outline"
      disabled={loading || saving || locked}
      onClick={() => void reload()}
    >
      Reload trade wallets
    </Button>
  );
  return (
    <section aria-label="Imported swap wallet">
      {loading && <output>Loading saved trade wallets…</output>}
      {loading && rosterActions}
      {error && <p role="alert">{error}</p>}

      <div className="imported-project-wallet-inventory">
        {!loading && (
          <ImportedTradeWallets
            key={`${project.id}:${project.revision}`}
            project={project}
            wallets={wallets}
            folders={folders}
            balances={balances}
            selected={wallet?.address ?? ''}
            locked={locked || saving}
            actions={rosterActions}
            onReview={(item, direction, reviewedAmount) => {
              setSelected(item.address);
              setReviewedCurrentWallet(true);
              onWalletTradeReview(direction, reviewedAmount);
              openWalletReview();
            }}
          />
        )}
      </div>
      <p>
        Public balance review only. Selecting an address does not connect or
        unlock its signer.
      </p>
      <details
        className="imported-selected-wallet-review"
        ref={reviewSection}
        open={Boolean(handoff)}
      >
        <summary>Selected wallet review</summary>

        <label>
          Wallet for balance review{' '}
          <select
            aria-label="Wallet for balance review"
            value={wallet ? selected : ''}
            disabled={loading || saving || locked}
            onChange={(e) => {
              setSelected(e.target.value);
              setReviewedCurrentWallet(true);
            }}
          >
            <option value="">Select an active Solana wallet</option>
            {wallets.map((item) => (
              <option key={item.address} value={item.address}>
                {item.label} · {item.address.slice(0, 6)}…
                {item.address.slice(-4)}
              </option>
            ))}
          </select>
        </label>
        <Button
          variant="outline"
          disabled={loading || saving || locked || !wallet}
          onClick={() => void save()}
        >
          {saving ? 'Saving settings…' : 'Save trade settings'}
        </Button>
        {project.document.tradeSettings && (
          <p>
            Saved trade settings: {project.document.tradeSettings.side}{' '}
            {project.document.tradeSettings.amount} · wallet revision{' '}
            {project.document.tradeSettings.walletRevision}. Settings only; no
            order submitted.
          </p>
        )}
        {!loading && selected && !wallet && (
          <p role="alert">
            {handoff && !reviewedCurrentWallet
              ? 'Receipt wallet is archived, unavailable or has changed revision. Choose a current active wallet explicitly before preparing a sell.'
              : 'Saved wallet is unavailable. Select an active wallet.'}
          </p>
        )}
        {wallet &&
          project.document.tradeSettings?.wallet === wallet.address &&
          project.document.tradeSettings.walletRevision !== wallet.revision && (
            <p>
              Saved wallet revision has changed. Review this wallet and save
              current settings.
            </p>
          )}

        {wallet && side === 'Sell' && (
          <ImportedSellAcquisitions
            key={[
              project.id,
              project.revision,
              wallet.address,
              wallet.revision,
              handoff?.receiptId ?? '',
            ].join(':')}
            project={project}
            wallet={wallet}
            amount={amount}
            locked={locked || saving}
            initialBuyReceiptId={
              handoff?.wallet === wallet.address ? handoff.receiptId : undefined
            }
            onReviewBuy={onReviewBuy}
            onAmountChange={onAmountChange}
          />
        )}
        {wallet && side === 'Buy' && (
          <ImportedSwapPreparation
            key={`prepare:${project.id}:${project.revision}:${wallet.address}:${wallet.revision}:${side}:${amount}:${handoff?.receiptId ?? ''}`}
            project={project}
            wallet={wallet}
            side={side}
            amount={amount}
            locked={locked || saving}
            onReviewBuy={onReviewBuy}
          />
        )}
        {wallet && (
          <ImportedSwapBalanceCheck
            key={`${project.id}:${project.revision}:${wallet.address}:${wallet.revision}:${side}:${amount}`}
            project={project}
            wallet={wallet}
            side={side}
            amount={amount}
            locked={locked || saving}
            onAmountChange={onAmountChange}
          />
        )}
        {wallet && project.document.token.chain === 'Solana' && (
          <ImportedPairTradeWalletReview
            key={`pair:${project.id}:${project.revision}:${wallet.address}:${wallet.revision}:${side}`}
            project={project}
            wallet={wallet}
            side={side}
            locked={locked || saving || loading}
          />
        )}
      </details>
      {!loading && project.document.token.chain === 'Solana' && (
        <AutoSell
          key={`auto-sell:${project.id}:${project.revision}`}
          project={project}
          wallets={wallets}
          locked={locked || saving}
        />
      )}
      <details className="imported-bundle-session-tools">
        <summary>Wallet groups and bundle sessions</summary>
        {!loading && (
          <ImportedTradeSessions
            key={`sessions:${project.id}:${project.revision}`}
            project={project}
            wallets={wallets}
            folders={folders}
            locked={locked || saving}
            onReviewBuy={onReviewBuy}
          />
        )}
      </details>
    </section>
  );
}
function ImportedSwapBalanceCheck({
  project,
  wallet,
  side,
  amount,
  locked,
  onAmountChange,
}: {
  project: ImportedTokenProject;
  wallet: WorkspaceWallet;
  side: 'Buy' | 'Sell';
  amount: string;
  locked: boolean;
  onAmountChange: (amount: string) => void;
}) {
  const [report, setReport] = useState<ImportedSwapBalance | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const [stale, setStale] = useState(false);
  const pending = useRef<AbortController | null>(null);
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
          setBusy(false);
          setStale(true);
        },
      ),
    [project.id, project.document.token.address, wallet.address],
  );
  useEffect(() => () => pending.current?.abort(), []);
  async function read() {
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    setReport(null);
    setBusy(true);
    setError('');
    try {
      const raw = (
        side === 'Buy'
          ? warmupAtoms(amount, 9)
          : solanaTokenAtoms(amount, project.document.token.decimals)
      ).toString();
      const response = await fetch('/api/imported-projects/balance', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          id: project.id,
          revision: project.revision,
          wallet: wallet.address,
          walletRevision: wallet.revision,
          side,
          amount,
        }),
      });
      const data = (await response.json()) as {
        id: string;
        revision: number;
        walletRevision: number;
        report: ImportedSwapBalance;
        error?: string;
      };
      if (!response.ok)
        throw new Error(data.error || 'Balance check unavailable.');
      if (
        data.id !== project.id ||
        data.revision !== project.revision ||
        data.walletRevision !== wallet.revision ||
        data.report.wallet !== wallet.address ||
        data.report.mint !== project.document.token.address ||
        data.report.side !== side ||
        data.report.requestedRaw !== raw ||
        data.report.executionAllowed !== false
      )
        throw new Error('Balance report does not match this trade review.');
      const report = validatedImportedBalance(data.report, {
        wallet: wallet.address,
        mint: project.document.token.address,
        tokenDecimals: project.document.token.decimals,
        side,
        requestedRaw: raw,
      });
      if (!controller.signal.aborted) {
        setReport(report);
        setStale(false);
      }
    } catch (e) {
      if (!controller.signal.aborted)
        setError(e instanceof Error ? e.message : 'Balance check unavailable.');
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  return (
    <div>
      <p className="warmup-address">
        {wallet.label} · {wallet.address}
      </p>
      <Button
        variant="outline"
        disabled={busy || locked}
        onClick={() => void read()}
      >
        {busy ? 'Checking wallet…' : 'Check trade balance'}
      </Button>
      {error && <p role="alert">{error}</p>}
      {stale && (
        <output>
          A trade finalized for this wallet. This balance review needs
          refreshing before the next trade.
        </output>
      )}
      {report && (
        <section aria-label="Imported swap balance report">
          {side === 'Sell' && (
            <ImportedSellPresets
              supply={{
                mint: project.document.token.address,
                decimals: project.document.token.decimals,
                totalSupplyRaw: project.document.token.totalSupplyRaw,
                observedAt: project.document.token.observedAt,
              }}
              report={report}
              context={{
                wallet: wallet.address,
                mint: project.document.token.address,
                tokenDecimals: project.document.token.decimals,
                side,
                requestedRaw: report.requestedRaw,
              }}
              locked={locked || busy || stale}
              onAmountChange={onAmountChange}
            />
          )}
          <p>
            {report.amountCovered
              ? 'Observed input units cover this amount. Fees and transferability remain unverified.'
              : `Input shortfall: ${formatNativeBalance(report.shortfallRaw, report.decimals)} ${side === 'Buy' ? 'SOL' : project.document.token.symbol}.`}
          </p>
          <p>
            Observed SOL: {formatNativeBalance(report.nativeRaw, 9)}. Token
            balance:{' '}
            {formatNativeBalance(
              report.tokenRaw,
              project.document.token.decimals,
            )}{' '}
            {project.document.token.symbol}.
          </p>
          <p>
            Unfrozen token units: {report.unfrozenRaw}. Frozen units:{' '}
            {report.frozenRaw}. {report.token2022 ? 'Token-2022 mint.' : ''}
          </p>
          {side === 'Sell' && (
            <p>
              {report.preparationSupported
                ? 'Mint and account extensions are supported for unsigned sell preparation.'
                : 'Sell preparation is unavailable for this inventory.'}
              {report.blockedExtensions.length > 0 &&
                ` Blocked: ${report.blockedExtensions.join(', ')}.`}
              {report.mintExtensions !== null &&
                ` Observed mint extensions: ${report.mintExtensions.join(', ') || 'none'}.`}
              {report.mintSlot !== null && ` Mint slot ${report.mintSlot}.`}
            </p>
          )}
          <p>
            {report.source} · confirmed token slots {report.minSlot} to{' '}
            {report.maxSlot}{' '}
            {report.nativeSlot !== undefined
              ? ` · native slot ${report.nativeSlot}`
              : ''}{' '}
            · {new Date(report.observedAt).toLocaleString()}
          </p>
          {report.source.includes('docs-demo') && (
            <p>
              Public demo provider. A dedicated provider is required before
              production release.
            </p>
          )}
          <p>{report.limitations}</p>
        </section>
      )}
    </div>
  );
}
