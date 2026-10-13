import { jitoBundleFixture } from './jito-bundle-fixture';
import { acquisitionReceipt } from './imported-sell-acquisition-fixture';
import { decodeNativeWithdrawalReceipt } from '../lib/native-withdrawal-server';
import { createJitoFinalization } from '../lib/jito-finalization';
import type { JitoPerformanceRow } from '../lib/jito-performance-costs';
export async function jitoPerformanceFixture(count = 2) {
  const f = await jitoBundleFixture(count);
  const raw = structuredClone(f.tip.receipt);
  raw.meta.fee = '1';
  raw.meta.postBalances[0] = (
    BigInt(raw.meta.preBalances[0]) -
    BigInt(f.manifest.tip.amountRaw) -
    1n
  ).toString();
  const tip = await decodeNativeWithdrawalReceipt(
    raw,
    f.manifest.tip,
    f.tip.signed.signature,
  );
  if (!('amountRaw' in tip)) throw new Error('Expected successful tip');
  const signatures = [
    ...f.swaps.map((s) => s.signed.signature),
    f.tip.signed.signature,
  ];
  const proof = await createJitoFinalization(
    f.manifest,
    signatures,
    tip.slot,
    new Date().toISOString(),
    tip,
  );
  const receipts = f.manifest.swaps.map((review, i) => {
    const receipt = acquisitionReceipt(
      200 + i,
      'Buy',
      '3',
      review.wallet,
      tip.slot,
    );
    receipt.projectId = f.manifest.projectId;
    receipt.preparationId = review.preparationId;
    Object.assign(receipt.document, {
      signature: signatures[i],
      preparationSha256: review.sha256,
      mint: review.outputMint,
    });
    return receipt;
  });
  const row: JitoPerformanceRow = {
    id: f.manifest.id,
    state: 'finalized',
    document: JSON.stringify(f.manifest),
    finalizationDocument: JSON.stringify(proof),
    packets: JSON.stringify(
      signatures.map((signature, packet) => ({ signature, packet })),
    ),
  };
  return { f, row, receipts, proof };
}
