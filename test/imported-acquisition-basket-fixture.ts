import {
  acquisitionFixture,
  acquisitionWallet,
} from './imported-sell-acquisition-fixture';
import type { ImportedAcquisitionBasket } from '../lib/imported-acquisition';
export function acquisitionBasketFixture(): ImportedAcquisitionBasket {
  const page = acquisitionFixture(2);
  const allocations = page.performance.lots.map((lot, i) => {
    const buy = page.receipts.find((r) => r.id === lot.buyReceiptId)!;
    const unitsRaw = i === 0 ? '2' : '1';
    const cost = BigInt(lot.buyCostLamports),
      before = BigInt(lot.assignedSoldRaw),
      acquired = BigInt(lot.acquiredRaw);
    return {
      projectId: page.projectId,
      buyReceiptId: buy.id,
      buySignature: buy.document.signature,
      buyPreparationSha256: buy.document.preparationSha256,
      buyDocumentSha256: page.receiptDocumentHashes[buy.id],
      wallet: acquisitionWallet,
      mint: page.mint,
      decimals: page.decimals,
      acquiredRaw: lot.acquiredRaw,
      assignedBeforeRaw: lot.assignedSoldRaw,
      unitsRaw,
      buyCostLamports: lot.buyCostLamports,
      allocatedCostLamports: (
        (cost * (before + BigInt(unitsRaw))) / acquired -
        (cost * before) / acquired
      ).toString(),
      linkRevision: page.revision,
    };
  });
  return {
    kind: 'basket',
    version: 1,
    projectId: page.projectId,
    wallet: acquisitionWallet,
    mint: page.mint,
    decimals: page.decimals,
    unitsRaw: '3',
    linkRevision: page.revision,
    allocations,
  };
}
