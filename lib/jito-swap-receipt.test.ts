import { expect, it } from 'vitest';
import { jitoBundleFixture } from '../test/jito-bundle-fixture';
import { matchingJitoSwapReceipt } from './jito-swap-receipt';
it('rejects truthy receipts, wrong slots and packet/context substitutions', async () => {
  const f = await jitoBundleFixture(),
    r = f.review;
  const value = {
    projectId: f.manifest.projectId,
    preparationId: r.preparationId,
    document: {
      side: 'Buy',
      network: 'mainnet',
      commitment: 'finalized',
      signatureVerified: true,
      signature: f.swap.signed.signature,
      wallet: r.wallet,
      preparationSha256: r.sha256,
      slot: 300,
      mint: r.outputMint,
    },
  };
  const check = (v: unknown) =>
    matchingJitoSwapReceipt(
      v,
      f.manifest.projectId,
      r,
      f.swap.signed.signature,
      300,
    );
  expect(check(value)).toBe(true);
  for (const v of [
    true,
    {},
    null,
    [],
    { ...value, projectId: crypto.randomUUID() },
    { ...value, preparationId: crypto.randomUUID() },
  ])
    expect(check(v)).toBe(false);
  for (const altered of [
    { slot: 301 },
    { slot: '300' },
    { side: 'Sell' },
    { network: 'devnet' },
    { commitment: 'confirmed' },
    { signatureVerified: false },
    { signature: f.tip.signed.signature },
    { wallet: f.tip.recipient },
    { preparationSha256: '00'.repeat(32) },
    { mint: r.inputMint },
  ])
    expect(
      check({ ...value, document: { ...value.document, ...altered } }),
    ).toBe(false);
});
