import { expect, it } from 'vitest';
import { jitoPerformanceFixture } from '../test/jito-performance-fixture';
import { jitoPerformanceCosts } from './jito-performance-costs';
import { createJitoFinalization } from './jito-finalization';

it('allocates exact tip and fee by packet order without losing residual lamports', async () => {
  const { f, row, receipts, proof } = await jitoPerformanceFixture();
  const result = (await jitoPerformanceCosts([row], receipts)).get(
    f.manifest.projectId,
  )!;
  const total = BigInt(proof.tipReceipt!.amountRaw) + 1n;
  expect(result).toMatchObject({
    bundleTipLamports: proof.tipReceipt!.amountRaw,
    bundleFeeLamports: '1',
    missingBundleCostCount: 0,
  });
  expect(result.executionCosts[receipts[0].id]).toBe(
    ((total + 1n) / 2n).toString(),
  );
  expect(result.executionCosts[receipts[1].id]).toBe((total / 2n).toString());
  expect(
    Object.values(result.executionCosts).reduce((n, v) => n + BigInt(v), 0n),
  ).toBe(total);
  expect(receipts.every((r) => r.document.networkFeeLamports === '1')).toBe(
    true,
  );
  for (const changed of [
    { ...row, id: crypto.randomUUID() },
    {
      ...row,
      finalizationDocument: JSON.stringify({ ...proof, slot: proof.slot + 1 }),
    },
    {
      ...row,
      packets: JSON.stringify([
        { packet: 0, signature: proof.signatures[0] },
        { packet: 0, signature: proof.signatures[0] },
      ]),
    },
  ])
    await expect(jitoPerformanceCosts([changed], receipts)).rejects.toThrow();
  await expect(
    jitoPerformanceCosts([row, { ...row, id: crypto.randomUUID() }], receipts),
  ).rejects.toThrow();
  await expect(
    jitoPerformanceCosts([row], receipts.slice(0, 1)),
  ).rejects.toThrow();
  await expect(
    jitoPerformanceCosts(
      [row],
      receipts.map((r) => ({ ...r, preparationId: crypto.randomUUID() })),
    ),
  ).rejects.toThrow();
});
it('does not invent costs for old or unreconciled bundles and ignores unlanded reviews', async () => {
  const { f, row, receipts, proof } = await jitoPerformanceFixture();
  const legacy = await createJitoFinalization(
    f.manifest,
    proof.signatures,
    proof.slot,
  );
  for (const changed of [
    { ...row, finalizationDocument: JSON.stringify(legacy) },
    { ...row, finalizationDocument: null },
    { ...row, state: 'submitting', finalizationDocument: null },
  ])
    expect(
      (await jitoPerformanceCosts([changed], receipts)).get(
        f.manifest.projectId,
      ),
    ).toEqual({
      executionCosts: {},
      bundleTipLamports: '0',
      bundleFeeLamports: '0',
      missingBundleCostCount: 1,
    });
  expect(
    (
      await jitoPerformanceCosts(
        [
          {
            ...row,
            state: 'reviewed',
            finalizationDocument: null,
            packets: '[]',
          },
        ],
        [],
      )
    ).size,
  ).toBe(0);
});
