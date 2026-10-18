import { beforeAll, expect, it } from 'vitest';
import { accountLaunchPurchasesFixture } from '../test/account-launch-purchases-fixture';
import {
  validatedLaunchPurchaseView,
  validatedLaunchPurchaseHistory,
  launchPurchaseDigest,
} from './account-launch-purchases';
import { pumpHolderDigest } from './pump-holder-review';
let f: Awaited<ReturnType<typeof accountLaunchPurchasesFixture>>;
beforeAll(async () => {
  f = await accountLaunchPurchasesFixture();
});
it('accepts exact preview/saved/history contracts and matches the server canonical digest', async () => {
  expect(await validatedLaunchPurchaseView(f.view, f.context)).toEqual(f.view);
  expect(await validatedLaunchPurchaseView(f.saved, f.context)).toEqual(
    f.saved,
  );
  expect(await validatedLaunchPurchaseHistory(f.history, f.context)).toEqual(
    f.history,
  );
  expect(await launchPurchaseDigest(f.view.plan)).toBe(
    await pumpHolderDigest(f.view.plan),
  );
});
it('keeps token quotes separate from native execution amounts', async () => {
  const t = await accountLaunchPurchasesFixture(true);
  expect(
    (await validatedLaunchPurchaseView(t.view, t.context)).plan.sources[0]
      .nativeTradeCostExcludingSetupLamports,
  ).toBeNull();
});
it.each(['mint', 'receiptId', 'receiptSha256', 'reviewId'] as const)(
  'rejects a different selected %s',
  async (field) => {
    await expect(
      validatedLaunchPurchaseView(f.view, {
        ...f.context,
        [field]: '0'.repeat(64),
      }),
    ).rejects.toThrow();
  },
);
it.each([
  'hash',
  'cost',
  'authority',
  'extra',
  'duplicate',
  'unknown',
  'coverage',
  'saved',
] as const)('rejects tampered %s before approval', async (mode) => {
  const v = structuredClone(f.view);
  if (mode === 'hash') v.plan.sha256 = '0'.repeat(64);
  if (mode === 'cost') v.plan.sources[0].executionCostLamports = '1';
  if (mode === 'authority') Object.assign(v.plan, { executionAllowed: true });
  if (mode === 'extra') Object.assign(v.plan, { transaction: 'not allowed' });
  if (mode === 'duplicate') v.plan.sources.push(v.plan.sources[0]);
  if (mode === 'unknown') v.plan.unknownFeePackets = [0];
  if (mode === 'coverage') v.plan.knownPacketFeesLamports = '5001';
  if (mode === 'saved') v.saved = true;
  await expect(validatedLaunchPurchaseView(v, f.context)).rejects.toThrow();
});
it('rejects self-rehashed arithmetic, origin, permission and duplicate history defects', async () => {
  for (const mode of [
    'arithmetic',
    'origin',
    'precision',
    'authority',
    'duplicate',
  ]) {
    const h = structuredClone(f.history),
      s = h.sources[0];
    if (mode === 'arithmetic') s.executionCostLamports = '1';
    if (mode === 'origin') s.originId = '0'.repeat(64);
    if (mode === 'precision') s.quoteDecimals = 6;
    if (mode === 'authority')
      Object.assign(s, { acquisitionBasisVerified: true });
    if (mode === 'duplicate') h.sources.push(s);
    const { sha256: _sha, ...core } = s;
    s.sha256 = await launchPurchaseDigest(core);
    await expect(
      validatedLaunchPurchaseHistory(h, f.context),
    ).rejects.toThrow();
  }
});
