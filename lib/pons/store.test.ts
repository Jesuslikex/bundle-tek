import { it, expect } from 'vitest';
import { PonsStore } from './store';
import { validateIntent } from './intent';
import { sample } from './testing';
// Real SQLite executes the production D1 SQL, including constraints and triggers.
import { sqliteD1 } from './testing';
it('durably deduplicates by owner/key, rejects mismatches and hides other owners', async () => {
  const db = sqliteD1();
  const store = new PonsStore(db);
  await store.ensure();
  const a = await store.create('alice', 'key-12345', validateIntent(sample));
  const b = await new PonsStore(db).create(
    'alice',
    'key-12345',
    validateIntent(sample),
  );
  expect(b.id).toBe(a.id);
  await expect(
    store.create(
      'alice',
      'key-12345',
      validateIntent({ ...sample, name: 'Other' }),
    ),
  ).rejects.toMatchObject({ status: 409 });
  await expect(store.get('bob', a.id)).rejects.toMatchObject({ status: 404 });
  expect((await store.events('alice', a.id)).length).toBe(1);
});

it('retains prior simulation results in atomic audit history across retries', async () => {
  const s = new PonsStore(sqliteD1());
  await s.ensure();
  const j = await s.create('a', 'audit-key', validateIntent(sample));
  const c = await s.claim('a', j.id, 0);
  const finished = await s.finish('a', j.id, c.revision, c.lease_token!, {
    ok: false,
    error: 'REVERT',
  });
  await s.claim('a', j.id, finished.revision);
  const events = await s.events('a', j.id);
  expect(events.find((e) => e.revision === 2)?.result).toBe(
    JSON.stringify({ ok: false, error: 'REVERT' }),
  );
});
