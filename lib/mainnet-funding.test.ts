import { expect, it } from 'vitest';
import { validateFunding } from './funding-plan';
import {
  fundingSelection,
  selectedFundingCapture,
  requireSelectedFundingReview,
  validatedFundingCapture,
  mainnetFundingAsset,
  fundingLegs,
} from './mainnet-funding';
import { nativeWithdrawalFixture } from '../test/native-withdrawal-fixture';
async function fixture() {
  const f = await nativeWithdrawalFixture();
  const plan = {
    id: 'saved-funding',
    revision: 2,
    archived: false,
    updatedAt: new Date().toISOString(),
    document: validateFunding({
      name: 'Funding',
      chain: 'Solana',
      currency: 'SOL',
      source: 'Wallet',
      sourceLabel: '',
      funderAddress: f.wallet,
      startAt: new Date(Date.now() - 1000).toISOString(),
      delaySeconds: 0,
      recipients: [{ address: f.recipient, amount: '0.01' }],
    }),
  };
  const selection = { planId: plan.id, revision: 2, item: 1 };
  return { ...f, plan, selection };
}
it('binds exact native transfers to the complete saved draft and keeps historical recovery after archive', async () => {
  const f = await fixture();
  const capture = await selectedFundingCapture(
    f.plan,
    f.selection,
    f.review,
    Date.now(),
  );
  const review = { ...f.review, funding: capture };
  expect(validatedFundingCapture(capture)).toEqual(capture);
  await expect(
    requireSelectedFundingReview(review, f.plan, 1),
  ).resolves.toBeUndefined();
  await expect(
    requireSelectedFundingReview(review, { ...f.plan, archived: true }, 1),
  ).resolves.toBeUndefined();
  await expect(
    requireSelectedFundingReview(
      review,
      { ...f.plan, document: { ...f.plan.document, name: 'Changed' } },
      1,
    ),
  ).rejects.toThrow();
  await expect(
    requireSelectedFundingReview(
      { ...review, funding: { ...capture, item: 2 } },
      f.plan,
      1,
    ),
  ).rejects.toThrow();
  await expect(
    requireSelectedFundingReview({ ...review, funding: undefined }, f.plan, 1),
  ).rejects.toThrow();
});
it('binds exact catalog token precision and rejects legacy ambiguity, wrapped SOL and substituted assets', async () => {
  const f = await fixture();
  const mint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  const plan = {
    ...f.plan,
    document: validateFunding({
      ...f.plan.document,
      currency: 'USDC',
      assetAddress: mint,
    }),
  };
  const context = {
    ...f.review,
    amountRaw: '10000',
    token: { mint, decimals: 6 },
  };
  expect(mainnetFundingAsset(plan.document)).toEqual({
    kind: 'token',
    mint,
    decimals: 6,
    symbol: 'USDC',
  });
  await expect(
    selectedFundingCapture(plan, f.selection, context, Date.now()),
  ).resolves.toMatchObject({ format: 'mainnet-funding-v1' });
  for (const token of [
    undefined,
    { mint: f.wallet, decimals: 6 },
    { mint, decimals: 9 },
  ])
    await expect(
      selectedFundingCapture(
        plan,
        f.selection,
        { ...context, token },
        Date.now(),
      ),
    ).rejects.toThrow();
  expect(() =>
    mainnetFundingAsset({ ...plan.document, assetAddress: undefined }),
  ).toThrow();
  expect(() =>
    mainnetFundingAsset({
      ...plan.document,
      currency: 'SOL',
      assetAddress: 'So11111111111111111111111111111111111111112',
    }),
  ).toThrow();
});
it('rejects malformed selections, unsupported assets, changed contexts, archived and not due drafts', async () => {
  const f = await fixture();
  for (const value of [
    null,
    { ...f.selection, item: 0 },
    { ...f.selection, revision: 0 },
    { ...f.selection, other: true },
    { ...f.selection, planId: 'bad/id' },
  ])
    expect(() => fundingSelection(value)).toThrow();
  for (const patch of [
    { archived: true },
    { revision: 3 },
    { id: 'other' },
    { document: { ...f.plan.document, source: 'Manual' as const } },
  ])
    await expect(
      selectedFundingCapture(
        { ...f.plan, ...patch },
        f.selection,
        f.review,
        Date.now(),
      ),
    ).rejects.toThrow();
  for (const patch of [
    { wallet: f.recipient },
    { recipient: f.wallet },
    { amountRaw: '999' },
    { token: {} as NonNullable<typeof f.review.token> },
  ])
    await expect(
      selectedFundingCapture(
        f.plan,
        f.selection,
        { ...f.review, ...patch },
        Date.now(),
      ),
    ).rejects.toThrow();
  const later = {
    ...f.plan,
    document: validateFunding({
      ...f.plan.document,
      startAt: new Date(Date.now() + 60000).toISOString(),
    }),
  };
  await expect(
    selectedFundingCapture(later, f.selection, f.review, Date.now()),
  ).rejects.toThrow();
});
it('splits a Classic proxy route into ordered legs with a fee allowance per remaining hop', async () => {
  const f = await fixture();
  const proxies = [
    'Vote111111111111111111111111111111111111111',
    'Stake11111111111111111111111111111111111111',
  ];
  const document = validateFunding({
    ...f.plan.document,
    recipients: [{ address: f.recipient, amount: '0.01', proxies }],
  });
  expect(fundingLegs(document, 1)).toEqual([
    { wallet: f.wallet, recipient: proxies[0], amountRaw: '10200000' },
    { wallet: proxies[0], recipient: proxies[1], amountRaw: '10100000' },
    { wallet: proxies[1], recipient: f.recipient, amountRaw: '10000000' },
  ]);
  for (const bad of [
    [f.wallet],
    [f.recipient],
    [proxies[0], proxies[0]],
    [...proxies, proxies[0], f.wallet],
  ])
    expect(() =>
      validateFunding({
        ...f.plan.document,
        recipients: [{ address: f.recipient, amount: '0.01', proxies: bad }],
      }),
    ).toThrow();
  expect(() =>
    validateFunding({
      ...f.plan.document,
      currency: 'USDC',
      assetAddress: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      recipients: [{ address: f.recipient, amount: '1', proxies }],
    }),
  ).toThrow('native SOL');
  const plan = { ...f.plan, document };
  const leg2 = {
    ...f.review,
    wallet: proxies[0],
    recipient: proxies[1],
    amountRaw: '10100000',
  };
  const capture = await selectedFundingCapture(
    plan,
    { ...f.selection, leg: 2 },
    leg2,
    Date.now(),
  );
  expect(capture.leg).toBe(2);
  await expect(
    selectedFundingCapture(plan, f.selection, leg2),
  ).rejects.toThrow();
  await expect(
    selectedFundingCapture(plan, { ...f.selection, leg: 1 }, leg2),
  ).rejects.toThrow();
});
