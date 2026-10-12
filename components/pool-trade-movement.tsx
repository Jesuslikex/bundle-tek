'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  requirePoolTradeMovement,
  type PoolTradeMovement,
  type PoolTradeMovementContext,
} from '@/lib/pool-trade-movement';
import { WalletMovementLabel } from './wallet-movement-label';
import { Button } from './ui/button';
export function PoolTradeMovementPanel({
  context,
  onClose,
}: {
  context: PoolTradeMovementContext;
  onClose: () => void;
}) {
  const [result, setResult] = useState<PoolTradeMovement | null>(null),
    [busy, setBusy] = useState(true),
    [error, setError] = useState('');
  const pending = useRef<AbortController | null>(null),
    heading = useRef<HTMLHeadingElement | null>(null);
  const read = useCallback(
    async (controller: AbortController) => {
      try {
        const response = await fetch('/api/imported-projects/trade-movement', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            id: context.projectId,
            revision: context.revision,
            pool: context.pool,
            tradeId: context.trade.id,
            tapeObservedAt: context.tapeObservedAt,
          }),
          signal: AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(22000),
          ]),
        });
        const data = (await response.json()) as {
          result?: PoolTradeMovement;
          error?: string;
        };
        if (!response.ok || !data.result)
          throw new Error(
            data.error || 'On-chain movement inspection unavailable.',
          );
        const checked = requirePoolTradeMovement(data.result, context);
        if (!controller.signal.aborted) setResult(checked);
      } catch (e) {
        if (!controller.signal.aborted)
          setError(e instanceof Error ? e.message : 'Inspection unavailable.');
      } finally {
        if (!controller.signal.aborted) setBusy(false);
      }
    },
    [context],
  );
  useEffect(() => {
    const controller = new AbortController();
    pending.current = controller;
    heading.current?.focus();
    const timer = setTimeout(() => void read(controller), 0);
    return () => {
      clearTimeout(timer);
      pending.current?.abort();
    };
  }, [read]);
  return (
    <section
      aria-label="On-chain pool trade movement"
      className="min-w-0 space-y-2 rounded-md border p-3 break-words"
    >
      <h4 tabIndex={-1} ref={heading}>
        On-chain wallet movement
      </h4>
      <Button variant="outline" onClick={onClose}>
        Close movement check
      </Button>
      <p>
        Provider label: {context.trade.side}. Sender{' '}
        <code>{context.trade.sender}</code>.{' '}
        <a
          href={`https://solscan.io/tx/${context.trade.transaction}`}
          target="_blank"
          rel="noopener noreferrer"
        >
          Open transaction
        </a>
        .
      </p>
      <p>
        Reads this one retained public transaction. This does not connect its
        wallet, prove ownership or authorize a trade.
      </p>
      {busy && <output>Reading confirmed chain evidence…</output>}
      {error && <p role="alert">{error}</p>}
      {result && (
        <>
          {result.tokenChange ? (
            <WalletMovementLabel
              classification={result.classification}
              changeRaw={result.tokenChange.changeRaw}
              decimals={result.tokenChange.decimals}
            />
          ) : (
            <p>
              Unknown: {result.classification.reason} No complete mint change is
              available.
            </p>
          )}
          <p>
            {result.failed
              ? 'The transaction failed.'
              : 'The transaction succeeded.'}{' '}
            {result.walletSigner
              ? 'The reported wallet signed it.'
              : 'The reported wallet did not sign it.'}{' '}
            Confirmed slot {result.slot}; {result.source}, observed{' '}
            {new Date(result.observedAt).toLocaleString()}.
          </p>
          <p>
            {result.sideAgrees === true
              ? 'The decoded mint movement agrees with the provider’s direction.'
              : result.sideAgrees === false
                ? 'The decoded mint movement disagrees with the provider’s direction. Use the chain evidence; the provider label remains separate.'
                : 'The provider’s buy/sell direction could not be independently established.'}
          </p>
          {!result.blockAgrees && (
            <p>
              Provider block {result.providerBlock} differs from chain slot{' '}
              {result.slot}.
            </p>
          )}
          <p>
            Confirmed evidence can change before finalization. This check
            describes the wallet’s mint change across the transaction; it does
            not prove that every leg used the selected pool or establish profit.
          </p>
        </>
      )}
      <Button
        variant="outline"
        disabled={busy}
        onClick={() => {
          pending.current?.abort();
          const controller = new AbortController();
          pending.current = controller;
          setBusy(true);
          setError('');
          void read(controller);
        }}
      >
        Refresh chain check
      </Button>
    </section>
  );
}
