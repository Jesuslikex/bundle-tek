'use client';
import { subscribeImportedReceiptSaved } from '@/lib/imported-receipt-events';
import { useEffect, useRef, useState } from 'react';
import { Button } from './ui/button';
import { ImportedSellPresets } from './imported-sell-presets';
import type { ImportedTokenProject } from '@/lib/imported-token-project';
import type { WorkspaceWallet } from '@/lib/wallet-workspace';
import type { ImportedSwapBalance } from '@/lib/imported-swap-balance';
import { validatedImportedBalance } from '@/lib/imported-balance-review';
import { formatNativeBalance } from '@/lib/wallet-balance-format';
export function ImportedWalletSellReview({
  project,
  wallet,
  locked,
  onReview,
}: {
  project: ImportedTokenProject;
  wallet: WorkspaceWallet;
  locked: boolean;
  onReview: (amount: string) => void;
}) {
  const [report, setReport] = useState<ImportedSwapBalance | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [tradeNotice, setTradeNotice] = useState('');
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
          setReport(null);
          setBusy(false);
          setTradeNotice(
            'A trade finalized for this wallet. Check sell percentages again after refreshing token holdings.',
          );
        },
      ),
    [project.id, project.document.token.address, wallet.address],
  );
  const context = {
    wallet: wallet.address,
    mint: project.document.token.address,
    tokenDecimals: project.document.token.decimals,
    side: 'Sell' as const,
    requestedRaw: '1',
  };
  async function read() {
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setReport(null);
    setError('');
    try {
      const response = await fetch('/api/imported-projects/balance', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          id: project.id,
          revision: project.revision,
          wallet: wallet.address,
          walletRevision: wallet.revision,
          side: 'Sell',
          amount: formatNativeBalance('1', project.document.token.decimals),
        }),
      });
      const data = (await response.json()) as {
        id?: string;
        revision?: number;
        walletRevision?: number;
        report?: unknown;
        error?: string;
      };
      if (!response.ok)
        throw new Error(data.error || 'Fresh sell balance unavailable.');
      if (
        data.id !== project.id ||
        data.revision !== project.revision ||
        data.walletRevision !== wallet.revision
      )
        throw new Error(
          'Project or wallet revision differs. Reload trade wallets.',
        );
      const observed = validatedImportedBalance(data.report, context);
      if (!controller.signal.aborted) {
        setReport(observed);
        setTradeNotice('');
      }
    } catch (error) {
      if (!controller.signal.aborted)
        setError(
          error instanceof Error
            ? error.message
            : 'Fresh sell balance unavailable.',
        );
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  return (
    <section
      aria-label={`Sell amount review for ${wallet.address}`}
      className="imported-wallet-sell-review"
    >
      <h5>Sell percentages for {wallet.label || wallet.address}</h5>
      <p>
        Check fresh token inventory before selecting an amount. This read uses
        the provider; 15 seconds are required between wallet reads.
      </p>
      <Button
        variant="outline"
        disabled={locked || busy}
        onClick={() => void read()}
      >
        {busy ? 'Checking sell amounts…' : 'Check sell percentages'}
      </Button>
      {tradeNotice && <output>{tradeNotice}</output>}
      {error && <p role="alert">{error}</p>}
      {report && (
        <>
          <p>
            {report.unfrozenRaw} unfrozen / {report.frozenRaw} frozen atomic
            units. {report.source} · {report.observedAt}.{' '}
            {report.preparationSupported
              ? 'Supported inventory observed.'
              : 'Inventory extensions block preparation.'}
          </p>
          <ImportedSellPresets
            supply={{
              mint: project.document.token.address,
              decimals: project.document.token.decimals,
              totalSupplyRaw: project.document.token.totalSupplyRaw,
              observedAt: project.document.token.observedAt,
            }}
            report={report}
            context={context}
            locked={locked || busy}
            onAmountChange={onReview}
          />
        </>
      )}
    </section>
  );
}
