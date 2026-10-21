import { expect, it } from 'vitest';
import { warmupPreparationClientFixture } from '@/test/warmup-session-preparation-client-fixture';
import { warmupPreparationRecoveryView as admit } from './wallet-warmup-session-preparation-recovery-view';
import {
  warmupPreparationRequest,
  warmupPreparationRequestBody,
} from './wallet-warmup-session-preparation-request';
const id = '00000000-0000-4000-8000-000000000007',
  prior = '00000000-0000-4000-8000-000000000008';
it('recovers the owned original context and retains a prior attempt only as read-only guidance', async () => {
  const f = await warmupPreparationClientFixture(),
    r = await admit(
      f.recovery(id),
      { id, journal: f.journal, priorRequestId: prior },
      f.context,
    );
  expect(r.request.id).toBe(id);
  expect(r.request.recovered).toBe(true);
  expect(r.request.priorRequestId).toBe(prior);
  expect(() => warmupPreparationRequestBody(r.request)).toThrow('read-only');
  expect(
    await warmupPreparationRequest(
      JSON.parse(JSON.stringify(r.request)),
      f.context,
    ),
  ).toEqual(r.request);
});
it('discovers only the currently pending action, not an arbitrary earlier owned preparation', async () => {
  const f = await warmupPreparationClientFixture();
  expect(
    (
      await admit(
        f.recovery(id),
        { discover: true, journal: f.journal },
        f.context,
      )
    ).request.id,
  ).toBe(id);
  const current = structuredClone(f.journal),
    a = f.context.actions[1];
  current.version++;
  current.headSha256 = 'c'.repeat(64);
  current.snapshot.completedActions = 1;
  current.snapshot.pending!.action = {
    id: a.id,
    side: a.side,
    cycle: a.cycle,
    wallet: a.wallet,
    walletRevision: a.walletRevision,
    mint: a.mint,
    scheduledAt: a.scheduledAt,
  };
  current.commandReceipt = null;
  await expect(
    admit(
      f.recovery(id, f.journal, current),
      { discover: true, journal: f.journal },
      f.context,
    ),
  ).rejects.toThrow('Saved recovery context');
  expect(
    (
      await admit(
        f.recovery(id, f.journal, current),
        { id, journal: f.journal },
        f.context,
      )
    ).request.id,
  ).toBe(id);
});
it('keeps the original head after the current session stops, without extending expiry', async () => {
  const f = await warmupPreparationClientFixture(),
    current = {
      ...(await f.apply(f.journal, {
        ...f.request(f.journal),
        control: 'stop',
      })),
      commandReceipt: null,
    };
  const r = await admit(
    f.recovery(id, f.journal, current),
    { id, journal: current },
    f.context,
  );
  expect(r.current.snapshot.stopped).toBe(true);
  expect(r.request.journal.snapshot.stopped).toBe(false);
  expect(r.request.journal.headSha256).toBe(f.journal.headSha256);
  expect(r.preparation.effectiveReviewExpiresAt).toBe(
    f.preparation(id).preparation.expiresAt,
  );
});
for (const field of [
  'readOnly',
  'preparation',
  'originalJournal',
  'currentJournal',
])
  it(`refuses missing recovery ${field}`, async () => {
    const f = await warmupPreparationClientFixture(),
      value: Record<string, unknown> = { ...f.recovery(id).recovery };
    delete value[field];
    await expect(
      admit({ recovery: value }, { id, journal: f.journal }, f.context),
    ).rejects.toThrow('Saved recovery context');
  });
it('rejects a foreign plan/journal, another ID and raw evidence fields', async () => {
  const f = await warmupPreparationClientFixture();
  for (const body of [
    { recovery: { ...f.recovery(id).recovery, readOnly: false } },
    {
      recovery: { ...f.recovery(id).recovery, unsignedTransaction: 'private' },
    },
    f.recovery(prior),
    {
      recovery: {
        ...f.recovery(id).recovery,
        originalJournal: { ...f.journal, id: prior, commandReceipt: null },
      },
    },
    {
      recovery: {
        ...f.recovery(id).recovery,
        currentJournal: {
          ...f.journal,
          termsSha256: 'c'.repeat(64),
          commandReceipt: null,
        },
      },
    },
  ])
    await expect(
      admit(body, { id, journal: f.journal }, f.context),
    ).rejects.toThrow('Saved recovery context');
});
it('does not accept an original prefix newer than the current history or a current history rollback', async () => {
  const f = await warmupPreparationClientFixture(),
    newer = {
      ...f.journal,
      version: 2,
      headSha256: 'c'.repeat(64),
      commandReceipt: null,
    };
  await expect(
    admit(
      f.recovery(id, newer, f.journal),
      { id, journal: f.journal },
      f.context,
    ),
  ).rejects.toThrow('Saved recovery context');
  await expect(
    admit(f.recovery(id), { id, journal: newer }, f.context),
  ).rejects.toThrow('Saved recovery context');
});
it('refuses a fake legacy recovered marker and a v3 marker with no read-only designation', async () => {
  const f = await warmupPreparationClientFixture(),
    r = await admit(f.recovery(id), { id, journal: f.journal }, f.context);
  await expect(
    warmupPreparationRequest(
      { ...r.request, format: 'warmup-preparation-request-v2' },
      f.context,
    ),
  ).rejects.toThrow();
  await expect(
    warmupPreparationRequest({ ...r.request, recovered: undefined }, f.context),
  ).rejects.toThrow();
});
