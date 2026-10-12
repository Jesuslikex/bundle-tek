import { expect, it } from 'vitest';
import bs58 from 'bs58';
import {
  validatedImportedAcquisition,
  type ImportedAcquisition,
} from './imported-acquisition';
const source: ImportedAcquisition = {
  projectId: '11111111-1111-4111-8111-111111111111',
  buyReceiptId: '22222222-2222-4222-8222-222222222222',
  buySignature: bs58.encode(new Uint8Array(64).fill(5)),
  buyPreparationSha256: 'a'.repeat(64),
  buyDocumentSha256: 'b'.repeat(64),
  wallet: bs58.encode(new Uint8Array(32).fill(7)),
  mint: bs58.encode(new Uint8Array(32).fill(3)),
  decimals: 6,
  acquiredRaw: '3',
  assignedBeforeRaw: '0',
  unitsRaw: '1',
  buyCostLamports: '101',
  allocatedCostLamports: '33',
  linkRevision: 0,
};
const context = (s = source) => ({
  projectId: s.projectId,
  wallet: s.wallet,
  mint: s.mint,
  unitsRaw: s.unitsRaw,
});
it('retains rounding residue in the final incremental allocation and exact u64-scale inputs', () => {
  expect(validatedImportedAcquisition(source, context())).toEqual(source);
  const remaining = {
    ...source,
    assignedBeforeRaw: '1',
    unitsRaw: '2',
    allocatedCostLamports: '68',
  };
  expect(validatedImportedAcquisition(remaining, context(remaining))).toEqual(
    remaining,
  );
  const max = (1n << 64n) - 1n;
  const large = {
    ...source,
    acquiredRaw: max.toString(),
    assignedBeforeRaw: (max - 1n).toString(),
    unitsRaw: '1',
    buyCostLamports: (max * 2n).toString(),
    allocatedCostLamports: '2',
  };
  expect(validatedImportedAcquisition(large, context(large))).toEqual(large);
});
it('rejects changed context, impossible capacity, malformed integers and incorrect basis', () => {
  for (const patch of [
    { wallet: bs58.encode(new Uint8Array(32).fill(8)) },
    { mint: bs58.encode(new Uint8Array(32).fill(8)) },
    { projectId: crypto.randomUUID() },
    { assignedBeforeRaw: '3' },
    { acquiredRaw: '0' },
    { unitsRaw: '0' },
    { unitsRaw: '01' },
    { buyCostLamports: '0' },
    { allocatedCostLamports: '34' },
    { linkRevision: -1 },
    { decimals: 256 },
    { buySignature: source.wallet },
    { buyDocumentSha256: 'wrong' },
    { acquiredRaw: '18446744073709551616' },
  ])
    expect(() =>
      validatedImportedAcquisition({ ...source, ...patch }, context()),
    ).toThrow();
});
