import { expect, it } from 'vitest';
import { volumeSettlementFixture } from '../test/volume-bundle-fixture';
import {
  verifyVolumeBundleSettlement,
  type VolumeFinalizedReceipt,
} from './volume-bundle-settlement';
import { constructVolumeBundle } from './volume-bundle-construction';
it('accounts only the exact signed packet, same-transaction token roundtrip, fee and isolated tip', async () => {
  const { review, receipt } = await volumeSettlementFixture();
  const original = structuredClone(receipt);
  const result = await verifyVolumeBundleSettlement(review, receipt);
  expect(receipt).toEqual(original);
  expect(result).toMatchObject({
    constructionSha256: review.sha256,
    slot: 400,
    buyLamports: '50000000',
    sellLamports: '49900000',
    actualVolumeLamports: '99900000',
    feeLamports: '5000',
    tipLamports: '2000',
    netLamports: '-107000',
    tokenInventoryDeltaRaw: '0',
    executionAllowed: false,
    signingAllowed: false,
    durableTransitionRequired: true,
    routeAndCustodyAdmissionRequired: true,
  });
});
it.each([
  'pending',
  'error',
  'packet',
  'signature',
  'fee',
  'tip',
  'unsafe',
  'metadata',
  'inventory',
  'token-input',
  'mint',
  'order',
  'duplicate',
  'missing',
  'native',
  'loss',
  'loaded',
  'authority',
  'rent',
  'existing',
])('refuses %s and produces no accounting transition', async (kind) => {
  const { review, receipt, index, input } = await volumeSettlementFixture();
  const meta = receipt.result.meta;
  if (kind === 'pending') receipt.commitment = 'confirmed' as 'finalized';
  if (kind === 'error') meta.err = { InstructionError: [1, 'Custom'] };
  if (kind === 'packet') {
    const bytes = Uint8Array.from(atob(receipt.result.transaction[0]), (c) =>
      c.charCodeAt(0),
    );
    bytes[bytes.length - 1] ^= 1;
    receipt.result.transaction[0] = btoa(String.fromCharCode(...bytes));
  }
  if (kind === 'signature') receipt.signature = 'invalid';
  if (kind === 'fee') meta.fee = 5001;
  if (kind === 'tip') meta.postBalances[index(input.tipRecipient)] = 1000001999;
  if (kind === 'unsafe') meta.preBalances[0] = Number.MAX_SAFE_INTEGER + 1;
  if (kind === 'metadata') meta.preTokenBalances = [];
  if (kind === 'inventory')
    meta.postTokenBalances[0].uiTokenAmount.amount = '1';
  if (kind === 'token-input') {
    const ix = meta.innerInstructions[1].instructions[0];
    ix.data = meta.innerInstructions[0].instructions[0].data;
  }
  if (kind === 'mint') meta.postTokenBalances[0].mint = input.tipRecipient;
  if (kind === 'order')
    meta.innerInstructions.reverse().forEach((group, i) => {
      group.index = i;
    });
  if (kind === 'duplicate')
    meta.innerInstructions.push(meta.innerInstructions[0]);
  if (kind === 'missing') meta.innerInstructions = [];
  if (kind === 'native') meta.postBalances[0] = 999893001;
  if (kind === 'loss') {
    review.input.maximumLossLamports = '106999';
    const { constructVolumeBundle } =
      await import('./volume-bundle-construction');
    Object.assign(review, await constructVolumeBundle(review.input));
  }
  if (kind === 'loaded')
    meta.loadedAddresses = { writable: [input.mint], readonly: [] };
  if (kind === 'authority')
    meta.innerInstructions[1].instructions[0].accounts[3] = index(input.mint);
  if (kind === 'rent') meta.postBalances[index(input.tokenAccount)] = 999999999;
  if (kind === 'existing') {
    meta.preTokenBalances[0].uiTokenAmount.amount = '1';
    meta.postTokenBalances[0].uiTokenAmount.amount = '1';
  }
  await expect(
    verifyVolumeBundleSettlement(review, receipt as VolumeFinalizedReceipt),
  ).rejects.toThrow();
});
it('checks minimum proceeds against gross sell transfers even when net balances reconcile', async () => {
  const { input, receipt } = await volumeSettlementFixture();
  const stricter = await constructVolumeBundle({
    ...input,
    minimumSellLamports: '49900001',
  });
  await expect(verifyVolumeBundleSettlement(stricter, receipt)).rejects.toThrow(
    /proceeds/,
  );
});
it('requires readonly balance immutability even if native conservation is preserved', async () => {
  const { review, receipt, index, input } = await volumeSettlementFixture();
  receipt.result.meta.postBalances[index(input.mint)] = 1000000001;
  // Balance the extra lamport against a writable pool. Mint is readonly in this packet.
  const pool =
    receipt.result.meta.innerInstructions[0].instructions[0].accounts[1];
  receipt.result.meta.postBalances[pool] = 1000099999;
  await expect(verifyVolumeBundleSettlement(review, receipt)).rejects.toThrow();
});
