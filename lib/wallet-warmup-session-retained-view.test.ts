import { expect, it } from 'vitest';
import { warmupSessionReviewFixture } from '../test/warmup-session-review-fixture';
import { walletWarmupSessionView } from './wallet-warmup-session-view';
import {
  walletWarmupSessionSaveSelection,
  walletWarmupSessionRetainedView,
  walletWarmupSessionRecovery,
} from './wallet-warmup-session-retained-view';
const at = Date.parse('2026-10-20T12:00:00Z');
async function fixture() {
  const source = warmupSessionReviewFixture(at),
    response = source.response(at),
    view = walletWarmupSessionView(response, source.plan, at),
    selection = await walletWarmupSessionSaveSelection(view, source.plan, at),
    { contextKey: _contextKey, ...document } = view.review;
  return {
    ...source,
    view,
    selection,
    body: {
      retainedReview: {
        id: selection.id,
        planId: selection.planId,
        planRevision: selection.revision,
        reviewSha256: selection.reviewSha256,
        reviewedAt: selection.reviewedAt,
        reviewExpiresAt: response.reviewExpiresAt,
        createdAt: new Date(at + 1000).toISOString(),
        document,
      },
    },
  };
}
it('creates a canonical minimal recovery selection and exactly admits the saved review', async () => {
  const f = await fixture();
  expect(walletWarmupSessionRecovery(f.selection, f.plan.id)).toEqual(
    f.selection,
  );
  expect(
    await walletWarmupSessionRetainedView(f.body, f.selection, f.view.review),
  ).toMatchObject({
    id: f.selection.id,
    walletCount: 1,
    actionCount: 4,
    maximumNativeSpendLamports: '12000000',
  });
});
it('allows historical recovery after review expiry without turning it into a fresh review', async () => {
  const f = await fixture();
  expect(
    await walletWarmupSessionRetainedView(f.body, {
      id: f.selection.id,
      planId: f.plan.id,
    }),
  ).toMatchObject({ reviewExpiresAt: new Date(at + 60000).toISOString() });
  await expect(
    walletWarmupSessionSaveSelection(f.view, f.plan, at + 60000),
  ).rejects.toThrow();
  await expect(
    walletWarmupSessionSaveSelection(f.view, { ...f.plan, archived: true }, at),
  ).rejects.toThrow();
});
it.each([
  'owner-plan',
  'id',
  'revision',
  'hash',
  'date',
  'extra',
  'authority',
  'budget',
  'duplicate-wallet',
  'dependency',
  'extra-context',
] as const)(
  'refuses malformed or changed retained responses: %s',
  async (kind) => {
    const f = await fixture(),
      row = f.body.retainedReview,
      doc = row.document;
    if (kind === 'owner-plan') row.planId = 'other';
    if (kind === 'id') row.id = crypto.randomUUID();
    if (kind === 'revision') row.planRevision = 2;
    if (kind === 'hash') row.reviewSha256 = '0'.repeat(64);
    if (kind === 'date') row.createdAt = new Date(at + 61000).toISOString();
    if (kind === 'extra') (f.body as Record<string, unknown>).extra = true;
    if (kind === 'authority') Object.assign(doc, { signingAllowed: true });
    if (kind === 'budget') doc.totalMaximumNativeSpendLamports = '0';
    if (kind === 'duplicate-wallet')
      doc.wallets.push(structuredClone(doc.wallets[0]));
    if (kind === 'dependency')
      Object.assign(doc.actions[1], {
        source: { kind: 'session-buy', actionId: 'missing' },
      });
    if (kind === 'extra-context')
      Object.assign(doc, { contextKey: 'untrusted' });
    await expect(
      walletWarmupSessionRetainedView(f.body, f.selection, f.view.review),
    ).rejects.toThrow();
  },
);
it('checks the full original review on save rather than trusting matching summary totals', async () => {
  const f = await fixture();
  Object.assign(f.body.retainedReview.document.actions[0], {
    inputLamports: '1',
  });
  await expect(
    walletWarmupSessionRetainedView(f.body, f.selection, f.view.review),
  ).rejects.toThrow();
});
it('rejects mismatched or expanded local recovery reminders', async () => {
  const f = await fixture();
  expect(() =>
    walletWarmupSessionRecovery({ ...f.selection, extra: true }, f.plan.id),
  ).toThrow();
  expect(() => walletWarmupSessionRecovery(f.selection, 'other')).toThrow();
  expect(() =>
    walletWarmupSessionRecovery(
      { ...f.selection, reviewedAt: 'bad' },
      f.plan.id,
    ),
  ).toThrow();
});
