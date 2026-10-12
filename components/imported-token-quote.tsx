'use client';
import { useEffect, useId, useRef, useState } from 'react';
import { subscribeImportedReceiptSaved } from '@/lib/imported-receipt-events';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { ImportedTokenProject } from '@/lib/imported-token-project';
import type { SolanaSwapQuote } from '@/lib/warmup-swap-quote';
import { warmupAtoms } from '@/lib/wallet-warmup';
import { solanaTokenAtoms } from '@/lib/solana-token-amount';
import { ImportedSwapWallet } from './imported-swap-wallet';
import type { ImportedSwapReceipt } from '@/lib/imported-approval-history';
import {
  currentImportedSellHandoff,
  type ImportedSellHandoff,
} from '@/lib/imported-sell-handoff';
export function ImportedTokenQuote({
  project,
  onSaved,
  handoff,
  onReviewBuy,
}: {
  project: ImportedTokenProject;
  onSaved: (project: ImportedTokenProject) => void;
  handoff?: ImportedSellHandoff;
  onReviewBuy?: (receipt: ImportedSwapReceipt) => void;
}) {
  const label = useId();
  const reviewHeading = useRef<HTMLHeadingElement | null>(null);
  const selectedHandoff = handoff
    ? currentImportedSellHandoff(handoff, project)
    : undefined;
  const [amount, setAmount] = useState(
    selectedHandoff?.amount ?? project.document.tradeSettings?.amount ?? '0.01',
  );
  const [side, setSide] = useState<'Buy' | 'Sell'>(
    selectedHandoff?.side ?? project.document.tradeSettings?.side ?? 'Buy',
  );
  const [savingSettings, setSavingSettings] = useState(false);
  const [quote, setQuote] = useState<SolanaSwapQuote | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [expired, setExpired] = useState(false);
  const pending = useRef<AbortController | null>(null);
  const [tradeNotice, setTradeNotice] = useState('');
  useEffect(
    () =>
      subscribeImportedReceiptSaved(
        { projectId: project.id, mint: project.document.token.address },
        () => {
          pending.current?.abort();
          setQuote(null);
          setBusy(false);
          setExpired(false);
          setTradeNotice(
            'A trade finalized for this token. Request a fresh quote and refresh the wallet balance before your next trade.',
          );
        },
      ),
    [project.id, project.document.token.address],
  );
  useEffect(() => () => pending.current?.abort(), []);
  useEffect(() => {
    if (!quote) return;
    const timer = setTimeout(
      () => setExpired(true),
      Math.max(0, Date.parse(quote.expiresAt) - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [quote]);
  async function inspect() {
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setQuote(null);
    setError('');
    setExpired(false);
    try {
      const expected = (
        side === 'Buy'
          ? warmupAtoms(amount, 9)
          : solanaTokenAtoms(amount, project.document.token.decimals)
      ).toString();
      const response = await fetch('/api/imported-projects/quote', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          id: project.id,
          revision: project.revision,
          amount,
          side,
        }),
      });
      const data = (await response.json()) as {
        id?: string;
        revision?: number;
        quote?: SolanaSwapQuote;
        error?: string;
      };
      if (!response.ok)
        throw new Error(data.error || 'Swap quote unavailable.');
      if (
        data.id !== project.id ||
        data.revision !== project.revision ||
        data.quote?.executionAllowed !== false ||
        data.quote.side !== side ||
        data.quote.inputMint !==
          (side === 'Buy'
            ? 'So11111111111111111111111111111111111111112'
            : project.document.token.address) ||
        data.quote.outputMint !==
          (side === 'Buy'
            ? project.document.token.address
            : 'So11111111111111111111111111111111111111112') ||
        data.quote.inAmount !== expected ||
        !Number.isFinite(Date.parse(data.quote.expiresAt)) ||
        Date.parse(data.quote.expiresAt) <= Date.now()
      )
        throw new Error(
          'Quote does not match the current swap. Request a fresh quote.',
        );
      if (!controller.signal.aborted) {
        setQuote(data.quote);
        setTradeNotice('');
      }
    } catch (e) {
      if (!controller.signal.aborted)
        setError(e instanceof Error ? e.message : 'Buy quote unavailable.');
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  if (project.archived) return null;
  return (
    <section aria-label="Imported token swap quote">
      <h3 ref={reviewHeading} tabIndex={-1}>
        Buy / sell quote
      </h3>
      {tradeNotice && <output>{tradeNotice}</output>}
      {project.document.token.chain !== 'Solana' ? (
        <p>Swap quotes for this network are not integrated yet.</p>
      ) : (
        <>
          <p>
            Review a buy or sell quote for this saved mint. This does not place
            an order.
          </p>
          {selectedHandoff && (
            <p className="warmup-address">
              Selected finalized buy receipt {selectedHandoff.receiptId} from
              project revision {selectedHandoff.sourceProjectRevision}. Its{' '}
              {selectedHandoff.tokenUnitsRaw} acquired atomic units were copied
              for sell review. Current holdings and transferability must be
              checked again. Review recorded acquisitions below to see remaining
              accounting capacity before preparation.
            </p>
          )}
          <label>
            Quote direction{' '}
            <select
              aria-label="Quote direction"
              value={side}
              disabled={savingSettings}
              onChange={(e) => {
                pending.current?.abort();
                setSide(e.target.value as 'Buy' | 'Sell');
                setAmount(e.target.value === 'Buy' ? '0.01' : '1');
                setQuote(null);
                setError('');
                setBusy(false);
                setExpired(false);
              }}
            >
              <option>Buy</option>
              <option>Sell</option>
            </select>
          </label>
          <label htmlFor={label}>
            {side === 'Buy'
              ? 'Buy amount (SOL)'
              : `Sell amount (${project.document.token.symbol})`}
          </label>
          {side === 'Sell' && (
            <p>
              Enter token units using {project.document.token.decimals}{' '}
              decimals. Review observed holdings below. Transferability remains
              unverified.
            </p>
          )}
          <Input
            id={label}
            inputMode="decimal"
            value={amount}
            disabled={savingSettings}
            onChange={(e) => {
              pending.current?.abort();
              setAmount(e.target.value);
              setQuote(null);
              setError('');
              setBusy(false);
              setExpired(false);
            }}
          />
          <Button
            variant="outline"
            disabled={busy || savingSettings}
            onClick={() => void inspect()}
          >
            {busy
              ? 'Quoting swap…'
              : side === 'Buy'
                ? 'Quote imported buy'
                : 'Quote imported sell'}
          </Button>
          {error && <p role="alert">{error}</p>}
          {quote && (
            <section aria-label="Imported swap quote result">
              <p>
                {expired
                  ? 'Expired. Request a fresh quote.'
                  : `Quote via ${quote.router} · 0.5% slippage`}
              </p>
              <p>
                Input: {quote.inAmount}{' '}
                {side === 'Buy' ? 'lamports' : 'token atomic units'}. Output:{' '}
                {quote.outAmount}{' '}
                {side === 'Buy' ? 'token atomic units' : 'lamports'}. Minimum
                output: {quote.minimumOutAmount}.
              </p>
              <p>
                {side === 'Buy' ? project.document.token.decimals : 9} output
                decimals · {quote.source} · observed{' '}
                {new Date(quote.observedAt).toLocaleString()} · expires{' '}
                {new Date(quote.expiresAt).toLocaleString()}
              </p>
              <p>{quote.limitations}</p>
            </section>
          )}
          <ImportedSwapWallet
            onWalletTradeReview={(direction, reviewedAmount) => {
              pending.current?.abort();
              if (reviewedAmount !== undefined) setAmount(reviewedAmount);
              else if (direction !== side)
                setAmount(direction === 'Buy' ? '0.01' : '1');
              setSide(direction);
              reviewHeading.current?.focus({ preventScroll: true });
              reviewHeading.current?.scrollIntoView({
                block: 'start',
                behavior: 'instant',
              });
              setQuote(null);
              setError('');
              setBusy(false);
              setExpired(false);
            }}
            onAmountChange={(value) => {
              pending.current?.abort();
              setAmount(value);
              setQuote(null);
              setError('');
              setBusy(false);
              setExpired(false);
            }}
            project={project}
            side={side}
            amount={amount}
            locked={busy}
            onSaved={onSaved}
            onSavingChange={setSavingSettings}
            handoff={selectedHandoff}
            onReviewBuy={onReviewBuy}
          />
        </>
      )}
    </section>
  );
}
