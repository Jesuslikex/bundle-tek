/** Saved launch-buy cost shares for imported sales assigned through the
 * launch sale ledger. Reads only stored, immutable rows; no RPC or writes. */
export type LaunchSaleAllocationRecord = {
  saleReceiptId: string;
  saleSignature: string;
  wallet: string;
  mint: string;
  sha256: string;
  document: string;
};
export type LaunchCostSourceRecord = {
  originId: string;
  wallet: string;
  mint: string;
  sha256: string;
  source: string;
};
export type LaunchSaleCost = {
  saleSignature: string;
  wallet: string;
  mint: string;
  soldRaw: string;
  costLamports: string;
};

const U64 = (1n << 64n) - 1n;
const uint = (v: unknown, positive = false) => {
  if (
    typeof v !== 'string' ||
    !/^(0|[1-9]\d{0,19})$/.test(v) ||
    BigInt(v) > U64 ||
    (positive && v === '0')
  )
    throw new Error('Launch sale cost evidence differs.');
  return BigInt(v);
};
const fail = (): never => {
  throw new Error('Launch sale cost evidence differs.');
};

/**
 * Exact SOL cost per launch-assigned sale. Each assignment covers the recorded
 * interval [before, after) of one buy, so its share telescopes:
 * cost*after/acquired - cost*before/acquired. Shares across all sales of one
 * buy therefore never exceed that buy's recorded cost. Wallet setup funding is
 * excluded, matching nativeTradeCostExcludingSetupLamports. Buys paid in a
 * token quote have no SOL cost, so their sales are returned as unvalued and
 * stay outside realized SOL totals.
 */
export function launchSaleCosts(
  allocations: LaunchSaleAllocationRecord[],
  sources: LaunchCostSourceRecord[],
) {
  const byOrigin = new Map<string, Record<string, unknown>>();
  for (const row of sources) {
    const s = JSON.parse(row.source) as Record<string, unknown>;
    if (
      byOrigin.has(row.originId) ||
      s.originId !== row.originId ||
      s.sha256 !== row.sha256 ||
      s.wallet !== row.wallet ||
      s.mint !== row.mint ||
      s.policy !== 'reviewed-buy-shares-v1' ||
      s.acquisitionBasisVerified !== false ||
      s.executionAllowed !== false
    )
      fail();
    byOrigin.set(row.originId, s);
  }
  const costs = new Map<string, LaunchSaleCost>(),
    unvalued = new Set<string>();
  for (const row of allocations) {
    const d = JSON.parse(row.document) as Record<string, unknown> & {
      allocations: Record<string, unknown>[];
    };
    if (
      d.format !== 'launch-sale-allocation-v1' ||
      d.policy !== 'recorded-launch-units-v1' ||
      d.saleReceiptId !== row.saleReceiptId ||
      d.saleSignature !== row.saleSignature ||
      d.wallet !== row.wallet ||
      d.mint !== row.mint ||
      d.sha256 !== row.sha256 ||
      d.decimals !== 6 ||
      d.profitCalculated !== false ||
      d.executionAllowed !== false ||
      !Array.isArray(d.allocations) ||
      d.allocations.length < 1 ||
      d.allocations.length > 8 ||
      costs.has(row.saleReceiptId) ||
      unvalued.has(row.saleReceiptId)
    )
      fail();
    let sold = 0n,
      cost = 0n,
      native = true;
    const seen = new Set<unknown>();
    for (const a of d.allocations) {
      const s = byOrigin.get(a.originId as string) ?? fail();
      const before = uint(a.beforeRaw),
        units = uint(a.unitsRaw, true),
        after = uint(a.afterRaw),
        acquired = uint(s.acquiredRaw, true);
      if (
        seen.has(a.originId) ||
        a.sourceSha256 !== s.sha256 ||
        s.wallet !== d.wallet ||
        s.mint !== d.mint ||
        before + units !== after ||
        after > acquired
      )
        fail();
      seen.add(a.originId);
      sold += units;
      const buyCost = s.nativeTradeCostExcludingSetupLamports;
      if (buyCost === null) native = false;
      else {
        const c = uint(buyCost);
        cost += (c * after) / acquired - (c * before) / acquired;
      }
    }
    if (sold !== uint(d.soldRaw, true)) fail();
    if (!native) unvalued.add(row.saleReceiptId);
    else
      costs.set(row.saleReceiptId, {
        saleSignature: row.saleSignature,
        wallet: row.wallet,
        mint: row.mint,
        soldRaw: sold.toString(),
        costLamports: cost.toString(),
      });
  }
  return { costs, unvalued };
}
