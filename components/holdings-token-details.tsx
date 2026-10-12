'use client';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import type { TokenHolding } from '@/lib/wallet-holdings';
import {
  holdingsTokenIdentity,
  type HoldingsTokenIdentity,
} from '@/lib/holdings-token-identity';
import { formatNativeBalance } from '@/lib/wallet-balance-format';

export function HoldingsTokenDetails({
  holding,
  onClose,
}: {
  holding: TokenHolding;
  onClose: () => void;
}) {
  const [reload, setReload] = useState(0);
  const [result, setResult] = useState<{
    revision: number;
    token: HoldingsTokenIdentity | null;
    error: string;
  } | null>(null);
  const heading = useRef<HTMLHeadingElement | null>(null);
  useEffect(() => {
    heading.current?.focus();
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(
          `/api/tokens/inspect?${new URLSearchParams({ chain: 'Solana', address: holding.mint })}`,
          {
            cache: 'no-store',
            signal: controller.signal,
          },
        );
        const data = (await response.json()) as {
          token?: unknown;
          error?: string;
        };
        if (!response.ok)
          throw new Error(data.error || 'Token details unavailable.');
        const token = holdingsTokenIdentity(data.token, holding);
        if (!controller.signal.aborted)
          setResult({ revision: reload, token, error: '' });
      } catch (error) {
        if (!controller.signal.aborted)
          setResult({
            revision: reload,
            token: null,
            error:
              error instanceof Error
                ? error.message
                : 'Token details unavailable.',
          });
      }
    })();
    return () => controller.abort();
  }, [holding, reload]);
  const current = result?.revision === reload ? result : null;
  return (
    <section
      className="wallet-holdings-panel"
      aria-label="Holding token details"
    >
      <div className="wallet-roster-toolbar">
        <h3 tabIndex={-1} ref={heading}>
          Token details
        </h3>
        <Button variant="outline" onClick={onClose}>
          Close token details
        </Button>
      </div>
      <p className="warmup-address">Mint: {holding.mint}</p>
      <p className="source-note">
        Identity is a separate read from the retained holdings snapshot. A name
        or symbol does not establish authenticity, price or transferability.
      </p>
      {!current ? (
        <output>Inspecting token identity…</output>
      ) : current.error ? (
        <p role="alert">{current.error}</p>
      ) : (
        current.token && (
          <>
            <strong>
              {current.token.name} ({current.token.symbol})
            </strong>
            <p>
              Mint supply:{' '}
              {formatNativeBalance(
                current.token.totalSupplyRaw,
                current.token.decimals,
              )}{' '}
              · {current.token.decimals} decimals
            </p>
            <p>Observed wallet balance: {holding.amount} tokens.</p>
            <p className="source-note">
              {current.token.metadataKind} identity · {current.token.source} ·{' '}
              confirmed slot {current.token.slot} ·{' '}
              {new Date(current.token.observedAt).toLocaleString()}
            </p>
            <details>
              <summary>Exact units and account restrictions</summary>
              <p className="warmup-address">Token program: {holding.program}</p>
              <p>Mint supply raw units: {current.token.totalSupplyRaw}</p>
              <p>Observed wallet raw units: {holding.raw}</p>
              <p>
                {holding.accounts.filter((account) => account.frozen).length}{' '}
                frozen accounts.{' '}
                {holding.accounts.some((account) => account.extensions)
                  ? 'Token extensions may restrict transfers.'
                  : 'Transferability has not been checked.'}
              </p>
            </details>
          </>
        )
      )}
      {current && (
        <Button
          variant="outline"
          onClick={() => setReload((value) => value + 1)}
        >
          Refresh token identity
        </Button>
      )}
    </section>
  );
}
