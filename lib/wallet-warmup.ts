import { walletAddress, walletChain } from './wallet-workspace';
import { EVM_NETWORKS, evmChain } from './evm-network';
import {
  WARMUP_MAX_WALLETS,
  WARMUP_MAX_CYCLES,
} from './warmup-history-capacity';

export type WarmupInput = {
  chain: string;
  addresses: string[];
  tokens: string[];
  amount: string;
  feeReserve: string;
  cycles: number;
  intervalMinutes: number;
  startAt: string;
};
export type WarmupPlanField =
  | 'tokens'
  | 'amount'
  | 'feeReserve'
  | 'cycles'
  | 'intervalMinutes'
  | 'startAt';
export class WarmupPlanInputError extends Error {
  constructor(
    readonly field: WarmupPlanField,
    message: string,
  ) {
    super(message);
    this.name = 'WarmupPlanInputError';
  }
}
function validateField<T>(field: WarmupPlanField, validate: () => T): T {
  try {
    return validate();
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    throw new WarmupPlanInputError(field, error.message);
  }
}
export function nativeUnits(chain: string) {
  return chain === 'Solana'
    ? { symbol: 'SOL', decimals: 9 }
    : { symbol: EVM_NETWORKS[evmChain(chain)].currency, decimals: 18 };
}
export function warmupAtoms(
  value: unknown,
  decimals: number,
  allowZero = false,
) {
  if (typeof value !== 'string' || !/^\d{1,12}(?:\.\d{1,18})?$/.test(value))
    throw new Error('Enter a plain decimal amount.');
  const [whole, fraction = ''] = value.split('.');
  if (fraction.length > decimals)
    throw new Error(`Use at most ${decimals} decimal places.`);
  const result =
    BigInt(whole) * 10n ** BigInt(decimals) +
    BigInt(fraction.padEnd(decimals, '0'));
  if (!allowZero && result === 0n)
    throw new Error('Swap amount and fee reserve must be positive.');
  return result;
}
export function warmupDecimal(value: bigint, decimals: number) {
  const s = value.toString().padStart(decimals + 1, '0');
  const fraction = s.slice(-decimals).replace(/0+$/, '');
  return s.slice(0, -decimals) + (fraction ? '.' + fraction : '');
}
export function buildWarmupPlan(input: WarmupInput, now = Date.now()) {
  const chain = walletChain(input.chain),
    unit = nativeUnits(chain);
  if (
    !Array.isArray(input.addresses) ||
    !input.addresses.length ||
    input.addresses.length > WARMUP_MAX_WALLETS
  )
    throw new Error('Select between 1 and 20 active wallets.');
  const addresses = input.addresses.map((a) => walletAddress(a, chain));
  if (new Set(addresses).size !== addresses.length)
    throw new Error('Remove duplicate wallets.');
  if (
    !Array.isArray(input.tokens) ||
    !input.tokens.length ||
    input.tokens.length > 10
  )
    throw new WarmupPlanInputError(
      'tokens',
      'Enter between 1 and 10 token addresses.',
    );
  const tokens = validateField('tokens', () =>
    input.tokens.map((a) => walletAddress(a, chain)),
  );
  if (
    new Set(tokens).size !== tokens.length ||
    tokens.some((t) => addresses.includes(t))
  )
    throw new WarmupPlanInputError(
      'tokens',
      'Use distinct token addresses, separate from wallet addresses.',
    );
  if (
    !Number.isSafeInteger(input.cycles) ||
    input.cycles < 1 ||
    input.cycles > WARMUP_MAX_CYCLES
  )
    throw new WarmupPlanInputError(
      'cycles',
      'Choose 1 to 20 buy/sell cycles per wallet.',
    );
  if (
    !Number.isSafeInteger(input.intervalMinutes) ||
    input.intervalMinutes < 15 ||
    input.intervalMinutes > 10080
  )
    throw new WarmupPlanInputError(
      'intervalMinutes',
      'Choose 15 minutes to 7 days between cycles.',
    );
  const start = Date.parse(input.startAt);
  if (!Number.isFinite(start) || start < now || start > now + 30 * 86400000)
    throw new WarmupPlanInputError(
      'startAt',
      'Choose a start within the next 30 days.',
    );
  const amount = validateField('amount', () =>
      warmupAtoms(input.amount, unit.decimals),
    ),
    reserve = validateField('feeReserve', () =>
      warmupAtoms(input.feeReserve, unit.decimals),
    );
  const interval = input.intervalMinutes * 60000;
  const actions = addresses
    .flatMap((address, walletIndex) =>
      Array.from({ length: input.cycles }, (_, cycle) => {
        const token = tokens[cycle % tokens.length];
        // Fixed, disclosed staggering keeps review reproducible. No fake organic activity.
        const buyAt =
          start +
          cycle * interval +
          Math.floor((walletIndex * interval) / (addresses.length * 4));
        return [
          {
            address,
            token,
            cycle: cycle + 1,
            side: 'Buy' as const,
            amount: warmupDecimal(amount, unit.decimals),
            scheduledAt: new Date(buyAt).toISOString(),
          },
          {
            address,
            token,
            cycle: cycle + 1,
            side: 'Sell' as const,
            amount: '100% of tokens acquired in this cycle',
            scheduledAt: new Date(buyAt + interval / 2).toISOString(),
          },
        ];
      }).flat(),
    )
    .sort(
      (a, b) =>
        a.scheduledAt.localeCompare(b.scheduledAt) ||
        a.address.localeCompare(b.address),
    );
  const perWallet = amount * BigInt(input.cycles) + reserve;
  return {
    format: 'pulseforge-warmup-plan-v1' as const,
    executionAllowed: false as const,
    chain,
    currency: unit.symbol,
    addresses,
    tokens,
    cycles: input.cycles,
    intervalMinutes: input.intervalMinutes,
    startAt: new Date(start).toISOString(),
    buyAmount: warmupDecimal(amount, unit.decimals),
    feeReserve: warmupDecimal(reserve, unit.decimals),
    buyBudgetPerWallet: warmupDecimal(
      amount * BigInt(input.cycles),
      unit.decimals,
    ),
    requiredPerWallet: warmupDecimal(perWallet, unit.decimals),
    totalBudget: warmupDecimal(
      perWallet * BigInt(addresses.length),
      unit.decimals,
    ),
    actions,
    createdAt: new Date(now).toISOString(),
    limitations:
      'Review plan only. No scheduler, quote, token verification or signing. Sell proceeds are not reused in the budget. Fees and sell output are unknown; the reserve is user-chosen. Activity does not prove wallet creation age or launch eligibility.',
  };
}
export type WarmupPlan = ReturnType<typeof buildWarmupPlan>;
export type WarmupHistory = {
  address: string;
  chain: string;
  observedAt: string;
  source: string;
  nativeBalance: string;
  currency: string;
  block: string;
  blockHash?: string;
  outgoingTransactions: string | null;
  sampleCount: number | null;
  successfulSampleCount: number | null;
  oldestObservedAt: string | null;
  latestObservedAt: string | null;
  coverage: string;
};
