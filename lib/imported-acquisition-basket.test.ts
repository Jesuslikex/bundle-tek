import { expect, it } from 'vitest';
import {
  validatedImportedAcquisitionSelection,
  importedAcquisitionAllocations,
  importedAcquisitionCost,
} from './imported-acquisition';
import { acquisitionBasketFixture } from '../test/imported-acquisition-basket-fixture';
import { acquisitionId } from '../test/imported-sell-acquisition-fixture';
const context = (a = acquisitionBasketFixture()) => ({
  projectId: a.projectId,
  wallet: a.wallet,
  mint: a.mint,
  unitsRaw: a.unitsRaw,
});
it('validates all source evidence, exact total and incremental rounding residue', () => {
  const a = acquisitionBasketFixture();
  expect(validatedImportedAcquisitionSelection(a, context(a))).toEqual(a);
  expect(importedAcquisitionCost(a)).toBe('101');
  expect(a.allocations.map((p) => p.allocatedCostLamports)).toEqual([
    '68',
    '33',
  ]);
  expect(
    validatedImportedAcquisitionSelection(a, {
      ...context(a),
      projectId: undefined,
    }),
  ).toEqual(a);
  expect(
    validatedImportedAcquisitionSelection(a.allocations[0], {
      ...context(a),
      unitsRaw: '2',
    }),
  ).toEqual(a.allocations[0]);
});
it('canonicalizes requests and rejects duplicate, zero, noncanonical and mismatched totals', () => {
  const a = acquisitionBasketFixture(),
    parts = a.allocations.map(({ buyReceiptId, unitsRaw }) => ({
      buyReceiptId,
      unitsRaw,
    }));
  expect(importedAcquisitionAllocations([...parts].reverse(), '3')).toEqual(
    parts,
  );
  for (const p of [
    null,
    {},
    [],
    [parts[0]],
    [parts[0], parts[0]],
    [...parts, parts[0]],
    [parts[0], { ...parts[1], unitsRaw: '0' }],
    [parts[0], { ...parts[1], unitsRaw: '01' }],
    [parts[0], { ...parts[1], buyReceiptId: 'wrong' }],
    Array.from({ length: 9 }, (_, i) => ({
      buyReceiptId: acquisitionId(i + 10),
      unitsRaw: '1',
    })),
  ])
    expect(() => importedAcquisitionAllocations(p, '3')).toThrow();
  expect(() => importedAcquisitionAllocations(parts, '4')).toThrow();
});
it('rejects altered root and leaf metadata, reordered evidence and primitive inputs', () => {
  const a = acquisitionBasketFixture();
  for (const patch of [
    { kind: 'unknown' },
    { version: 2 },
    { projectId: acquisitionId(999) },
    { wallet: a.mint },
    { mint: a.wallet },
    { decimals: 256 },
    { linkRevision: -1 },
    { allocations: [...a.allocations].reverse() },
    { allocations: [a.allocations[0], a.allocations[0]] },
    ...[
      { decimals: 1 },
      { linkRevision: 2 },
      { wallet: a.mint },
      { allocatedCostLamports: '34' },
      { buyDocumentSha256: 'wrong' },
      { assignedBeforeRaw: '3' },
      { acquiredRaw: '0' },
    ].map((p) => ({
      allocations: [a.allocations[0], { ...a.allocations[1], ...p }],
    })),
  ])
    expect(() =>
      validatedImportedAcquisitionSelection({ ...a, ...patch }, context(a)),
    ).toThrow();
  for (const value of [
    null,
    1,
    'basket',
    [],
    { ...a, allocations: [null, a.allocations[1]] },
  ])
    expect(() =>
      validatedImportedAcquisitionSelection(value, context(a)),
    ).toThrow();
});
it('retains u64-scale precision and rejects a total overflow', () => {
  const max = (1n << 64n) - 1n,
    a = acquisitionBasketFixture();
  a.unitsRaw = max.toString();
  a.allocations = a.allocations.map((p, i) => ({
    ...p,
    acquiredRaw: max.toString(),
    assignedBeforeRaw: '0',
    unitsRaw: i === 0 ? (max - 1n).toString() : '1',
    buyCostLamports: max.toString(),
    allocatedCostLamports: i === 0 ? (max - 1n).toString() : '1',
  }));
  expect(validatedImportedAcquisitionSelection(a, context(a))).toEqual(a);
  expect(importedAcquisitionCost(a)).toBe(max.toString());
  expect(() =>
    importedAcquisitionAllocations(a.allocations, (max + 1n).toString()),
  ).toThrow();
});
