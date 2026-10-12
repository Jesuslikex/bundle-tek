import type { SavedWarmupBuyReceipt } from './warmup-buy-receipt';
import type { WarmupSellInventory } from './warmup-sell-inventory';
export type WarmupBuyLink = {
  receiptId: string;
  preparationId: string;
  signature: string;
  acquiredRaw: string;
  remainingRaw?: string;
  decimals: number;
  slot: number;
  preparationSha256: string;
  historicalBuy?: { planRevision: number; walletRevision: number };
  limitations: string;
};
export function warmupBuyLink(
  receipt: SavedWarmupBuyReceipt,
  context: {
    planId: string;
    planRevision: number;
    cycle: number;
    wallet: string;
    walletRevision: number;
    mint: string;
    allowHistoricalBuy?: boolean;
  },
  inventory?: WarmupSellInventory,
) {
  const value = receipt.document;
  const remaining = receipt.remainingRaw ?? value.acquiredRaw;
  if (
    !/^(0|[1-9]\d{0,19})$/.test(remaining) ||
    BigInt(remaining) > BigInt(value.acquiredRaw)
  )
    throw new Error('Invalid remaining buy units.');
  if (
    receipt.planId !== context.planId ||
    (receipt.planRevision !== context.planRevision &&
      !context.allowHistoricalBuy) ||
    receipt.cycle !== context.cycle ||
    (receipt.walletRevision !== context.walletRevision &&
      !context.allowHistoricalBuy) ||
    value.wallet !== context.wallet ||
    value.mint !== context.mint ||
    value.executionAllowed !== false ||
    value.instructionsVerified !== false ||
    value.signatureVerified !== true ||
    value.commitment !== 'finalized' ||
    value.network !== 'mainnet' ||
    !Number.isSafeInteger(receipt.planRevision) ||
    receipt.planRevision < 1 ||
    !Number.isSafeInteger(receipt.walletRevision) ||
    receipt.walletRevision < 1 ||
    receipt.planRevision > context.planRevision ||
    receipt.walletRevision > context.walletRevision ||
    !Number.isSafeInteger(value.slot) ||
    value.slot < 0 ||
    !Number.isInteger(value.decimals) ||
    value.decimals < 0 ||
    value.decimals > 255 ||
    !/^[1-9]\d{0,19}$/.test(value.acquiredRaw) ||
    BigInt(value.acquiredRaw) > (1n << 64n) - 1n
  )
    throw new Error('Buy receipt does not match this warmup cycle and wallet.');
  if (
    inventory &&
    (inventory.wallet !== value.wallet ||
      inventory.mint !== value.mint ||
      inventory.tokenProgram !== value.tokenProgram ||
      inventory.decimals !== value.decimals ||
      !Number.isSafeInteger(inventory.minSlot) ||
      inventory.minSlot < value.slot ||
      (inventory.requestedRaw !== null &&
        BigInt(inventory.requestedRaw) > BigInt(remaining)))
  )
    throw new Error(
      'Sell input exceeds the matched buy acquisition or fresh inventory does not match the receipt.',
    );
  return {
    receiptId: receipt.id,
    preparationId: receipt.preparationId,
    signature: value.signature,
    acquiredRaw: value.acquiredRaw,
    remainingRaw: remaining,
    decimals: value.decimals,
    slot: value.slot,
    preparationSha256: value.preparationSha256,
    ...(context.allowHistoricalBuy &&
    (receipt.planRevision !== context.planRevision ||
      receipt.walletRevision !== context.walletRevision)
      ? {
          historicalBuy: {
            planRevision: receipt.planRevision,
            walletRevision: receipt.walletRevision,
          },
        }
      : {}),
    limitations:
      'Sell input capped by remaining units after recorded finalized sells. Current unfrozen holdings are checked separately. External token movements and pending signatures are not reconstructed by this receipt ledger.',
  };
}
export function requireStoredWarmupBuyLink(
  receipt: SavedWarmupBuyReceipt,
  context: Parameters<typeof warmupBuyLink>[1],
  stored: WarmupBuyLink | undefined,
) {
  if (!stored) throw new Error('A saved matching buy link is required.');
  const history = stored.historicalBuy;
  if (
    history &&
    (history.planRevision !== receipt.planRevision ||
      history.walletRevision !== receipt.walletRevision)
  )
    throw new Error('Historical buy provenance differs.');
  const expected = warmupBuyLink(receipt, {
    ...context,
    allowHistoricalBuy: history !== undefined,
  });
  if (
    stored.receiptId !== expected.receiptId ||
    stored.preparationId !== expected.preparationId ||
    stored.signature !== expected.signature ||
    stored.preparationSha256 !== expected.preparationSha256 ||
    stored.acquiredRaw !== expected.acquiredRaw ||
    stored.decimals !== expected.decimals ||
    stored.slot !== expected.slot ||
    !!history !== !!expected.historicalBuy
  )
    throw new Error('Saved buy provenance differs.');
  return expected;
}
