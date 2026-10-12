import type { ProgressBuy, ProgressSell } from './warmup-cycle-progress';
import { WARMUP_HISTORY_LIMIT } from './warmup-history-capacity';
import { transactionSignature } from './tracked-wallet-transaction';

type Economics = {
  signature: string;
  wallet: string;
  mint: string;
  decimals: number;
  tokenProgram: string;
  slot: number;
  preparationSha256: string;
  nativeSettlementRaw: string;
  networkFeeLamports: string;
  rentChangeRaw: string;
};
export type PerformanceBuy = ProgressBuy & { document: Economics };
export type PerformanceSell = ProgressSell & {
  id: string;
  document: Economics;
};
const max = (1n << 64n) - 1n;
function integer(value: string, signed = false) {
  if (
    typeof value !== 'string' ||
    !(signed ? /^(0|-?[1-9]\d{0,19})$/ : /^(0|[1-9]\d{0,19})$/).test(value)
  )
    throw new Error('Invalid recorded economics.');
  const n = BigInt(value);
  if (n > max || n < -max)
    throw new Error('Recorded economics outside bounds.');
  return n;
}
function economics(document: Economics, signatures: Set<string>) {
  if (
    !document ||
    !Number.isSafeInteger(document.slot) ||
    document.slot < 1 ||
    !/^[a-f0-9]{64}$/.test(document.preparationSha256) ||
    ![
      'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
      'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
    ].includes(document.tokenProgram) ||
    !Number.isInteger(document.decimals) ||
    document.decimals < 0 ||
    document.decimals > 18
  )
    throw new Error('Incomplete recorded economics.');
  transactionSignature(document.signature);
  if (signatures.has(document.signature))
    throw new Error('Duplicate recorded transaction.');
  signatures.add(document.signature);
  return {
    settlement: integer(document.nativeSettlementRaw, true),
    fee: integer(document.networkFeeLamports),
    rent: integer(document.rentChangeRaw, true),
  };
}

/** Exact linked-lot accounting. Rent is kept separate from economic swap settlement. */
export function warmupLotPerformance(
  buys: PerformanceBuy[],
  sells: PerformanceSell[],
  includedIds: string[],
) {
  if (buys.length > WARMUP_HISTORY_LIMIT || sells.length > WARMUP_HISTORY_LIMIT)
    throw new Error('Recorded receipt capacity exceeded.');
  const signatures = new Set<string>(),
    lots = new Map<
      string,
      {
        buy: PerformanceBuy;
        cost: bigint;
        remaining: bigint;
        acquired: bigint;
        sold: bigint;
        proceeds: bigint;
        fees: bigint;
        rent: bigint;
        sellCount: number;
      }
    >();
  for (const buy of buys) {
    const e = economics(buy.document, signatures),
      acquired = integer(buy.acquiredRaw),
      remaining = integer(buy.remainingRaw);
    if (
      !buy.id ||
      lots.has(buy.id) ||
      buy.verified !== 1 ||
      buy.commitment !== 'finalized' ||
      buy.network !== 'mainnet' ||
      buy.document.wallet !== buy.wallet ||
      buy.document.mint !== buy.mint ||
      buy.document.decimals !== buy.decimals ||
      acquired === 0n ||
      remaining > acquired ||
      e.settlement >= 0n
    )
      throw new Error('Invalid recorded buy lot.');
    lots.set(buy.id, {
      buy,
      cost: -e.settlement + e.fee,
      remaining,
      acquired,
      sold: 0n,
      proceeds: 0n,
      fees: e.fee,
      rent: e.rent,
      sellCount: 0,
    });
  }
  const sellIds = new Set<string>();
  for (const sell of sells) {
    const e = economics(sell.document, signatures),
      lot = lots.get(sell.buyId),
      units = integer(sell.consumedRaw);
    if (
      !sell.id ||
      sellIds.has(sell.id) ||
      !lot ||
      sell.verified !== 1 ||
      sell.commitment !== 'finalized' ||
      sell.network !== 'mainnet' ||
      sell.document.wallet !== lot.buy.wallet ||
      sell.document.mint !== lot.buy.mint ||
      sell.document.decimals !== lot.buy.decimals ||
      sell.document.tokenProgram !== lot.buy.document.tokenProgram ||
      sell.document.slot <= lot.buy.document.slot ||
      units === 0n ||
      e.settlement <= 0n
    )
      throw new Error('Invalid recorded linked sell.');
    sellIds.add(sell.id);
    lot.sold += units;
    lot.proceeds += e.settlement - e.fee;
    lot.fees += e.fee;
    lot.rent += e.rent;
    lot.sellCount++;
  }
  for (const lot of lots.values()) {
    if (lot.sold + lot.remaining !== lot.acquired)
      throw new Error('Recorded lot accounting differs.');
  }
  if (
    new Set(includedIds).size !== includedIds.length ||
    includedIds.some((id) => !lots.has(id))
  )
    throw new Error('Invalid performance scope.');
  const records = includedIds.map((id) => {
    const lot = lots.get(id)!;
    // Aggregate cumulative allocation avoids transaction-order assumptions. Full exits consume all rounding residue.
    const allocated = (lot.cost * lot.sold) / lot.acquired;
    return {
      buyId: id,
      wallet: lot.buy.wallet,
      mint: lot.buy.mint,
      decimals: lot.buy.decimals,
      acquiredRaw: lot.acquired.toString(),
      soldRaw: lot.sold.toString(),
      remainingRaw: lot.remaining.toString(),
      buyCostLamports: lot.cost.toString(),
      realizedCostLamports: allocated.toString(),
      openCostLamports: (lot.cost - allocated).toString(),
      netSellProceedsLamports: lot.proceeds.toString(),
      realizedResultLamports: (lot.proceeds - allocated).toString(),
      networkFeeLamports: lot.fees.toString(),
      rentChangeLamports: lot.rent.toString(),
      sellCount: lot.sellCount,
    };
  });
  const sum = (
    field:
      | 'realizedCostLamports'
      | 'openCostLamports'
      | 'netSellProceedsLamports'
      | 'realizedResultLamports'
      | 'networkFeeLamports'
      | 'rentChangeLamports',
  ) =>
    records.reduce((total, row) => total + BigInt(row[field]), 0n).toString();
  return {
    lotCount: records.length,
    soldLotCount: records.filter((row) => row.soldRaw !== '0').length,
    openLotCount: records.filter((row) => row.remainingRaw !== '0').length,
    realizedCostLamports: sum('realizedCostLamports'),
    openCostLamports: sum('openCostLamports'),
    netSellProceedsLamports: sum('netSellProceedsLamports'),
    realizedResultLamports: sum('realizedResultLamports'),
    networkFeeLamports: sum('networkFeeLamports'),
    rentChangeLamports: sum('rentChangeLamports'),
    lots: records,
  };
}
export type WarmupLotPerformance = ReturnType<typeof warmupLotPerformance>;
