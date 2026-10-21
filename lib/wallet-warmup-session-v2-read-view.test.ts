import { expect, it } from 'vitest';
import { warmupReadClientFixture } from '@/test/warmup-session-v2-read-client-fixture';
import {
  warmupReadReminder,
  warmupReadView,
  recoverWarmupReadView,
  warmupReadPostResponse,
  warmupReadPage,
} from './wallet-warmup-session-v2-read-view';
it('keeps old reminders as previews and admits each mode only against its own original head', async () => {
  const f = await warmupReadClientFixture(),
    id = crypto.randomUUID();
  const legacy = {
    format: 'wallet-warmup-attempt-reminder-v2',
    id,
    journal: f.journal,
  };
  expect((await warmupReadReminder(legacy, f.consent)).mode).toBe('preview');
  for (const mode of ['preview', 'runtime'] as const) {
    const marker = await warmupReadReminder(
      {
        format: 'wallet-warmup-read-reminder-v1',
        id,
        journal: f.journal,
        mode,
      },
      f.consent,
    );
    for (const kind of ['prepared', 'refused', 'pending'] as const) {
      const value = f.readResponse(id, mode, kind);
      expect((await warmupReadView(value, marker, f.consent)).mode).toBe(mode);
      expect(
        (await recoverWarmupReadView(value, id, f.consent)).marker,
      ).toEqual(marker);
    }
    await expect(
      warmupReadView(
        f.readResponse(id, mode === 'runtime' ? 'preview' : 'runtime'),
        marker,
        f.consent,
      ),
    ).rejects.toThrow();
  }
});
it.each([
  'span',
  'packet',
  'expiry',
  'missing',
  'authority',
  'unknown',
  'mode',
  'trust',
] as const)('refuses a runtime response with changed %s', async (target) => {
  const f = await warmupReadClientFixture(),
    id = crypto.randomUUID(),
    value = f.readResponse(id, 'runtime');
  const marker = await warmupReadReminder(
    {
      format: 'wallet-warmup-read-reminder-v1',
      id,
      journal: f.journal,
      mode: 'runtime',
    },
    f.consent,
  );
  const v = value as unknown as {
    mode: string;
    runtime: Record<string, unknown> & {
      observation: Record<string, unknown> | null;
    };
  };
  if (target === 'span') v.runtime.observation!.maximumSlot = 133;
  if (target === 'packet') v.runtime.observation!.packetSha256 = 'd'.repeat(64);
  if (target === 'expiry')
    v.runtime.effectiveExpiresAt = value.attempt.outcome!.expiresAt;
  if (target === 'missing') v.runtime.observation = null;
  if (target === 'authority') v.runtime.signingAllowed = true;
  if (target === 'unknown') v.runtime.rawTransaction = 'private';
  if (target === 'mode') v.mode = 'preview';
  if (target === 'trust') v.runtime.programCodeAttested = true;
  await expect(warmupReadView(value, marker, f.consent)).rejects.toThrow();
});
it('never lets a POST response supply or replace its selected mode', async () => {
  const f = await warmupReadClientFixture(),
    id = crypto.randomUUID(),
    value = f.readResponse(id, 'runtime');
  const { mode: _mode, ...post } = value;
  expect(warmupReadPostResponse(post, 'runtime').mode).toBe('runtime');
  expect(() => warmupReadPostResponse(value, 'runtime')).toThrow();
  expect(() => warmupReadPostResponse(post, 'preview')).toThrow();
});
it('admits saved history modes while preserving original cursor and authority validation', async () => {
  const f = await warmupReadClientFixture(),
    id = crypto.randomUUID(),
    a = f.response(id).attempt;
  const value = {
    page: {
      format: 'wallet-warmup-read-page-v1',
      journalId: f.journal.id,
      termsSha256: f.consent.termsSha256,
      requests: [
        {
          id,
          mode: 'runtime',
          actionId: a.actionId,
          sequence: 1,
          attempt: 1,
          createdAt: a.createdAt,
          expiresAt: a.leaseExpiresAt,
        },
      ],
      nextBefore: null,
      executionAllowed: false,
      signingAllowed: false,
      automaticExecutionAllowed: false,
      instructionsVerified: false,
    },
  };
  expect(
    warmupReadPage(value, f.journal, f.consent, null).requests[0].mode,
  ).toBe('runtime');
  value.page.requests[0].mode = 'unknown';
  expect(() => warmupReadPage(value, f.journal, f.consent, null)).toThrow();
});
it('admits a real native provider/storage/public runtime result through the browser parser', async () => {
  const { warmupV2RuntimeFixture } =
    await import('@/test/warmup-session-v2-runtime-fixture');
  const { prepareWalletWarmupV2RuntimeAttempt, readWalletWarmupV2ReadAttempt } =
    await import('./wallet-warmup-session-v2-attempts');
  const { publicWalletWarmupV2Consent } =
    await import('./wallet-warmup-session-v2-public');
  const { warmupV2Saved } = await import('./wallet-warmup-session-v2-view');
  const f = await warmupV2RuntimeFixture(),
    signal = new AbortController().signal;
  try {
    const consent = await warmupV2Saved(
      {
        consent: await publicWalletWarmupV2Consent(
          f.db,
          'owner',
          f.v2Journal.consent,
          signal,
        ),
      },
      {
        id: f.v2Journal.consent.id,
        planId: f.v2Journal.manifest.planId,
        termsSha256: f.v2Journal.termsSha256,
      },
    );
    const input = f.selection();
    await prepareWalletWarmupV2RuntimeAttempt(
      f.db,
      'owner',
      input,
      true,
      signal,
      'synthetic-key',
      f.factory,
    );
    const dto = await readWalletWarmupV2ReadAttempt(
      f.db,
      'owner',
      input.id,
      signal,
    );
    const recovered = await recoverWarmupReadView(dto, input.id, consent);
    expect(recovered.view.mode).toBe('runtime');
    expect(recovered.view.runtime!.effectiveExpiresAt).toBeTruthy();
    expect(f.factory).toHaveBeenCalledOnce();
  } finally {
    f.client.close();
  }
});
