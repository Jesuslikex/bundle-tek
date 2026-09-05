import { it, expect } from 'vitest';
import { Miniflare } from 'miniflare';
import { PonsStore } from './store';
import { validateIntent } from './intent';
import { sample } from './testing';
it('runs schema/triggers/CAS on actual local D1, including concurrent idempotency', async () => {
  const mf = new Miniflare({
    telemetry: { enabled: false },
    workers: [
      {
        config: {
          name: 'test',
          type: 'worker',
          compatibilityDate: '2026-09-01',
          manifest: {
            mainModule: 'index.js',
            modules: {
              'index.js': {
                type: 'esm',
                contents:
                  'export default {fetch(){return new Response("test")}}',
              },
            },
          },
          env: { DB: { type: 'd1', id: 'pons-test-db' } },
        },
      },
    ],
  });
  try {
    const db = await mf.getD1Database('DB', 'test');
    const s = new PonsStore(db as unknown as D1Database);
    await s.ensure();
    const jobs = await Promise.all(
      Array.from({ length: 4 }, () =>
        s.create('alice', 'actual-d1-key', validateIntent(sample)),
      ),
    );
    expect(new Set(jobs.map((j) => j.id)).size).toBe(1);
    const j = jobs[0];
    const attempts = await Promise.allSettled([
      s.claim('alice', j.id, 0),
      s.claim('alice', j.id, 0),
    ]);
    expect(attempts.filter((a) => a.status === 'fulfilled')).toHaveLength(1);
    const c = await s.get('alice', j.id);
    await s.finish('alice', j.id, c.revision, c.lease_token!, {
      ok: false,
      error: 'TEST_REVERT',
    });
    expect((await s.events('alice', j.id)).length).toBe(3);
    await expect(
      db
        .prepare(
          "UPDATE pons_jobs SET intent='{}', revision=revision+1 WHERE id=?",
        )
        .bind(j.id)
        .run(),
    ).rejects.toThrow();
    expect(
      (await new PonsStore(db as unknown as D1Database).get('alice', j.id))
        .state,
    ).toBe('simulation_failed');
  } finally {
    await mf.dispose();
  }
}, 30000);
