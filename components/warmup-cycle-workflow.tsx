'use client';
import { useEffect, useRef, useState } from 'react';
import type { SavedWarmup } from '@/lib/wallet-warmup-storage';
import type { WarmupCycleProgress as Progress } from '@/lib/warmup-cycle-progress';
import { WarmupCycleProgress } from './warmup-cycle-progress';
import { WalletWarmupPreparation } from './wallet-warmup-preparation';

export function WarmupCycleWorkflow({
  plan,
  canReview,
}: {
  plan: SavedWarmup;
  canReview: boolean;
}) {
  const [selection, setSelection] = useState<{
    cycle: number;
    wallet: string;
    side: 'Buy' | 'Sell';
    request: number;
  } | null>(null);
  const destination = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (selection) destination.current?.focus();
  }, [selection]);
  const enabled =
    canReview && !plan.archived && plan.document.chain === 'Solana';
  function review(step: Progress['steps'][number]) {
    if (
      !enabled ||
      step.recoveryCount > 0 ||
      !['Not bought', 'Tokens remaining'].includes(step.state) ||
      !Number.isInteger(step.cycle) ||
      step.cycle < 1 ||
      step.cycle > plan.document.cycles ||
      !plan.document.addresses.includes(step.wallet) ||
      step.mint !==
        plan.document.tokens[(step.cycle - 1) % plan.document.tokens.length]
    )
      return;
    setSelection((prior) => ({
      cycle: step.cycle,
      wallet: step.wallet,
      side: step.state === 'Not bought' ? 'Buy' : 'Sell',
      request: (prior?.request ?? 0) + 1,
    }));
  }
  return (
    <>
      <WarmupCycleProgress
        plan={plan}
        onReview={enabled ? review : undefined}
      />
      {enabled && (
        <div
          ref={destination}
          tabIndex={-1}
          aria-label="Selected warmup transaction review"
        >
          {selection && (
            <output>
              Review {selection.side.toLowerCase()} for cycle {selection.cycle},
              wallet {selection.wallet}.
              {selection.side === 'Sell' &&
                ' Select a matching finalized buy lot below. Earlier revisions require the sell form’s explicit opt-in.'}
            </output>
          )}
          <WalletWarmupPreparation
            key={
              selection
                ? `${selection.cycle}:${selection.wallet}:${selection.side}:${selection.request}`
                : 'default'
            }
            plan={plan}
            initialCycle={selection?.cycle}
            initialWallet={selection?.wallet}
            initialSide={selection?.side}
          />
        </div>
      )}
    </>
  );
}
