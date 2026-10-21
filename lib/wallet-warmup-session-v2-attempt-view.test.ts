import { expect, it } from 'vitest';
import { warmupV2AttemptClientFixture } from '@/test/warmup-session-v2-attempt-client-fixture';
import {
  warmupV2AttemptReminder,
  warmupV2AttemptView as admit,
  recoverWarmupV2AttemptView as recover,
  warmupV2AttemptPage as page,
} from './wallet-warmup-session-v2-attempt-view';
it('admits only the original head, exact action and false-authority unsigned preview, including expired recovery', async () => {
  const f = await warmupV2AttemptClientFixture(),
    id = crypto.randomUUID(),
    marker = await warmupV2AttemptReminder(
      { format: 'wallet-warmup-attempt-reminder-v2', id, journal: f.journal },
      f.consent,
    ),
    value = f.response(id);
  expect((await admit(value, marker, f.consent)).preview?.inAmountRaw).toBe(
    f.view.review.actions[0].side === 'Buy'
      ? f.view.review.actions[0].inputLamports
      : '',
  );
  expect((await recover(value, id, f.consent)).marker).toEqual(marker);
  expect(
    (await admit(f.response(id, 'pending'), marker, f.consent)).outcome,
  ).toBeNull();
  expect(
    (await admit(f.response(id, 'refused'), marker, f.consent)).preview,
  ).toBeNull();
});
it('admits saved-only discovery and refuses another journal, repeated IDs and looping cursors', async () => {
  const f = await warmupV2AttemptClientFixture(),
    id = crypto.randomUUID(),
    a = f.response(id).attempt;
  const value = {
    page: {
      format: 'wallet-warmup-attempt-page-v2',
      journalId: f.journal.id,
      termsSha256: f.consent.termsSha256,
      requests: [
        {
          id,
          actionId: a.actionId,
          sequence: 1,
          attempt: 1,
          createdAt: a.createdAt,
          expiresAt: a.leaseExpiresAt,
        },
      ],
      nextBefore: null as number | null,
      executionAllowed: false,
      signingAllowed: false,
      automaticExecutionAllowed: false,
      instructionsVerified: false,
    },
  };
  expect(page(value, f.journal, f.consent, null).requests[0].id).toBe(id);
  const duplicate = structuredClone(value);
  duplicate.page.requests.push({ ...duplicate.page.requests[0] });
  expect(() => page(duplicate, f.journal, f.consent, null)).toThrow();
  const other = structuredClone(value);
  other.page.journalId = crypto.randomUUID();
  expect(() => page(other, f.journal, f.consent, null)).toThrow();
  value.page.nextBefore = 1;
  expect(() => page(value, f.journal, f.consent, null)).toThrow();
});
it.each([
  'id',
  'head',
  'terms',
  'wallet',
  'amount',
  'fee',
  'output',
  'lifetime',
  'authority',
  'bytes',
  'historical-head',
] as const)('refuses changed %s evidence', async (change) => {
  const f = await warmupV2AttemptClientFixture(),
    id = crypto.randomUUID(),
    marker = await warmupV2AttemptReminder(
      { format: 'wallet-warmup-attempt-reminder-v2', id, journal: f.journal },
      f.consent,
    ),
    value = f.response(id);
  if (change === 'id') value.attempt.id = crypto.randomUUID();
  if (change === 'head') value.attempt.reviewHeadSha256 = 'c'.repeat(64);
  if (change === 'terms') value.attempt.termsSha256 = 'c'.repeat(64);
  if (change === 'wallet')
    value.attempt.preview!.wallet = '11111111111111111111111111111111';
  if (change === 'amount') value.attempt.preview!.inAmountRaw = '1';
  if (change === 'fee') value.attempt.preview!.feeUpperBoundLamports = '1';
  if (change === 'output') value.attempt.preview!.minimumOutRaw = '102';
  if (change === 'lifetime')
    value.attempt.leaseExpiresAt = new Date(f.at + 100000).toISOString();
  if (change === 'authority') value.attempt.signingAllowed = true;
  if (change === 'bytes')
    Object.assign(value.attempt, { unsigned_transaction: 'private bytes' });
  if (change === 'historical-head')
    value.attempt.originalHead.journal.headSha256 = 'c'.repeat(64);
  await expect(admit(value, marker, f.consent)).rejects.toThrow();
});
