import { it, expect } from 'vitest';
import { sqliteD1 } from './testing';
import { PonsStore } from './store';
import { sample } from './testing';
import { validateIntent } from './intent';
it('CAS claims, recovers expired lease, prevents stale completion and audits transitions', async () => {
  const s = new PonsStore(sqliteD1());
  await s.ensure();
  const j = await s.create('a', 'lease-key', validateIntent(sample));
  const claim = await s.claim('a', j.id, 0, 1000);
  await expect(s.claim('a', j.id, 0, 1001)).rejects.toMatchObject({
    status: 409,
  });
  await expect(s.claim('a', j.id, 1, 1002)).rejects.toMatchObject({
    status: 409,
  });
  const recovered = await s.claim('a', j.id, 1, 122000);
  await expect(
    s.finish(
      'a',
      j.id,
      claim.revision,
      claim.lease_token!,
      { ok: true },
      122001,
    ),
  ).rejects.toMatchObject({ status: 409 });
  const done = await s.finish(
    'a',
    j.id,
    recovered.revision,
    recovered.lease_token!,
    { ok: false, error: 'REVERT' },
    122002,
  );
  expect(done.state).toBe('simulation_failed');
  expect(JSON.parse(done.result!).error).toBe('REVERT');
  expect((await s.events('a', j.id)).length).toBe(4);
});

it('never adopts another workers lease after a delayed claim response', async () => {
  const raw = sqliteD1();
  const s = new PonsStore(raw);
  await s.ensure();
  const j = await s.create('a', 'lease-race-key', validateIntent(sample));
  let release!: () => void;
  let reached!: () => void;
  const paused = new Promise<void>((r) => (release = r));
  const hit = new Promise<void>((r) => (reached = r));
  let intercept = true;
  const wrapped = {
    prepare(query: string) {
      const stmt = raw.prepare(query);
      if (query.includes("SET state='simulating'") && intercept) {
        intercept = false;
        const original = stmt.first.bind(stmt);
        stmt.first = (async () => {
          const row = await original();
          reached();
          await paused;
          return row;
        }) as typeof stmt.first;
      }
      return stmt;
    },
  };
  const a = new PonsStore(wrapped as D1Database);
  const pending = a.claim('a', j.id, 0, 1000);
  const rejected = expect(pending).rejects.toMatchObject({
    code: 'CLAIM_SUPERSEDED',
  });
  await hit;
  const b = await s.claim('a', j.id, 1, 122000);
  release();
  await rejected;
  const current = await s.get('a', j.id);
  expect(current.lease_token).toBe(b.lease_token);
  expect(current.result).toBeNull();
});
