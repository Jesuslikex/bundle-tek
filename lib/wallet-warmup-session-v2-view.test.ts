import { expect, it } from 'vitest';
import { warmupV2ClientFixture } from '@/test/warmup-session-v2-client-fixture';
import {
  warmupV2Preview,
  warmupV2Saved,
  warmupV2Journal,
  warmupV2AbsentControl,
  warmupV2Reminder,
  warmupV2ClientCanonical as canonical,
} from './wallet-warmup-session-v2-view';
import { walletWarmupSessionDigest as digest } from './wallet-warmup-session-digest';
it('admits exact v2 policy and immutable history without upgrading a v1 approval', async () => {
  const f = await warmupV2ClientFixture(),
    p = await warmupV2Preview(f.prepared, f.plan, f.view, f.retained, f.finish);
  expect(p.terms.policy.maxQualifications).toBe(
    f.view.review.actions.length * 3,
  );
  await expect(
    warmupV2Preview(
      await f.preview(f.finish),
      { ...f.plan, archived: true },
      f.view,
      f.retained,
      f.finish,
    ),
  ).rejects.toThrow();
  const old = f.saved();
  const bad = structuredClone(old) as unknown as {
    consent: { terms: { format: string }; termsSha256: string };
  };
  bad.consent.terms.format = 'wallet-warmup-session-consent-v1';
  bad.consent.termsSha256 = await digest(canonical(bad.consent.terms));
  await expect(
    warmupV2Saved(bad, { id: old.consent.id, planId: f.plan.id }),
  ).rejects.toThrow();
  const saved = await warmupV2Saved(f.consent, {
    id: f.consent.consent.id,
    planId: f.plan.id,
  });
  const j = await f.journal();
  expect(
    (await warmupV2Journal(j, saved, { id: j.journal.id })).snapshot
      .completedActions,
  ).toBe(0);
});
it.each(['maxQualifications', 'minimumGapMs', 'maxAttemptsPerAction'])(
  'rejects a rehashed changed %s policy',
  async (key) => {
    const f = await warmupV2ClientFixture(),
      value = structuredClone(f.prepared);
    (value.consentReview.terms.policy as Record<string, number>)[key]++;
    value.consentReview.termsSha256 = await digest(
      canonical(value.consentReview.terms),
    );
    await expect(
      warmupV2Preview(value, f.plan, f.view, f.retained, f.finish),
    ).rejects.toThrow();
  },
);
it.each([
  'signingAllowed',
  'qualificationAvailable',
  'completedActions',
  'walletBudget',
  'pendingAction',
  'head',
])('rejects forged journal %s', async (field) => {
  const f = await warmupV2ClientFixture(),
    saved = await warmupV2Saved(f.consent, {
      id: f.consent.consent.id,
      planId: f.plan.id,
    }),
    value = await f.journal();
  if (field === 'signingAllowed') value.journal.signingAllowed = true;
  if (field === 'qualificationAvailable')
    value.journal.qualificationAvailable = true;
  if (field === 'completedActions') value.journal.snapshot.completedActions = 1;
  if (field === 'walletBudget')
    value.journal.wallets[0].reviewedBuySpendLamports = '1';
  if (field === 'pendingAction')
    value.journal.snapshot.pendingReview = {
      ...f.view.review.actions[0],
      id: 'wrong',
    };
  if (field === 'head') value.journal.headSha256 = 'a'.repeat(64);
  await expect(
    warmupV2Journal(value, saved, { id: value.journal.id }),
  ).rejects.toThrow();
});
it('binds a confirmed command to its original ID, predecessor and canonical hash even after a later head', async () => {
  const f = await warmupV2ClientFixture(),
    saved = await warmupV2Saved(f.consent, {
      id: f.consent.consent.id,
      planId: f.plan.id,
    }),
    root = await f.journal();
  const command = {
    kind: 'control' as const,
    id: crypto.randomUUID(),
    journalId: root.journal.id,
    version: 0,
    headSha256: root.journal.headSha256,
    control: 'begin-review' as const,
  };
  const next = await f.control(root, command);
  expect(
    (
      await warmupV2Journal(next, saved, {
        id: root.journal.id,
        request: command,
      })
    ).version,
  ).toBe(1);
  await expect(
    warmupV2Journal(next, saved, {
      id: root.journal.id,
      request: { ...command, id: crypto.randomUUID() },
    }),
  ).rejects.toThrow();
  const bad = structuredClone(next);
  bad.journal.commandReceipt!.headSha256 = 'b'.repeat(64);
  await expect(
    warmupV2Journal(bad, saved, { id: root.journal.id, request: command }),
  ).rejects.toThrow();
  await expect(
    warmupV2Journal(root, saved, {
      id: root.journal.id,
      previous: await warmupV2Journal(next, saved, { id: root.journal.id }),
    }),
  ).rejects.toThrow();
});
it('refuses reminders from another plan or history instead of replacing original requests', async () => {
  const f = await warmupV2ClientFixture(),
    j = await f.journal();
  const marker = {
    format: 'wallet-warmup-v2-reminder-v1',
    planId: f.plan.id,
    consentId: f.consent.consent.id,
    termsSha256: f.consent.consent.termsSha256,
    journalId: j.journal.id,
    request: {
      kind: 'control',
      id: crypto.randomUUID(),
      journalId: j.journal.id,
      version: 0,
      headSha256: j.journal.headSha256,
      control: 'stop',
    },
  };
  expect(warmupV2Reminder(marker, f.plan.id)).toEqual(marker);
  expect(() => warmupV2Reminder(marker, 'other')).toThrow();
  expect(() =>
    warmupV2Reminder({ ...marker, journalId: crypto.randomUUID() }, f.plan.id),
  ).toThrow();
});
it('retires an absent control only after its predecessor is irreversibly consumed', async () => {
  const f = await warmupV2ClientFixture(),
    consent = await warmupV2Saved(f.consent, {
      id: f.consent.consent.id,
      planId: f.plan.id,
    }),
    root = await f.journal();
  const request = {
    kind: 'control' as const,
    id: crypto.randomUUID(),
    journalId: root.journal.id,
    version: 0,
    headSha256: root.journal.headSha256,
    control: 'begin-review' as const,
  };
  await expect(warmupV2AbsentControl(root, consent, request)).rejects.toThrow();
  const newer = await f.control(root, {
    id: crypto.randomUUID(),
    control: 'pause',
  });
  newer.journal.commandReceipt = null;
  expect((await warmupV2AbsentControl(newer, consent, request)).version).toBe(
    1,
  );
});
it.each(['stop', 'pause', 'resume', 'begin-review'] as const)(
  'refuses a %s receipt with a contradictory displayed state',
  async (control) => {
    const f = await warmupV2ClientFixture(),
      consent = await warmupV2Saved(f.consent, {
        id: f.consent.consent.id,
        planId: f.plan.id,
      }),
      root = await f.journal(),
      next = await f.control(root, { id: crypto.randomUUID(), control });
    if (control === 'stop') {
      next.journal.snapshot.stopped = false;
      next.journal.snapshot.phase = 'review-required';
    }
    if (control === 'pause') {
      next.journal.snapshot.paused = false;
      next.journal.snapshot.phase = 'review-required';
    }
    if (control === 'resume') {
      next.journal.snapshot.paused = true;
      next.journal.snapshot.phase = 'paused';
    }
    if (control === 'begin-review') {
      next.journal.snapshot.pendingReview = null;
      next.journal.snapshot.phase = 'review-required';
    }
    await expect(
      warmupV2Journal(next, consent, { id: root.journal.id }),
    ).rejects.toThrow();
  },
);
it('binds the separately approved pending Stop to the original control predecessor and keeps both IDs', async () => {
  const f = await warmupV2ClientFixture(),
    j = await f.journal();
  const marker = {
    format: 'wallet-warmup-v2-reminder-v1',
    planId: f.plan.id,
    consentId: f.consent.consent.id,
    termsSha256: f.consent.consent.termsSha256,
    journalId: j.journal.id,
    request: {
      kind: 'control',
      id: crypto.randomUUID(),
      journalId: j.journal.id,
      version: 0,
      headSha256: j.journal.headSha256,
      control: 'begin-review',
    },
    stopRequest: {
      kind: 'control',
      id: crypto.randomUUID(),
      journalId: j.journal.id,
      version: 0,
      headSha256: j.journal.headSha256,
      control: 'stop',
    },
  };
  expect(warmupV2Reminder(marker, f.plan.id)).toEqual(marker);
  expect(() =>
    warmupV2Reminder(
      { ...marker, stopRequest: { ...marker.stopRequest, version: 1 } },
      f.plan.id,
    ),
  ).toThrow();
  expect(() =>
    warmupV2Reminder(
      {
        ...marker,
        stopRequest: { ...marker.stopRequest, id: marker.request.id },
      },
      f.plan.id,
    ),
  ).toThrow();
});
