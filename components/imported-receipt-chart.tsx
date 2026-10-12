'use client';
import { useEffect, useRef, useState } from 'react';
import type { ImportedSwapReceipt } from '@/lib/imported-approval-history';
import { finalizedReceiptChartTarget } from '@/lib/imported-chart-workspace';
export function ImportedReceiptChart({
  receipt,
  autoOpen = false,
}: {
  receipt: ImportedSwapReceipt;
  autoOpen?: boolean;
}) {
  const targetId = finalizedReceiptChartTarget(receipt);
  const opened = useRef('');
  const [error, setError] = useState('');
  const mint = receipt.document.mint;
  useEffect(() => {
    if (!autoOpen || !targetId || opened.current === receipt.id) return;
    const frame = requestAnimationFrame(() => {
      const target = document.getElementById(targetId);
      if (
        !target ||
        target.dataset.tokenMint !== mint ||
        target.dataset.tokenChain !== 'Solana'
      )
        return;
      opened.current = receipt.id;
      target.scrollIntoView({ block: 'start', behavior: 'smooth' });
      target.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [autoOpen, targetId, receipt.id, mint]);
  if (!targetId) return null;
  return (
    <div className="imported-receipt-chart">
      <a
        href={`#${targetId}`}
        onClick={(event) => {
          event.preventDefault();
          const target = document.getElementById(targetId);
          if (
            !target ||
            target.dataset.tokenMint !== mint ||
            target.dataset.tokenChain !== 'Solana'
          ) {
            setError(
              'Open the matching imported token project to view its chart.',
            );
            return;
          }
          setError('');
          target.scrollIntoView({ block: 'start', behavior: 'smooth' });
          target.focus({ preventScroll: true });
        }}
      >
        Open chart, supply and wallet alerts
      </a>
      {error && <output>{error}</output>}
    </div>
  );
}
