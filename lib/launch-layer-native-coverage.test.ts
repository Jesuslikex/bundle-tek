import { expect, it } from 'vitest';
import { layerNativeFixture } from '../test/launch-layer-native-fixture';
import {
  layerNativeComparison,
  savedLayerSolObservation,
} from './launch-layer-native-coverage';
it('keeps integer-native amounts exact and combines only the same complete saved snapshot', async () => {
  const { plan, evidence } = await layerNativeFixture();
  const result = layerNativeComparison(evidence, plan, plan.envelope);
  expect(result.sameSnapshot).toBe(true);
  expect(result.observedTotalRaw).toBe(String(9007199254740993n * 7n));
  expect(result.rows[2].ceilingRaw).toBe('2106000');
  evidence.rows[2].observation!.raw = '1';
  expect(
    layerNativeComparison(evidence, plan, plan.envelope).rows[2].differenceRaw,
  ).toBe('-2105999');
  evidence.rows[2].observation!.slot++;
  expect(
    layerNativeComparison(evidence, plan, plan.envelope).observedTotalRaw,
  ).toBeNull();
  evidence.rows[2].observation = null;
  evidence.rows[2].issue = 'missing';
  expect(
    layerNativeComparison(evidence, plan, plan.envelope).rows[2].differenceRaw,
  ).toBeNull();
});
it('does not count stock-token buy ceilings as SOL or infer quote-token coverage', async () => {
  const { plan, evidence } = await layerNativeFixture(true);
  const result = layerNativeComparison(evidence, plan, plan.envelope);
  expect(result.rows[2]).toMatchObject({
    nativeBuyRaw: '0',
    buyQuoteRaw: '9007199254740993',
    ceilingRaw: '2105000',
  });
  expect(plan.envelope.terms.totals.maximumNativeBudgetLamports).toBe(
    '10525000',
  );
});
it('rejects foreign binding, missing/reordered/duplicate wallets and conflicting evidence', async () => {
  const { plan, evidence } = await layerNativeFixture();
  for (const change of [
    (v: typeof evidence) => {
      v.sha256 = 'b'.repeat(64);
    },
    (v: typeof evidence) => {
      v.signingAllowed = true as false;
    },
    (v: typeof evidence) => {
      v.rows.pop();
    },
    (v: typeof evidence) => {
      v.rows.reverse();
    },
    (v: typeof evidence) => {
      v.rows[1] = v.rows[0];
    },
    (v: typeof evidence) => {
      v.rows[0].issue = 'invalid';
    },
    (v: typeof evidence) => {
      v.rows[0].observation!.observedAt = '2026-10-18T04:00:00.000Z';
    },
  ]) {
    const copy = structuredClone(evidence);
    change(copy);
    expect(() => layerNativeComparison(copy, plan, plan.envelope)).toThrow();
  }
});
it('refuses malformed, future, rounded and mismatched saved balance records instead of inventing zero', async () => {
  const { plan, evidence, document } = await layerNativeFixture(),
    address = plan.envelope.terms.roles.funder.wallet.address;
  expect(
    savedLayerSolObservation(
      document(address, '0'),
      address,
      123,
      evidence.checkedAt,
    )?.raw,
  ).toBe('0');
  for (const bad of [
    { ...document(address), amount: '9007199.254740992' },
    { ...document(address), raw: '1e9' },
    { ...document(address), raw: '18446744073709551616' },
    {
      ...document(address),
      address: plan.envelope.terms.roles.front[0].wallet.address,
    },
    { ...document(address), blockNumber: 124 },
    { ...document(address), observedAt: '2026-10-18T04:00:00.000Z' },
    { ...document(address), source: 'https://rpc.example.test/secret' },
  ])
    expect(
      savedLayerSolObservation(bad, address, 123, evidence.checkedAt),
    ).toBeNull();
});
