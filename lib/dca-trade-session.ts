import {
  tradeSessionTerms,
  type TradeSessionTerms,
} from './imported-trade-session';
import { solanaTokenAtoms } from './solana-token-amount';
import { formatNativeBalance } from './wallet-balance-format';

export function dcaTradeSessionInput(
  input: {
    projectId: string;
    projectRevision: number;
    side: 'Buy' | 'Sell';
    wallet: string;
    walletRevision: number;
    totalAmount: string;
    cycles: number;
    startAt: string;
    intervalSeconds: number;
  },
  token: { chain: string; address: string; decimals: number },
): {
  request: {
    action: 'create';
    projectId: string;
    projectRevision: number;
    side: 'Buy' | 'Sell';
    strategy: 'DCA';
    schedule: { startAt: string; spacingSeconds: number };
    entries: { wallet: string; walletRevision: number; amount: string }[];
  };
  terms: TradeSessionTerms;
} {
  if (!Number.isInteger(input.cycles) || input.cycles < 2 || input.cycles > 25)
    throw new Error('Choose 2 to 25 DCA cycles.');
  const decimals = input.side === 'Buy' ? 9 : token.decimals;
  const total = solanaTokenAtoms(input.totalAmount, decimals),
    count = BigInt(input.cycles);
  if (total < count)
    throw new Error('Each DCA cycle needs at least one input atom.');
  const request = {
    action: 'create' as const,
    projectId: input.projectId,
    projectRevision: input.projectRevision,
    side: input.side,
    strategy: 'DCA' as const,
    schedule: { startAt: input.startAt, spacingSeconds: input.intervalSeconds },
    entries: Array.from({ length: input.cycles }, (_, i) => ({
      wallet: input.wallet,
      walletRevision: input.walletRevision,
      amount: formatNativeBalance(
        (total / count + (BigInt(i) < total % count ? 1n : 0n)).toString(),
        decimals,
      ),
    })),
  };
  return { request, terms: tradeSessionTerms(request, token) };
}
