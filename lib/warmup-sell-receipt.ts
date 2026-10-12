import type { WarmupSigningReview } from './warmup-signing';
import type { SavedWarmupPreparation } from './warmup-preparation-history';
import {
  observeWarmupReceipt,
  type SavedWarmupBuyReceipt,
} from './warmup-buy-receipt';
import { requireStoredWarmupBuyLink } from './warmup-buy-link';
import { WARMUP_HISTORY_LIMIT } from './warmup-history-capacity';
export async function observeWarmupSellReceipt(
  preparation: SavedWarmupPreparation,
  buy: SavedWarmupBuyReceipt,
  signature: string,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
  approval?: WarmupSigningReview,
) {
  const saved = preparation.document;
  if (saved.side !== 'Sell' || saved.buyReceipt?.receiptId !== buy.id)
    throw new Error('Choose a sell linked to this buy.');
  requireStoredWarmupBuyLink(
    buy,
    {
      planId: preparation.planId,
      planRevision: preparation.planRevision,
      cycle: preparation.cycle,
      walletRevision: preparation.walletRevision,
      wallet: saved.wallet,
      mint: saved.inputMint,
    },
    saved.buyReceipt,
  );
  const receipt = await observeWarmupReceipt(
    preparation,
    signature,
    signal,
    fetcher,
    'Sell',
    approval,
  );
  if (
    receipt.slot <= buy.document.slot ||
    receipt.decimals !== buy.document.decimals ||
    receipt.tokenProgram !== buy.document.tokenProgram
  )
    throw new Error('Sell receipt does not follow the matched buy.');
  const { acquiredRaw: consumedRaw, ...document } = receipt;
  return {
    ...document,
    consumedRaw,
    buyReceiptId: buy.id,
    limitations:
      'Verified wallet signature and exact saved sell packet. Finalized net token decrease and native output checked after separating network fees, wrapped units and account rent. Recorded app sells consume this buy lot once; external transfers and pending transactions are not reconstructed. Returned account rent is excluded from swap output. This does not prove profit.',
  };
}
export type WarmupSellReceipt = Awaited<
  ReturnType<typeof observeWarmupSellReceipt>
>;
export type SavedWarmupSellReceipt = {
  id: string;
  preparationId: string;
  planId: string;
  createdAt: string;
  document: WarmupSellReceipt;
};
export async function saveWarmupSellReceipt(
  db: D1Database,
  owner: string,
  preparation: SavedWarmupPreparation,
  buy: SavedWarmupBuyReceipt,
  document: WarmupSellReceipt,
) {
  const remaining = buy.remainingRaw ?? buy.document.acquiredRaw;
  const consumed = document.consumedRaw;
  requireStoredWarmupBuyLink(
    buy,
    {
      planId: preparation.planId,
      planRevision: preparation.planRevision,
      cycle: preparation.cycle,
      walletRevision: preparation.walletRevision,
      wallet: preparation.document.wallet,
      mint: preparation.document.inputMint,
    },
    preparation.document.buyReceipt,
  );
  if (
    document.signatureVerified !== true ||
    document.commitment !== 'finalized' ||
    document.network !== 'mainnet' ||
    document.slot <= buy.document.slot ||
    document.decimals !== buy.document.decimals ||
    document.tokenProgram !== buy.document.tokenProgram ||
    preparation.document.buyReceipt?.receiptId !== buy.id
  )
    throw new Error('Receipt does not match the saved buy lot.');
  if (
    !/^(0|[1-9]\d{0,19})$/.test(remaining) ||
    !/^[1-9]\d{0,19}$/.test(consumed) ||
    BigInt(consumed) > BigInt(remaining) ||
    BigInt(remaining) > BigInt(buy.document.acquiredRaw) ||
    document.buyReceiptId !== buy.id ||
    document.preparationSha256 !== preparation.document.transaction.sha256 ||
    document.wallet !== buy.document.wallet ||
    document.mint !== buy.document.mint ||
    consumed !== preparation.document.inAmountRaw
  )
    throw new Error('Sell exceeds remaining matched buy units.');
  const id = crypto.randomUUID(),
    createdAt = new Date().toISOString(),
    text = JSON.stringify(document);
  if (text.length > 8192) throw new Error('Receipt too large.');
  const writes = await db.batch([
    db
      .prepare(`INSERT OR IGNORE INTO warmup_sell_receipts(id,owner_id,preparation_id,buy_receipt_id,plan_id,signature,consumed_raw,document,created_at)
      SELECT ?,?,?,?,?,?,?,?,? WHERE
      EXISTS(SELECT 1 FROM warmup_buy_receipts WHERE owner_id=? AND id=? AND COALESCE(remaining_raw,json_extract(document,'$.acquiredRaw'))=? AND document=?)
      AND EXISTS(SELECT 1 FROM warmup_swap_preparations WHERE owner_id=? AND id=? AND document=?)
      AND NOT EXISTS(SELECT 1 FROM warmup_buy_receipts WHERE owner_id=? AND signature=?)
      AND (SELECT COUNT(*) FROM warmup_sell_receipts WHERE owner_id=? AND plan_id=?)<?`)
      .bind(
        id,
        owner,
        preparation.id,
        buy.id,
        preparation.planId,
        document.signature,
        consumed,
        text,
        createdAt,
        owner,
        buy.id,
        remaining,
        JSON.stringify(buy.document),
        owner,
        preparation.id,
        JSON.stringify(preparation.document),
        owner,
        document.signature,
        owner,
        preparation.planId,
        WARMUP_HISTORY_LIMIT,
      ),
    db
      .prepare(
        `UPDATE warmup_buy_receipts SET remaining_raw=? WHERE owner_id=? AND id=? AND COALESCE(remaining_raw,json_extract(document,'$.acquiredRaw'))=? AND EXISTS(SELECT 1 FROM warmup_sell_receipts WHERE owner_id=? AND id=?)`,
      )
      .bind(
        (BigInt(remaining) - BigInt(consumed)).toString(),
        owner,
        buy.id,
        remaining,
        owner,
        id,
      ),
    db
      .prepare(
        "UPDATE warmup_signing_intents SET state='finalized',updated_at=? WHERE owner_id=? AND preparation_id=? AND signature=? AND state IN ('signed','submitted') AND EXISTS(SELECT 1 FROM warmup_sell_receipts WHERE owner_id=? AND id=?)",
      )
      .bind(createdAt, owner, preparation.id, document.signature, owner, id),
  ]);
  return writes[0].meta.changes && writes[1].meta.changes
    ? {
        id,
        preparationId: preparation.id,
        planId: preparation.planId,
        createdAt,
        document,
      }
    : null;
}
