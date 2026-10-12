import { expect, it } from 'vitest';
import { requireSessionApproval } from './trade-session-approval';
import { tradeSessionTerms, type TradeSession } from './imported-trade-session';
import type { ImportedApprovalRow } from './imported-approval-history';
import {
  acquisitionId as id,
  acquisitionWallet as wallet,
  acquisitionMint as mint,
} from '../test/imported-sell-acquisition-fixture';
async function fixture() {
  const terms = tradeSessionTerms(
    {
      projectId: id(1),
      projectRevision: 2,
      side: 'Buy',
      entries: [{ wallet, walletRevision: 3, amount: '0.001' }],
      schedule: { startAt: '2026-10-11T12:00:00.000Z', spacingSeconds: 30 },
    },
    { chain: 'Solana', address: mint, decimals: 6 },
  );
  const session: TradeSession = {
    id: id(2),
    revision: 1,
    state: 'active',
    terms,
    createdAt: '2026-10-11T11:00:00.000Z',
    updatedAt: '2026-10-11T11:00:00.000Z',
  };
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify(terms)),
  );
  const hash = Buffer.from(digest).toString('hex');
  const row = {
    id: id(3),
    projectId: id(1),
    projectRevision: 2,
    side: 'Buy',
    wallet,
    walletRevision: 3,
    document: {
      inputRaw: '1000000',
      outputMint: mint,
      session: {
        sessionId: id(2),
        sessionRevision: 1,
        entry: 1,
        unitsRaw: '1000000',
        termsSha256: hash,
        notBefore: terms.schedule!.startAt,
      },
    },
  } as ImportedApprovalRow;
  return { row, selection: { intentId: id(3), session, entry: 1 } };
}
it('matches the exact saved entry fingerprint and remains available after cancellation', async () => {
  const { row, selection } = await fixture();
  await expect(requireSessionApproval(row, selection)).resolves.toBeUndefined();
  await expect(
    requireSessionApproval(row, {
      ...selection,
      session: { ...selection.session, state: 'cancelled', revision: 2 },
    }),
  ).resolves.toBeUndefined();
});
it('rejects substituted approvals, wallets, entries, amounts, mint, fingerprint and timing', async () => {
  const { row, selection } = await fixture();
  for (const wrong of [
    { ...row, id: id(4) },
    { ...row, projectId: id(4) },
    { ...row, walletRevision: 4 },
    { ...row, side: 'Sell' as const },
    { ...row, document: { ...row.document, inputRaw: '999' } },
    { ...row, document: { ...row.document, outputMint: id(4) } },
    {
      ...row,
      document: {
        ...row.document,
        session: { ...row.document.session!, entry: 2 },
      },
    },
    {
      ...row,
      document: {
        ...row.document,
        session: { ...row.document.session!, termsSha256: '0'.repeat(64) },
      },
    },
    {
      ...row,
      document: {
        ...row.document,
        session: { ...row.document.session!, notBefore: undefined },
      },
    },
  ])
    await expect(requireSessionApproval(wrong, selection)).rejects.toThrow();
});
