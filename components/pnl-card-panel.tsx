'use client';
import { useRef, useState } from 'react';
import { Button } from './ui/button';
import { formatReturn, pnlCard } from '@/lib/pnl-card';
import type { ImportedPerformance } from '@/lib/imported-performance-format';

const W = 600,
  H = 315;

export function PnlCardPanel({
  performance,
  symbol,
}: {
  performance: ImportedPerformance;
  symbol: string;
}) {
  const svg = useRef<SVGSVGElement>(null);
  const [error, setError] = useState('');
  const card = pnlCard(performance, symbol);
  if (!card) return null;
  const accent = card.positive ? '#16a34a' : '#dc2626';
  async function download() {
    setError('');
    try {
      const source = new XMLSerializer().serializeToString(svg.current!);
      const image = new Image();
      image.src =
        'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(source);
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = W * 2;
      canvas.height = H * 2;
      const context = canvas.getContext('2d')!;
      context.scale(2, 2);
      context.drawImage(image, 0, 0, W, H);
      const link = document.createElement('a');
      link.download = `${card!.symbol}-pnl.png`;
      link.href = canvas.toDataURL('image/png');
      link.click();
    } catch {
      setError('The card image could not be created in this browser.');
    }
  }
  return (
    <section aria-label="P&L card" className="min-w-0 space-y-2">
      <h4>P&amp;L card</h4>
      <svg
        ref={svg}
        xmlns="http://www.w3.org/2000/svg"
        viewBox={`0 0 ${W} ${H}`}
        className="w-full max-w-md"
        aria-labelledby="pnl-card-title"
      >
        <title id="pnl-card-title">{`${card.symbol} realized ${card.resultSol} SOL, ${formatReturn(card.returnBasisPoints)}`}</title>
        <rect width={W} height={H} rx={20} fill="#0b0f19" />
        <rect x={0} y={0} width={8} height={H} fill={accent} />
        <text
          x={40}
          y={60}
          fill="#e5e7eb"
          fontSize={28}
          fontFamily="sans-serif"
          fontWeight={700}
        >
          ${card.symbol}
        </text>
        <text
          x={40}
          y={140}
          fill={accent}
          fontSize={64}
          fontFamily="sans-serif"
          fontWeight={800}
        >
          {formatReturn(card.returnBasisPoints)}
        </text>
        <text
          x={40}
          y={190}
          fill="#e5e7eb"
          fontSize={26}
          fontFamily="sans-serif"
        >
          {card.resultSol} SOL realized
        </text>
        <text
          x={40}
          y={230}
          fill="#9ca3af"
          fontSize={18}
          fontFamily="sans-serif"
        >
          Cost {card.costSol} SOL · {card.buyCount} buys · {card.sellCount}{' '}
          sells
        </text>
        <text
          x={40}
          y={285}
          fill="#6b7280"
          fontSize={14}
          fontFamily="sans-serif"
        >
          Bundle · recorded FIFO estimate, fees included
        </text>
      </svg>
      <Button type="button" variant="outline" onClick={() => void download()}>
        Download card
      </Button>
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
