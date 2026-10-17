import type { ImportedPerformance } from './imported-performance-format';
import {
  signedBalanceAmount,
  formatNativeBalance,
} from './wallet-balance-format';

// A shareable P&L card built only from the recorded FIFO estimate.
// No card exists when the realized estimate is incomplete.
export type PnlCard = {
  symbol: string;
  resultSol: string;
  costSol: string;
  // Basis points of realized cost, null when there was no realized cost.
  returnBasisPoints: number | null;
  positive: boolean;
  buyCount: number;
  sellCount: number;
};

export function pnlCard(
  p: ImportedPerformance,
  symbol: string,
): PnlCard | null {
  if (p.realizedResultLamports === null || p.sellCount === 0) return null;
  const result = BigInt(p.realizedResultLamports);
  const cost = BigInt(p.realizedCostLamports);
  return {
    symbol: symbol.slice(0, 16),
    resultSol: signedBalanceAmount(p.realizedResultLamports, 9),
    costSol: formatNativeBalance(p.realizedCostLamports, 9),
    returnBasisPoints: cost > 0n ? Number((result * 10000n) / cost) : null,
    positive: result >= 0n,
    buyCount: p.buyCount,
    sellCount: p.sellCount,
  };
}

export const formatReturn = (bps: number | null) =>
  bps === null ? '—' : `${bps >= 0 ? '+' : ''}${(bps / 100).toFixed(2)}%`;
