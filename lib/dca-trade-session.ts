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

/** Capture once for review; save and retries must retain this exact UTC start. */
export function dcaStartAfter(nowMs: number, delaySeconds: number): string {
  if (
    !Number.isSafeInteger(nowMs) ||
    !Number.isSafeInteger(delaySeconds) ||
    delaySeconds < 1 ||
    delaySeconds > 86400
  )
    throw new Error('Choose a start delay from 1 to 86400 whole seconds.');
  const timestamp = nowMs + delaySeconds * 1000;
  if (!Number.isSafeInteger(timestamp))
    throw new Error('DCA start exceeds the supported date range.');
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime()))
    throw new Error('DCA start exceeds the supported date range.');
  const startAt = date.toISOString();
  if (!/^20\d{2}-/.test(startAt))
    throw new Error('Choose a DCA start within the supported calendar range.');
  return startAt;
}

/** Convert an explicitly reviewed per-cycle input into the existing total budget. */
export function dcaPerCycleBudget(
  amount: string,
  decimals: number,
  cycles: number,
) {
  if (!Number.isInteger(cycles) || cycles < 2 || cycles > 25)
    throw new Error('Choose 2 to 25 DCA cycles.');
  const total = solanaTokenAtoms(amount, decimals) * BigInt(cycles);
  if (total > (1n << 64n) - 1n)
    throw new Error('Total DCA input exceeds the supported Solana amount.');
  return formatNativeBalance(total.toString(), decimals);
}

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
