import { expect, it } from 'vitest';
import { warmupPreparationClientFixture } from '@/test/warmup-session-preparation-client-fixture';
import {
  warmupPreparationRequest as admit,
  warmupPreparationRequestBody,
} from './wallet-warmup-session-preparation-request';
import { warmupJournalView } from './wallet-warmup-session-journal-view';
const id = '00000000-0000-4000-8000-000000000005';
async function fixture() {
  const f = await warmupPreparationClientFixture();
  const marker = {
    format: 'warmup-preparation-request-v1',
    id,
    consentId: f.context.consentId,
    termsSha256: f.context.termsSha256,
    journal: { ...f.journal, commandReceipt: null },
  };
  return { ...f, marker };
}
it('retains the whole admitted original head and emits only the exact API request body', async () => {
  const f = await fixture(),
    m = await admit(f.marker, f.context);
  expect(m.journal.headSha256).toBe(f.journal.headSha256);
  expect(warmupPreparationRequestBody(m)).toEqual({
    id,
    journalId: f.journal.id,
    version: f.journal.version,
    headSha256: f.journal.headSha256,
    prepareRequested: true,
  });
});
it('retains collision guidance in v2 without sending it in the API body', async () => {
  const f = await fixture(),
    recoveryId = '00000000-0000-4000-8000-000000000009';
  const m = await admit(
    { ...f.marker, format: 'warmup-preparation-request-v2', recoveryId },
    f.context,
  );
  expect(m.recoveryId).toBe(recoveryId);
  expect(warmupPreparationRequestBody(m)).not.toHaveProperty('recoveryId');
  await expect(admit({ ...f.marker, recoveryId }, f.context)).rejects.toThrow(
    'original preparation reminder',
  );
});
it('checks the current action prefix without rejecting an older confirmed begin-review receipt', async () => {
  const f = await fixture(),
    bad = structuredClone(f.journal);
  bad.snapshot.completedActions = 1;
  await expect(
    warmupJournalView({ journal: bad }, f.context, {
      request: f.command,
      requireReceipt: true,
    }),
  ).rejects.toThrow('Saved session status');
  const later = structuredClone(bad),
    a = f.context.actions[1];
  later.version = 3;
  later.headSha256 = 'c'.repeat(64);
  later.snapshot.pending!.action = {
    id: a.id,
    side: a.side,
    cycle: a.cycle,
    wallet: a.wallet,
    walletRevision: a.walletRevision,
    mint: a.mint,
    scheduledAt: a.scheduledAt,
  };
  expect(
    (
      await warmupJournalView({ journal: later }, f.context, {
        request: f.command,
        requireReceipt: true,
      })
    ).commandReceipt?.id,
  ).toBe(f.command.id);
});
for (const key of ['consentId', 'termsSha256', 'id', 'format'])
  it(`refuses a changed marker ${key}`, async () => {
    const f = await fixture();
    await expect(
      admit({ ...f.marker, [key]: 'wrong' }, f.context),
    ).rejects.toThrow('original preparation reminder');
  });
it('refuses oversized, raw, stopped and unknown original heads', async () => {
  const f = await fixture();
  for (const value of [
    { ...f.marker, extra: 'x' },
    { ...f.marker, journal: { ...f.marker.journal, raw: 'x'.repeat(82000) } },
    {
      ...f.marker,
      journal: {
        ...f.marker.journal,
        snapshot: { ...f.journal.snapshot, stopped: true },
      },
    },
    {
      ...f.marker,
      journal: {
        ...f.marker.journal,
        snapshot: {
          ...f.journal.snapshot,
          pending: { ...f.journal.snapshot.pending, state: 'unknown' },
        },
      },
    },
  ])
    await expect(admit(value, f.context)).rejects.toThrow(
      'original preparation reminder',
    );
});
it('admits the exact begin-review receipt and rejects its action or predecessor changing', async () => {
  const f = await fixture();
  expect(
    (
      await warmupJournalView({ journal: f.journal }, f.context, {
        request: f.command,
        requireReceipt: true,
      })
    ).snapshot.pending?.state,
  ).toBe('reviewing');
  const changed = structuredClone(f.journal);
  changed.commandReceipt!.actionId = f.context.actions[1].id;
  await expect(
    warmupJournalView({ journal: changed }, f.context, {
      request: f.command,
      requireReceipt: true,
    }),
  ).rejects.toThrow('Saved session status');
  await expect(
    warmupJournalView({ journal: f.journal }, f.context, {
      request: { ...f.command, expectedHeadSha256: 'c'.repeat(64) },
      requireReceipt: true,
    }),
  ).rejects.toThrow('Saved session status');
});
