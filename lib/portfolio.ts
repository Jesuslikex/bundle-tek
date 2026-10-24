/**
 * Portfolio view: what the user's saved Solana wallets hold now, valued from
 * each imported token's latest saved market observation, combined with the
 * recorded realized result. Unrealized = current value minus the cost of buys
 * not yet matched to a sale. Display only; never used for trading.
 */
export const PORTFOLIO_MAX_PROJECTS = 20;
export const PORTFOLIO_MAX_WALLETS = 50;

export type PortfolioHolding = {
  projectId: string;
  name: string;
  symbol: string;
  mint: string;
  decimals: number;
  heldRaw: string;
  walletCount: number;
  /** USD price of the deepest saved pair, or null when none is saved. */
  priceUsd: number | null;
  priceObservedAt: string | null;
};
export type PortfolioHoldings = {
  observedAt: string;
  walletCount: number;
  walletsOmitted: number;
  projectsOmitted: number;
  solLamports: string;
  holdings: PortfolioHolding[];
};
export type PerformanceScopeLite = {
  kind: string;
  id: string;
  unallocatedCostLamports: string;
  linkedResultLamports: string;
};
export type PortfolioRow = PortfolioHolding & {
  valueUsd: number | null;
  valueLamports: bigint | null;
  openCostLamports: bigint;
  unrealizedLamports: bigint | null;
  realizedLamports: bigint;
};
export type PortfolioSummary = {
  rows: PortfolioRow[];
  solLamports: bigint;
  holdingsValueLamports: bigint;
  unpricedCount: number;
  realizedLamports: bigint;
  unrealizedLamports: bigint;
  totalLamports: bigint;
};

/** Raw units times a decimal USD price, as a float (display only). */
export function holdingUsd(
  heldRaw: string,
  decimals: number,
  priceUsd: number,
) {
  const raw = BigInt(heldRaw);
  const scale = 10n ** BigInt(decimals);
  const whole = Number(raw / scale) + Number(raw % scale) / Number(scale);
  return whole * priceUsd;
}

export function summarizePortfolio(
  holdings: PortfolioHoldings,
  scopes: PerformanceScopeLite[],
  solUsd: number | null,
): PortfolioSummary {
  const byProject = new Map(
    scopes.filter((s) => s.kind === 'Imported trades').map((s) => [s.id, s]),
  );
  let value = 0n,
    unrealized = 0n,
    unpriced = 0;
  const rows = holdings.holdings.map((h): PortfolioRow => {
    const scope = byProject.get(h.projectId);
    const openCost = BigInt(scope?.unallocatedCostLamports ?? '0');
    const realized = BigInt(scope?.linkedResultLamports ?? '0');
    const valueUsd =
      h.priceUsd === null
        ? null
        : holdingUsd(h.heldRaw, h.decimals, h.priceUsd);
    const valueLamports =
      valueUsd === null || !solUsd || solUsd <= 0
        ? null
        : BigInt(Math.round((valueUsd / solUsd) * 1e9));
    if (valueLamports === null) {
      if (BigInt(h.heldRaw) > 0n) unpriced++;
    } else {
      value += valueLamports;
      unrealized += valueLamports - openCost;
    }
    return {
      ...h,
      valueUsd,
      valueLamports,
      openCostLamports: openCost,
      unrealizedLamports:
        valueLamports === null ? null : valueLamports - openCost,
      realizedLamports: realized,
    };
  });
  const realized = scopes.reduce(
    (n, s) => n + BigInt(s.linkedResultLamports),
    0n,
  );
  return {
    rows,
    solLamports: BigInt(holdings.solLamports),
    holdingsValueLamports: value,
    unpricedCount: unpriced,
    realizedLamports: realized,
    unrealizedLamports: unrealized,
    totalLamports: realized + unrealized,
  };
}
