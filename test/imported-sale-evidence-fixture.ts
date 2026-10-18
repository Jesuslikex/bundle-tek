import { nativeWarmupFixture } from './warmup-native-fixture';
import { unsignedPreparationSummary } from '../lib/imported-swap-preparation-history';
import {
  requireWarmupSigningReview,
  type WarmupSigningReview,
} from '../lib/warmup-signing';
import { decodeWarmupReceipt } from '../lib/warmup-buy-receipt';
import type { ImportedSaleParent } from '../lib/imported-sale-evidence';
import { SOLANA_MAINNET_GENESIS } from '../lib/wallet-balances';

/** Synthetic Metis packet and finalized metadata, never a funded swap. */
export async function importedSaleEvidenceFixture(
  token2022 = false,
  options: NonNullable<Parameters<typeof nativeWarmupFixture>[0]> = {},
) {
  const f = await nativeWarmupFixture({
    ...options,
    side: 'Sell',
    lookup: true,
    v2: token2022,
    token2022,
  });
  const preparationId = crypto.randomUUID(),
    intentId = crypto.randomUUID();
  const preparation = unsignedPreparationSummary(f.order, f.simulation);
  const approval: WarmupSigningReview = {
    id: intentId,
    preparationId,
    wallet: f.wallet,
    sha256: f.order.preparation.sha256,
    network: 'mainnet',
    expiresAt: f.order.expiresAt,
    transaction: f.order.preparation.transaction,
    lastValidBlockHeight: f.order.preparation.lastValidBlockHeight,
    maximumFeeLamports: '5000',
    inputRaw: f.order.inAmount,
    minimumOutputRaw: f.order.minimumOutAmount,
    inputMint: f.order.inputMint,
    outputMint: f.order.outputMint,
    settlement: await requireWarmupSigningReview(f.order, f.simulation),
  };
  const { acquiredRaw, ...report } = await decodeWarmupReceipt(
    f.receipt,
    { document: preparation },
    f.signed.signature,
    'Sell',
    approval,
  );
  const p: ImportedSaleParent = {
    ownerId: 'alice',
    receiptId: crypto.randomUUID(),
    projectId: crypto.randomUUID(),
    preparationId,
    intentId,
    projectRevision: 1,
    walletRevision: 1,
    signature: f.signed.signature,
    wallet: f.wallet,
    state: 'finalized',
    preparationDocument: JSON.stringify(preparation),
    approvalDocument: JSON.stringify(approval),
    receiptDocument: JSON.stringify({
      ...report,
      side: 'Sell',
      tokenUnitsRaw: acquiredRaw,
      source: 'fixture.test',
      observedAt: new Date().toISOString(),
    }),
  };
  const calls: { method: string; params: unknown[] }[] = [];
  const raw = structuredClone(f.receipt);
  const rpc = async (
    method: string,
    params: unknown[],
    signal: AbortSignal,
  ) => {
    signal.throwIfAborted();
    calls.push({ method, params });
    if (method === 'getGenesisHash') return SOLANA_MAINNET_GENESIS;
    if (method === 'getTransaction' && params[0] === p.signature) return raw;
    throw Error('Unexpected fixture RPC method');
  };
  return { p, raw, rpc, calls, report, approval };
}
