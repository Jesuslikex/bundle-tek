import { expect, it } from 'vitest';
import {
  planVolumeBundles,
  requireVolumeBundlePlan,
  type VolumeBundleTerms,
} from './volume-bundle-plan';
import { parseVolumeBotRequest } from './volume-bot-request';
const seed = '0123456789abcdef0123456789abcdef';
export const bundleTerms: VolumeBundleTerms = {
  targetVolumeLamports: '1000000000',
  buyLamports: '50000000',
  durationSeconds: 1800,
  delayMinMs: 5000,
  delayMaxMs: 20000,
  tipBudgetLamports: '1000003',
  wallets: [
    '11111111111111111111111111111111',
    'So11111111111111111111111111111111111111112',
  ],
};
it('keeps both ordered legs on one wallet and budgets once per bundle', () => {
  const p = planVolumeBundles(bundleTerms, seed);
  expect(p).toEqual(planVolumeBundles(bundleTerms, seed));
  expect(p.rounds).toHaveLength(10);
  expect(
    p.rounds.every(
      (r) =>
        r.orderedLegs.join(',') === 'Buy,Sell' &&
        r.sellSource === 'this-round-buy-output-only',
    ),
  ).toBe(true);
  expect(p.rounds.map((r) => r.wallet)).toEqual(
    Array.from({ length: 10 }, (_, i) => bundleTerms.wallets[i % 2]),
  );
  expect(p.estimate).toMatchObject({
    allocatedTipCapLamports: '1000000',
    unallocatedTipLamports: '3',
    nominalVolumeLamports: '1000000000',
  });
  expect(p.signingAllowed).toBe(false);
  expect(p.executionAllowed).toBe(false);
  expect(requireVolumeBundlePlan(p)).toEqual(p);
});
it.each([
  { tipBudgetLamports: '9999' },
  { tipBudgetLamports: '100000010' },
  { buyLamports: '999999' },
  { durationSeconds: 0 },
  { delayMinMs: 0 },
  { delayMaxMs: 4999 },
  { wallets: [] },
  { wallets: [bundleTerms.wallets[0], bundleTerms.wallets[0]] },
  { wallets: ['not-a-wallet'] },
  { targetVolumeLamports: '9999999999999999999' },
  { buyLamports: '1e9' },
])('refuses unsafe terms %j', (changed) =>
  expect(() =>
    planVolumeBundles({ ...bundleTerms, ...changed }, seed),
  ).toThrow(),
);
it('rejects impossible duration, unknown fields, tampered plans and invalid seeds', () => {
  expect(() =>
    planVolumeBundles(
      { ...bundleTerms, durationSeconds: 60, delayMinMs: 20000 },
      seed,
    ),
  ).toThrow(/seconds/);
  expect(() =>
    planVolumeBundles(
      { ...bundleTerms, wave: 'tight' } as VolumeBundleTerms,
      seed,
    ),
  ).toThrow(/unknown/);
  const p = planVolumeBundles(bundleTerms, seed);
  p.rounds[0].tipCapLamports = '1000000';
  expect(() => requireVolumeBundlePlan(p)).toThrow(/changed/);
  expect(() => planVolumeBundles(bundleTerms, 'bad')).toThrow(/seed/);
});
it('ceil-rounds the volume target and does not mutate caller terms', () => {
  const terms = { ...bundleTerms, targetVolumeLamports: '1000000001' };
  const p = planVolumeBundles(terms, seed);
  expect(p.rounds).toHaveLength(11);
  expect(p.estimate.nominalVolumeLamports).toBe('1100000000');
  p.terms.wallets[0] = 'changed';
  expect(terms.wallets[0]).toBe(bundleTerms.wallets[0]);
});
it('cannot enter the scheduled execution API as a bundle or disguised scheduled request', () => {
  const p = planVolumeBundles(bundleTerms, seed);
  const request = {
    action: 'create',
    projectId: '00000000-0000-4000-8000-000000000001',
    projectRevision: 1,
    terms: p.terms,
    seed,
  };
  expect(() => parseVolumeBotRequest(request)).toThrow();
  expect(() =>
    parseVolumeBotRequest({ ...request, action: 'create-bundle' }),
  ).toThrow();
});
