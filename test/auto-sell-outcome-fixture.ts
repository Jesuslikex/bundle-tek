import bs58 from 'bs58';
import type { AutoSellOutcomeReference } from '../lib/auto-sell-outcome-reference';
import type { ImportedApprovalRow } from '../lib/imported-approval-history';
export const autoSellOutcomeReference: AutoSellOutcomeReference = {
  projectId: '11111111-1111-4111-8111-111111111111',
  projectRevision: 7,
  walletRevision: 9,
  preparationId: '22222222-2222-4222-8222-222222222222',
  intentId: '33333333-3333-4333-8333-333333333333',
  wallet: '11111111111111111111111111111111',
  mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  inputRaw: '5000000',
  preparationSha256: 'a'.repeat(64),
  signature: bs58.encode(new Uint8Array(64).fill(7)),
};
export function autoSellOutcomePage(): {
  projectId: string;
  intents: ImportedApprovalRow[];
  nextCursor: string | null;
} {
  const ref = autoSellOutcomeReference;
  const row: ImportedApprovalRow = {
    projectId: ref.projectId,
    projectRevision: ref.projectRevision,
    walletRevision: ref.walletRevision,
    id: ref.intentId,
    preparationId: ref.preparationId,
    wallet: ref.wallet,
    side: 'Sell',
    state: 'submitted',
    signature: ref.signature,
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-01T00:01:00Z',
    failureReceipt: null,
    document: {
      id: ref.intentId,
      preparationId: ref.preparationId,
      wallet: ref.wallet,
      network: 'mainnet',
      sha256: ref.preparationSha256,
      transaction: 'SYNTHETIC-UNSIGNED-PACKET-DO-NOT-RENDER',
      expiresAt: '2026-10-01T00:00:30Z',
      maximumFeeLamports: '10000',
      inputRaw: ref.inputRaw,
      minimumOutputRaw: '1',
      inputMint: ref.mint,
      outputMint: 'So11111111111111111111111111111111111111112',
      lastValidBlockHeight: '100',
    },
  };
  return { projectId: ref.projectId, intents: [row], nextCursor: null };
}
