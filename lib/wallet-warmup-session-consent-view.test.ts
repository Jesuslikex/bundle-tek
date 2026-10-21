import { beforeEach, afterEach, expect, it } from 'vitest';
import { warmupSessionConsentFixture } from '@/test/warmup-session-consent-fixture';
import { loadWalletWarmupProgress } from './wallet-warmup-progress-server';
import { reviewWalletWarmupSession } from './wallet-warmup-session-review';
import {
  walletWarmupSessionView,
  type WalletWarmupSessionView,
} from './wallet-warmup-session-view';
import {
  walletWarmupSessionRetainedView,
  type RetainedWarmupSessionSummary,
} from './wallet-warmup-session-retained-view';
import { retainWalletWarmupSessionConsent } from './wallet-warmup-session-consent';
import {
  warmupConsentPreview,
  warmupConsentSaved,
  warmupConsentSaveSelection,
  warmupConsentRecovery,
  readWarmupConsentResponse,
} from './wallet-warmup-session-consent-view';
let f: Awaited<ReturnType<typeof warmupSessionConsentFixture>>,
  view: WalletWarmupSessionView,
  retained: RetainedWarmupSessionSummary;
const signal = () => new AbortController().signal;
beforeEach(async () => {
  f = await warmupSessionConsentFixture();
  const current = await loadWalletWarmupProgress(
    f.db,
    'owner',
    f.plan.id,
    1,
    false,
    true,
  );
  const body = reviewWalletWarmupSession(
    current.plan,
    current.progress,
    current.performance,
    Date.parse(f.retainedReview.reviewedAt),
  );
  view = walletWarmupSessionView(
    { review: body, reviewExpiresAt: f.retainedReview.reviewExpiresAt },
    f.plan,
  );
  retained = await walletWarmupSessionRetainedView(
    { retainedReview: f.retainedReview },
    { id: f.retainedReview.id, planId: f.plan.id },
    view.review,
  );
});
afterEach(() => f?.client.close());
const previewBody = () => ({
  consentReview: { ...f.prepared, reviewCreatedAt: f.retainedReview.createdAt },
});
it('admits actual service terms, creates a minimal save identity and admits the real retained result', async () => {
  const checked = await warmupConsentPreview(
    previewBody(),
    f.plan,
    view,
    retained,
    f.input.sessionExpiresAt,
  );
  const marker = await warmupConsentSaveSelection(
    checked,
    f.plan,
    view,
    retained,
    f.input.sessionExpiresAt,
  );
  expect(warmupConsentRecovery(marker, f.plan.id)).toEqual(marker);
  expect(marker).not.toHaveProperty('reviewDocument');
  const { planId: _plan, ...selection } = marker;
  const consent = await retainWalletWarmupSessionConsent(
    f.db,
    'owner',
    selection,
    true,
    signal(),
  );
  const admitted = await warmupConsentSaved(
    { consent: { ...consent, reviewCreatedAt: f.retainedReview.createdAt } },
    marker,
    view.review,
  );
  expect(admitted.summary.actionCount).toBe(4);
  expect(admitted.terms.signingAllowed).toBe(false);
});
it.each([
  'hash',
  'deadline',
  'authority',
  'created',
  'extra',
  'raw',
  'source',
  'retained-id',
  'plan',
] as const)('refuses changed preview context: %s', async (kind) => {
  const data = structuredClone(previewBody()),
    plan = structuredClone(f.plan),
    saved = structuredClone(retained);
  if (kind === 'hash') data.consentReview.termsSha256 = 'a'.repeat(64);
  if (kind === 'deadline')
    data.consentReview.terms.sessionExpiresAt = new Date(
      Date.parse(f.input.sessionExpiresAt) + 1,
    ).toISOString();
  if (kind === 'authority')
    Reflect.set(data.consentReview.terms, 'signingAllowed', true);
  if (kind === 'created')
    data.consentReview.reviewCreatedAt = new Date(
      Date.parse(view.reviewExpiresAt) + 1,
    ).toISOString();
  if (kind === 'extra') Reflect.set(data, 'start', true);
  if (kind === 'raw')
    data.consentReview.terms.reviewDocument = '<html>untrusted</html>';
  if (kind === 'source') data.consentReview.terms.reviewSha256 = 'b'.repeat(64);
  if (kind === 'retained-id') saved.id = crypto.randomUUID();
  if (kind === 'plan') plan.revision++;
  await expect(
    warmupConsentPreview(data, plan, view, saved, f.input.sessionExpiresAt),
  ).rejects.toThrow('response differs');
});
it('does not renew a stricter original display deadline and rechecks expiry after asynchronous hashing', async () => {
  const now = Date.now();
  view.deadline = now + 100;
  const checked = await warmupConsentPreview(
    previewBody(),
    f.plan,
    view,
    retained,
    f.input.sessionExpiresAt,
    now,
  );
  expect(checked.deadline).toBe(view.deadline);
  let reads = 0;
  await expect(
    warmupConsentSaveSelection(
      checked,
      f.plan,
      view,
      retained,
      f.input.sessionExpiresAt,
      () => (reads++ ? now + 101 : now),
    ),
  ).rejects.toThrow();
});
it('recovers historical consent without treating it as a fresh preview', async () => {
  const consent = await retainWalletWarmupSessionConsent(
    f.db,
    'owner',
    f.input,
    true,
    signal(),
  );
  expect(
    (
      await warmupConsentSaved(
        {
          consent: { ...consent, reviewCreatedAt: f.retainedReview.createdAt },
        },
        { id: consent.id, planId: f.plan.id },
      )
    ).id,
  ).toBe(consent.id);
  await expect(
    warmupConsentPreview(
      previewBody(),
      f.plan,
      view,
      retained,
      f.input.sessionExpiresAt,
      Date.parse(view.reviewExpiresAt),
    ),
  ).rejects.toThrow();
});
it.each(['id', 'owner-plan', 'hash', 'time', 'authority'] as const)(
  'refuses changed saved response binding: %s',
  async (kind) => {
    const consent = await retainWalletWarmupSessionConsent(
        f.db,
        'owner',
        f.input,
        true,
        signal(),
      ),
      data = {
        consent: { ...consent, reviewCreatedAt: f.retainedReview.createdAt },
      },
      expected = { id: consent.id, planId: f.plan.id };
    if (kind === 'id') data.consent.id = crypto.randomUUID();
    if (kind === 'owner-plan') expected.planId = 'other';
    if (kind === 'hash') data.consent.termsSha256 = 'c'.repeat(64);
    if (kind === 'time') data.consent.createdAt = view.reviewExpiresAt;
    if (kind === 'authority')
      Reflect.set(data.consent.terms, 'automaticExecutionAllowed', true);
    await expect(warmupConsentSaved(data, expected)).rejects.toThrow(
      'response differs',
    );
  },
);
it('refuses expanded or foreign local reminders', () => {
  const marker = { ...f.input, planId: f.plan.id };
  expect(warmupConsentRecovery(marker, f.plan.id)).toEqual(marker);
  expect(() =>
    warmupConsentRecovery({ ...marker, password: 'private' }, f.plan.id),
  ).toThrow();
  expect(() => warmupConsentRecovery(marker, 'other')).toThrow();
});
it('reads bounded JSON and refuses HTML, oversized UTF-8 or malformed bodies without parser text', async () => {
  expect(
    await readWarmupConsentResponse(Response.json({ ok: true }), signal()),
  ).toEqual({ ok: true });
  await expect(
    readWarmupConsentResponse(
      new Response('<html>secret', {
        headers: { 'content-type': 'text/html' },
      }),
      signal(),
    ),
  ).rejects.toThrow('response differs');
  await expect(
    readWarmupConsentResponse(
      new Response('{oops', {
        headers: { 'content-type': 'application/json' },
      }),
      signal(),
    ),
  ).rejects.toThrow('response differs');
  await expect(
    readWarmupConsentResponse(
      new Response(JSON.stringify({ value: 'é'.repeat(1600000) }), {
        headers: { 'content-type': 'application/json' },
      }),
      signal(),
    ),
  ).rejects.toThrow('response differs');
});
it('cancels a response body stalled after headers', async () => {
  let cancelled = false;
  const c = new AbortController(),
    response = new Response(
      new ReadableStream({
        pull() {
          return new Promise(() => {});
        },
        cancel() {
          cancelled = true;
        },
      }),
      { headers: { 'content-type': 'application/json' } },
    );
  const reading = readWarmupConsentResponse(response, c.signal);
  c.abort();
  await expect(reading).rejects.toThrow();
  expect(cancelled).toBe(true);
});
