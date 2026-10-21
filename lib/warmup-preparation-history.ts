import { unsignedPreparationSummary } from './imported-swap-preparation-history';
import type { SolanaSwapPreparation } from './warmup-swap-quote';
import type { ImportedSwapSimulation } from './imported-swap-simulation';
import type { WarmupSellInventory } from './warmup-sell-inventory';
import type { SavedWarmup } from './wallet-warmup-storage';
import { warmupAtoms, warmupBuyAmount } from './wallet-warmup';
import type { WarmupBuyLink } from './warmup-buy-link';
import { WARMUP_HISTORY_LIMIT } from './warmup-history-capacity';
export function warmupPreparationSummary(
  order: SolanaSwapPreparation,
  simulation: ImportedSwapSimulation,
  mint: string,
  inventory?: WarmupSellInventory,
  buyReceipt?: WarmupBuyLink,
) {
  const wrapped = 'So11111111111111111111111111111111111111112';
  if (
    buyReceipt &&
    (order.side !== 'Sell' ||
      !inventory ||
      BigInt(order.inAmount) > BigInt(buyReceipt.acquiredRaw))
  )
    throw new Error('Invalid buy-linked sell summary.');
  if (
    order.inputMint !== (order.side === 'Buy' ? wrapped : mint) ||
    order.outputMint !== (order.side === 'Sell' ? wrapped : mint) ||
    (order.side === 'Sell' &&
      (!inventory ||
        inventory.wallet !== order.preparation.wallet ||
        inventory.mint !== mint ||
        inventory.requestedRaw !== order.inAmount ||
        !inventory.amountCovered ||
        !inventory.preparationSupported ||
        inventory.executionAllowed !== false))
  )
    throw new Error('Warmup preparation context mismatch.');
  return {
    ...unsignedPreparationSummary(order, simulation),
    ...(buyReceipt ? { buyReceipt } : {}),
    inventory: inventory
      ? {
          source: inventory.source,
          observedAt: inventory.observedAt,
          minSlot: inventory.minSlot,
          maxSlot: inventory.maxSlot,
          requestedRaw: inventory.requestedRaw,
          unfrozenRaw: inventory.unfrozenRaw,
          amountCovered: inventory.amountCovered,
          decimals: inventory.decimals,
          tokenProgram: inventory.tokenProgram,
          limitations: inventory.limitations,
        }
      : null,
  };
}
export type WarmupPreparationSummary = ReturnType<
  typeof warmupPreparationSummary
>;
export type SavedWarmupPreparation = {
  id: string;
  planId: string;
  planRevision: number;
  cycle: number;
  walletRevision: number;
  createdAt: string;
  document: WarmupPreparationSummary;
};
/** Shared original history validation, not signing or runtime qualification. */
export function warmupPreparationHistoryDocument(
  context: {
    planId: string;
    planRevision: number;
    cycle: number;
    walletRevision: number;
  },
  document: WarmupPreparationSummary,
  capturedDocument: string,
) {
  const text = JSON.stringify(document);
  const plan = JSON.parse(capturedDocument) as SavedWarmup['document'];
  if (
    document.side === 'Buy' &&
    document.inAmountRaw !==
      warmupAtoms(
        warmupBuyAmount(plan, document.wallet, context.cycle),
        9,
      ).toString()
  )
    throw new Error('Warmup input does not match the saved budget.');
  if (
    plan.chain !== 'Solana' ||
    context.cycle < 1 ||
    context.cycle > plan.cycles ||
    !Number.isInteger(context.cycle) ||
    plan.walletRevisions.find((w) => w.address === document.wallet)
      ?.revision !== context.walletRevision ||
    !plan.addresses.includes(document.wallet) ||
    (document.side === 'Buy' ? document.outputMint : document.inputMint) !==
      plan.tokens[(context.cycle - 1) % plan.tokens.length]
  )
    throw new Error('Invalid saved warmup context.');
  if (
    text.length > 8192 ||
    document.executionAllowed !== false ||
    document.instructionsVerified !== false
  )
    throw new Error('Invalid preparation history.');
  return text;
}
export async function saveWarmupPreparation(
  db: D1Database,
  owner: string,
  context: {
    planId: string;
    planRevision: number;
    cycle: number;
    walletRevision: number;
  },
  document: WarmupPreparationSummary,
  capturedDocument: string,
) {
  const text = warmupPreparationHistoryDocument(
      context,
      document,
      capturedDocument,
    ),
    id = crypto.randomUUID(),
    createdAt = new Date().toISOString();
  const result = await db
    .prepare(
      `INSERT INTO warmup_swap_preparations
    (id,owner_id,plan_id,plan_revision,cycle,wallet_address,wallet_revision,document,created_at)
    SELECT ?,?,?,?,?,?,?,?,? WHERE
    EXISTS(SELECT 1 FROM wallet_warmup_plans p WHERE p.owner_id=? AND p.id=? AND p.revision=? AND p.archived=0 AND p.document=?
      AND (SELECT COUNT(*) FROM json_each(json_extract(p.document,'$.walletRevisions')) j JOIN workspace_wallets w ON w.address=json_extract(j.value,'$.address') AND w.revision=json_extract(j.value,'$.revision') WHERE w.owner_id=p.owner_id AND w.chain=json_extract(p.document,'$.chain') AND w.archived=0)=json_array_length(json_extract(p.document,'$.addresses')))
    AND (SELECT COUNT(*) FROM warmup_swap_preparations WHERE owner_id=? AND plan_id=?)<? AND ?>?`,
    )
    .bind(
      id,
      owner,
      context.planId,
      context.planRevision,
      context.cycle,
      document.wallet,
      context.walletRevision,
      text,
      createdAt,
      owner,
      context.planId,
      context.planRevision,
      capturedDocument,
      owner,
      context.planId,
      WARMUP_HISTORY_LIMIT,
      Date.parse(document.expiresAt),
      Date.now(),
    )
    .run();
  return result.meta.changes ? { id, ...context, createdAt, document } : null;
}
