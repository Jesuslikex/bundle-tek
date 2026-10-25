import { nativeUnits, warmupAtoms, warmupDecimal } from './wallet-warmup';

/**
 * Wallet warmup, readiness mode.
 *
 * This replaces the "generate activity" framing with something the app can
 * actually verify: whether each wallet you own holds enough native currency for
 * the fees and rent a first transaction needs.
 *
 * There is deliberately no volume or activity generator here. Proxima's
 * "Alternative Routing" control, captured in
 * `REA/targets/proxima-20261009`, routes loops through a named platform to
 * "give the impression of trading platform usage"; that is fabrication aimed at
 * third parties, so Bundle does not implement it.
 *
 * Every number below is either observed from the existing read-only wallet
 * endpoint or a documented protocol constant. Nothing is inferred about wallet
 * age, independence or organic activity.
 */

/**
 * Rent-exempt minimum for a 165-byte SPL token account, in lamports. This is the
 * standard associated-token-account size and the value
 * `getMinimumBalanceForRentExemption(165)` returns on mainnet.
 */
export const WARMUP_TOKEN_ACCOUNT_RENT_LAMPORTS = 2_039_280n;

export const WARMUP_READINESS_DISCLOSURES = [
  'All selected wallets are controlled by you and appear on-chain as one operator.',
  'This check only reads public balances. It never signs, sends or schedules a transaction.',
  'Funding a wallet does not make it independent, aged or organic, and anyone can see the wallets share a funder.',
] as const;

export type WarmupReadinessStatus = 'ready' | 'needs-funding' | 'unknown';

export type WarmupReadinessWallet = {
  address: string;
  status: WarmupReadinessStatus;
  /** Observed native balance, or null when the read failed. */
  balance: string | null;
  required: string;
  /** Amount still needed; null unless `status` is `needs-funding`. */
  shortfall: string | null;
};

export type WarmupReadiness = {
  chain: string;
  currency: string;
  perWalletRequired: string;
  breakdown: {
    feeReserve: string;
    tokenAccountRent: string;
  };
  wallets: WarmupReadinessWallet[];
  readyCount: number;
  fundingCount: number;
  unknownCount: number;
  /** Sum of every known shortfall; unknown balances are not counted as zero. */
  totalShortfall: string;
  disclosures: typeof WARMUP_READINESS_DISCLOSURES;
  /** Structural guarantee: this mode has no activity/volume generator. */
  volumeGeneration: false;
  writesTransactions: false;
};

export class WarmupReadinessInputError extends Error {
  constructor(
    readonly field: 'wallets' | 'feeReserve',
    message: string,
  ) {
    super(message);
    this.name = 'WarmupReadinessInputError';
  }
}

/**
 * Assess readiness from balances that were already observed.
 *
 * `nativeBalance: null` means the read for that wallet failed. It is reported as
 * `unknown` and excluded from both the ready and funding totals, so a failed
 * read can never look like verified readiness.
 */
export function assessWarmupReadiness(input: {
  chain: string;
  feeReserve: string;
  /** Charge first-token-account rent. Defaults to true on Solana. */
  chargeTokenAccountRent?: boolean;
  balances: Array<{ address: string; nativeBalance: string | null }>;
}): WarmupReadiness {
  const unit = nativeUnits(input.chain);
  if (
    !Array.isArray(input.balances) ||
    input.balances.length < 1 ||
    input.balances.some(
      (w) =>
        !w ||
        typeof w.address !== 'string' ||
        (w.nativeBalance !== null && typeof w.nativeBalance !== 'string'),
    ) ||
    new Set(input.balances.map((w) => w.address)).size !== input.balances.length
  )
    throw new WarmupReadinessInputError(
      'wallets',
      'Check 1 or more distinct wallets at a time.',
    );
  let reserve: bigint;
  try {
    reserve = warmupAtoms(input.feeReserve, unit.decimals, true);
  } catch {
    throw new WarmupReadinessInputError(
      'feeReserve',
      `Enter a plain fee reserve in ${unit.symbol} with at most ${unit.decimals} decimal places.`,
    );
  }
  const chargeRent =
    input.chain === 'Solana' && (input.chargeTokenAccountRent ?? true);
  const rent = chargeRent ? WARMUP_TOKEN_ACCOUNT_RENT_LAMPORTS : 0n;
  const requiredAtoms = reserve + rent;
  let shortfallAtoms = 0n;

  const wallets = input.balances.map((wallet) => {
    let atoms: bigint | null = null;
    if (wallet.nativeBalance !== null) {
      try {
        atoms = warmupAtoms(wallet.nativeBalance, unit.decimals, true);
      } catch {
        // A balance the endpoint already validated should parse. Treat anything
        // else as an unknown read rather than inventing a number.
        atoms = null;
      }
    }
    const shortfall = atoms === null ? null : requiredAtoms - atoms;
    if (shortfall !== null && shortfall > 0n) shortfallAtoms += shortfall;
    return {
      address: wallet.address,
      status:
        atoms === null
          ? ('unknown' as const)
          : atoms >= requiredAtoms
            ? ('ready' as const)
            : ('needs-funding' as const),
      balance: atoms === null ? null : warmupDecimal(atoms, unit.decimals),
      required: warmupDecimal(requiredAtoms, unit.decimals),
      shortfall:
        shortfall !== null && shortfall > 0n
          ? warmupDecimal(shortfall, unit.decimals)
          : null,
    };
  });

  return {
    chain: input.chain,
    currency: unit.symbol,
    perWalletRequired: warmupDecimal(requiredAtoms, unit.decimals),
    breakdown: {
      feeReserve: warmupDecimal(reserve, unit.decimals),
      tokenAccountRent: warmupDecimal(rent, unit.decimals),
    },
    wallets,
    readyCount: wallets.filter((w) => w.status === 'ready').length,
    fundingCount: wallets.filter((w) => w.status === 'needs-funding').length,
    unknownCount: wallets.filter((w) => w.status === 'unknown').length,
    totalShortfall: warmupDecimal(shortfallAtoms, unit.decimals),
    disclosures: WARMUP_READINESS_DISCLOSURES,
    volumeGeneration: false,
    writesTransactions: false,
  };
}
