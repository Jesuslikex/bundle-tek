import {
  tradeSessionTerms,
  type TradeSessionTerms,
} from './imported-trade-session';
import { solanaTokenAtoms } from './solana-token-amount';
import { formatNativeBalance } from './wallet-balance-format';
import { dcaMarketCapRange, type DcaMarketCapRange } from './dca-market-cap';
import {
  dcaRandomization,
  validateRandomDcaAllocation,
  type DcaRandomization,
} from './dca-random-allocation';
import type { DcaSupplySizing, DcaSupplyToken } from './dca-supply-sizing';

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
    endsAt?: string;
    durationSeconds?: number;
    marketCapRange?: DcaMarketCapRange;
    randomization?: DcaRandomization;
    cycleAmountsRaw?: string[];
    supplySizing?: DcaSupplySizing;
  },
  token: DcaSupplyToken,
): {
  request: {
    action: 'create';
    projectId: string;
    projectRevision: number;
    side: 'Buy' | 'Sell';
    strategy: 'DCA';
    endsAt?: string;
    marketCapRange?: DcaMarketCapRange;
    randomization?: DcaRandomization;
    supplySizing?: DcaSupplySizing;
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
  let endsAt = input.endsAt;
  if (input.durationSeconds !== undefined) {
    if (endsAt !== undefined)
      throw new Error(
        'Choose a DCA duration or a calendar deadline, not both.',
      );
    if (
      !Number.isSafeInteger(input.durationSeconds) ||
      input.durationSeconds <= 0
    )
      throw new Error(
        'DCA duration must be a positive whole number of seconds.',
      );
    const endTime = Date.parse(input.startAt) + input.durationSeconds * 1000;
    if (
      !Number.isSafeInteger(endTime) ||
      !Number.isFinite(new Date(endTime).getTime())
    )
      throw new Error('DCA duration exceeds the supported date range.');
    endsAt = new Date(endTime).toISOString();
  }
  const randomization =
    input.randomization === undefined
      ? undefined
      : dcaRandomization(input.randomization);
  if (!randomization && input.cycleAmountsRaw !== undefined)
    throw new Error('Choose randomized sizing before reviewing an allocation.');
  const randomized = randomization
    ? validateRandomDcaAllocation(
        total.toString(),
        input.cycles,
        randomization,
        input.cycleAmountsRaw,
      )
    : undefined;
  const request = {
    action: 'create' as const,
    projectId: input.projectId,
    projectRevision: input.projectRevision,
    side: input.side,
    strategy: 'DCA' as const,
    ...(randomization ? { randomization } : {}),
    ...(input.supplySizing ? { supplySizing: input.supplySizing } : {}),
    ...(endsAt === undefined ? {} : { endsAt }),
    ...(input.marketCapRange === undefined
      ? {}
      : { marketCapRange: dcaMarketCapRange(input.marketCapRange) }),
    schedule: { startAt: input.startAt, spacingSeconds: input.intervalSeconds },
    entries: Array.from({ length: input.cycles }, (_, i) => ({
      wallet: input.wallet,
      walletRevision: input.walletRevision,
      amount: formatNativeBalance(
        randomized?.[i] ??
          (total / count + (BigInt(i) < total % count ? 1n : 0n)).toString(),
        decimals,
      ),
    })),
  };
  return { request, terms: tradeSessionTerms(request, token) };
}
