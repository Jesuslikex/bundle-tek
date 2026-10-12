import { beforeAll, expect, it } from 'vitest';
import { nativeWarmupFixture } from '../test/warmup-native-fixture';
import {
  importedApprovalPage,
  canSubmitImportedApproval,
  matchingImportedReceipt,
  type ImportedApprovalRow,
} from './imported-approval-history';
import { restoreRegisteredWarmupPacket } from './warmup-approval-history';
let row: ImportedApprovalRow;
let fixture: Awaited<ReturnType<typeof nativeWarmupFixture>>;
const project = {
  id: '11111111-1111-4111-8111-111111111111',
  revision: 1,
  archived: false,
};
beforeAll(async () => {
  fixture = await nativeWarmupFixture({ lookup: true, v2: true });
  const review = {
    id: crypto.randomUUID(),
    preparationId: crypto.randomUUID(),
    wallet: fixture.wallet,
    network: 'mainnet' as const,
    sha256: fixture.order.preparation.sha256,
    transaction: fixture.order.preparation.transaction,
    expiresAt: fixture.order.expiresAt,
    maximumFeeLamports: fixture.simulation.networkFeeLamports,
    inputRaw: fixture.order.inAmount,
    minimumOutputRaw: fixture.order.minimumOutAmount,
    inputMint: fixture.order.inputMint,
    outputMint: fixture.order.outputMint,
    lastValidBlockHeight: fixture.order.preparation.lastValidBlockHeight,
  };
  row = {
    id: review.id,
    preparationId: review.preparationId,
    projectId: project.id,
    projectRevision: 1,
    walletRevision: 1,
    wallet: fixture.wallet,
    side: 'Buy',
    state: 'signed',
    signature: fixture.signed.signature,
    document: review,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
});
it('restores only the exact public registered signature without wallet access', async () => {
  const page = importedApprovalPage(
    { projectId: project.id, intents: [row], nextCursor: null },
    project.id,
  );
  expect(
    (
      await restoreRegisteredWarmupPacket(
        page.intents[0].document,
        page.intents[0].signature!,
      )
    ).transaction,
  ).toBe(fixture.signed.transaction);
  await expect(
    restoreRegisteredWarmupPacket(
      { ...row.document, sha256: 'a'.repeat(64) },
      row.signature!,
    ),
  ).rejects.toThrow('changed');
});
it('keeps archived, stale, expired, submitted and uncertain approvals available for recovery but disables submission', () => {
  const now = Date.parse(row.document.expiresAt) - 1;
  expect(canSubmitImportedApproval(row, project, now)).toBe(true);
  expect(
    canSubmitImportedApproval(row, { ...project, archived: true }, now),
  ).toBe(false);
  expect(canSubmitImportedApproval(row, { ...project, revision: 2 }, now)).toBe(
    false,
  );
  expect(
    canSubmitImportedApproval(row, project, Date.parse(row.document.expiresAt)),
  ).toBe(false);
  expect(
    canSubmitImportedApproval({ ...row, state: 'submitted' }, project, now),
  ).toBe(false);
  expect(canSubmitImportedApproval(row, project, now, true)).toBe(false);
  expect(
    canSubmitImportedApproval(
      row,
      { ...project, id: crypto.randomUUID() },
      now,
    ),
  ).toBe(false);
});
it('rejects cross-project pages, conflicting identities, invalid states, missing signatures and foreign cursors', () => {
  const valid = { projectId: project.id, intents: [row], nextCursor: null };
  for (const invalid of [
    { ...valid, projectId: crypto.randomUUID() },
    { ...valid, nextCursor: 'invalid' },
    { ...valid, intents: [row, row] },
    { ...valid, intents: [{ ...row, projectRevision: 0 }] },
    { ...valid, intents: [{ ...row, state: 'unknown' }] },
    { ...valid, intents: [{ ...row, signature: null }] },
    {
      ...valid,
      intents: [{ ...row, document: { ...row.document, wallet: 'foreign' } }],
    },
  ])
    expect(() => importedApprovalPage(invalid, project.id)).toThrow();
});
it('requires exact finalized receipt context and positive uint64 token units', () => {
  const receipt = {
    id: crypto.randomUUID(),
    projectId: row.projectId,
    preparationId: row.preparationId,
    projectRevision: 1,
    walletRevision: 1,
    createdAt: row.createdAt,
    document: {
      network: 'mainnet',
      mint: fixture.mint,
      decimals: 6,
      preparationSha256: row.document.sha256,
      signature: row.signature,
      wallet: row.wallet,
      side: row.side,
      signatureVerified: true,
      commitment: 'finalized',
      tokenUnitsRaw: '18446744073709551615',
      source: 'fixture.test',
      observedAt: row.createdAt,
    },
  };
  expect(matchingImportedReceipt(receipt, row)).toEqual(receipt);
  for (const invalid of [
    { ...receipt, projectId: crypto.randomUUID() },
    { ...receipt, walletRevision: 2 },
    { ...receipt, document: { ...receipt.document, side: 'Sell' } },
    { ...receipt, document: { ...receipt.document, signatureVerified: false } },
    { ...receipt, document: { ...receipt.document, commitment: 'confirmed' } },
    { ...receipt, document: { ...receipt.document, mint: fixture.wallet } },
    { ...receipt, document: { ...receipt.document, network: 'devnet' } },
    {
      ...receipt,
      document: { ...receipt.document, preparationSha256: 'a'.repeat(64) },
    },
    { ...receipt, document: { ...receipt.document, tokenUnitsRaw: '0' } },
    {
      ...receipt,
      document: { ...receipt.document, tokenUnitsRaw: '18446744073709551616' },
    },
  ])
    expect(() => matchingImportedReceipt(invalid, row)).toThrow();
});
