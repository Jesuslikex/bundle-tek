import { expect, it } from 'vitest';
import { walletWarmupSessionView } from './wallet-warmup-session-view';
import { warmupSessionReviewFixture } from '../test/warmup-session-review-fixture';
const now = Date.parse('2026-10-20T12:00:00Z');
it('rebuilds the exact public view and tolerates JSON object key ordering', () => {
  const fixture = warmupSessionReviewFixture(now),
    body = fixture.response(now),
    plan = Object.fromEntries(
      Object.entries(fixture.plan).reverse(),
    ) as typeof fixture.plan;
  plan.document = Object.fromEntries(
    Object.entries(fixture.plan.document).reverse(),
  ) as typeof plan.document;
  body.review = Object.fromEntries(
    Object.entries(body.review).reverse(),
  ) as typeof body.review;
  const result = walletWarmupSessionView(body, plan, now);
  expect(result.review).toEqual(body.review);
  expect(result.deadline).toBe(now + 60000);
  expect(result.review.automaticExecutionAllowed).toBe(false);
});
it('caps local display lifetime at 60 seconds even if the server clock is ahead', () => {
  const fixture = warmupSessionReviewFixture(now);
  expect(
    walletWarmupSessionView(fixture.response(now + 30000), fixture.plan, now)
      .deadline,
  ).toBe(now + 60000);
});
it.each([
  'amount',
  'wallet',
  'authority',
  'action',
  'context',
  'expiry',
  'expired',
  'extra',
  'missing',
  'huge-context',
] as const)('refuses changed or unbound server view: %s', (kind) => {
  const fixture = warmupSessionReviewFixture(now),
    body = fixture.response(now);
  switch (kind) {
    case 'amount':
      body.review.wallets[0].maximumNativeSpendLamports = '999';
      break;
    case 'wallet':
      body.review.actions[0].wallet = 'other';
      break;
    case 'authority':
      Reflect.set(body.review, 'signingAllowed', true);
      break;
    case 'action':
      body.review.actions.pop();
      break;
    case 'context':
      body.review.contextKey = '[]';
      break;
    case 'expiry':
      body.reviewExpiresAt = new Date(now + 120000).toISOString();
      break;
    case 'expired':
      body.reviewExpiresAt = new Date(now).toISOString();
      break;
    case 'extra':
      Reflect.set(body, 'approve', true);
      break;
    case 'missing':
      Reflect.deleteProperty(body.review, 'executionAllowed');
      break;
    case 'huge-context':
      body.review.contextKey = 'x'.repeat(16 * 1024 * 1024 + 1);
      break;
  }
  expect(() => walletWarmupSessionView(body, fixture.plan, now)).toThrow(
    'fresh review',
  );
});
it.each(['revision', 'archive', 'wallet-revision', 'document'] as const)(
  'binds the current saved context: %s',
  (kind) => {
    const fixture = warmupSessionReviewFixture(now),
      body = fixture.response(now);
    if (kind === 'revision') fixture.plan.revision++;
    if (kind === 'archive') fixture.plan.archived = true;
    if (kind === 'wallet-revision')
      fixture.plan.document.walletRevisions[0].revision++;
    if (kind === 'document') fixture.plan.document.name = 'changed';
    expect(() => walletWarmupSessionView(body, fixture.plan, now)).toThrow(
      'fresh review',
    );
  },
);
