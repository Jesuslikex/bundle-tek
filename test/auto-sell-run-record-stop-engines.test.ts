import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createClient } from '@libsql/client';
import { Miniflare } from 'miniflare';
import { createTursoDatabase } from '../db/turso';
import {
  initializeAutoSellRunStorageFixture,
  setupAutoSellRunStorageFixture,
  autoSellRunAttemptFixture,
} from './auto-sell-run-storage-fixture';
import {
  createOwnedAutoSellRun,
  reserveOwnedAutoSellAttempt,
  stopOwnedAutoSellRun,
  readOwnedAutoSellAttempts,
} from '../lib/auto-sell-run-storage';
import {
  stopOwnedAutoSellRunRecord,
  readOwnedAutoSellRunRecordStop,
} from '../lib/auto-sell-run-record-stop-storage';
const signal = () => new AbortController().signal;
async function exercise(db: D1Database) {
  await initializeAutoSellRunStorageFixture(db);
  for (const sql of readFileSync(
    'drizzle/0155_auto_sell_run_record_stops.sql',
    'utf8',
  ).split('--> statement-breakpoint'))
    await db.prepare(sql).run();
  const f = await setupAutoSellRunStorageFixture(db);
  const request = (runId: string) => ({
    runId,
    projectId: f.projectId,
    profileSaveId: f.profileSaveId,
    profileSha256: f.profileSha256,
    consent: 'stop-original-run-record-v1' as const,
  });
  const fenced = await stopOwnedAutoSellRunRecord(
    db,
    f.owner,
    request(f.createInput.id),
    signal(),
  );
  expect(fenced.stop?.status).toBe('creation-fenced');
  await expect(
    createOwnedAutoSellRun(db, f.owner, f.createInput, signal()),
  ).rejects.toMatchObject({ status: 409 });
  const run = await createOwnedAutoSellRun(
    db,
    f.owner,
    { ...f.createInput, id: crypto.randomUUID() },
    signal(),
  );
  const activeRaceId = crypto.randomUUID();
  const activeRace = await Promise.allSettled([
    createOwnedAutoSellRun(
      db,
      f.owner,
      { ...f.createInput, id: activeRaceId },
      signal(),
    ),
    stopOwnedAutoSellRunRecord(db, f.owner, request(activeRaceId), signal()),
  ]);
  expect(activeRace[1].status).toBe('fulfilled');
  expect(
    (await readOwnedAutoSellRunRecordStop(db, f.owner, activeRaceId, signal()))
      .stop?.status,
  ).toBe(
    activeRace[0].status === 'fulfilled' ? 'record-found' : 'creation-fenced',
  );
  await reserveOwnedAutoSellAttempt(
    db,
    f.owner,
    autoSellRunAttemptFixture(run),
    signal(),
  );
  await stopOwnedAutoSellRun(
    db,
    f.owner,
    { id: crypto.randomUUID(), runId: run.id, runSha256: run.sha256 },
    signal(),
  );
  const before = await readOwnedAutoSellAttempts(db, f.owner, run.id, signal());
  expect(
    (await stopOwnedAutoSellRunRecord(db, f.owner, request(run.id), signal()))
      .stop?.status,
  ).toBe('record-found');
  expect(
    await readOwnedAutoSellAttempts(db, f.owner, run.id, signal()),
  ).toEqual(before);
  await db.prepare('PRAGMA recursive_triggers=OFF').run();
  for (const sql of [
    'DELETE FROM auto_sell_run_record_stops WHERE owner_id=? AND run_id=?',
    "UPDATE auto_sell_run_record_stops SET status='record-found' WHERE owner_id=? AND run_id=?",
    'UPDATE OR REPLACE auto_sell_run_record_stops SET run_id=run_id WHERE owner_id=? AND run_id=?',
  ])
    await expect(
      db.prepare(sql).bind(f.owner, f.createInput.id).run(),
    ).rejects.toThrow();
  await expect(
    db
      .prepare(
        'INSERT OR REPLACE INTO auto_sell_run_record_stops SELECT * FROM auto_sell_run_record_stops WHERE owner_id=? AND run_id=?',
      )
      .bind(f.owner, f.createInput.id)
      .run(),
  ).rejects.toThrow();
  for (const alias of ['rowid', 'oid', '_rowid_'])
    await expect(
      db
        .prepare(
          `UPDATE auto_sell_run_record_stops SET ${alias}=2 WHERE owner_id=? AND run_id=?`,
        )
        .bind(f.owner, f.createInput.id)
        .run(),
    ).rejects.toThrow();
  const old = await db
    .prepare(
      'SELECT * FROM auto_sell_run_record_stops WHERE owner_id=? AND run_id=?',
    )
    .bind(f.owner, f.createInput.id)
    .first<Record<string, unknown>>();
  expect(old).not.toBeNull();
  if (!old) throw Error('Missing engine receipt');
  const columns = Object.keys(old);
  const raw = (change: Record<string, unknown>) => {
    const row = { ...old, ...change };
    return db
      .prepare(
        `INSERT INTO auto_sell_run_record_stops(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`,
      )
      .bind(...columns.map((k) => row[k]))
      .run();
  };
  await expect(
    raw({
      run_id: crypto.randomUUID(),
      status: 'record-found',
      run_sha256: null,
    }),
  ).rejects.toThrow();
  await expect(
    raw({
      run_id: crypto.randomUUID(),
      created_at: '2000-01-01T00:00:00.000Z',
    }),
  ).rejects.toThrow();
  await expect(
    raw({ run_id: run.id, status: 'creation-fenced' }),
  ).rejects.toThrow();
  await db
    .prepare(
      'UPDATE imported_token_projects SET archived=1,revision=2 WHERE owner_id=?',
    )
    .bind(f.owner)
    .run();
  expect(
    await readOwnedAutoSellRunRecordStop(
      db,
      f.owner,
      f.createInput.id,
      signal(),
    ),
  ).toEqual(fenced);
  const raceId = crypto.randomUUID();
  const race = await Promise.allSettled([
    createOwnedAutoSellRun(
      db,
      f.owner,
      { ...f.createInput, id: raceId },
      signal(),
    ),
    stopOwnedAutoSellRunRecord(db, f.owner, request(raceId), signal()),
  ]);
  expect(race[1].status).toBe('fulfilled');
  expect(
    (await readOwnedAutoSellRunRecordStop(db, f.owner, raceId, signal())).stop
      ?.status,
  ).toBe('creation-fenced');
  expect(
    (
      await db
        .prepare('SELECT count(*) AS n FROM imported_swap_preparations')
        .first<{ n: number }>()
    )?.n,
  ).toBe(0);
  const total = await db
    .prepare(
      'SELECT count(*) AS n FROM auto_sell_run_record_stops WHERE owner_id=?',
    )
    .bind(f.owner)
    .first<{ n: number }>();
  if (!total) throw Error('Missing capacity count');
  await db
    .prepare(
      "WITH RECURSIVE n(v) AS (SELECT 1 UNION ALL SELECT v+1 FROM n WHERE v<?) INSERT INTO auto_sell_run_record_stops(owner_id,run_id,project_id,profile_save_id,profile_sha256,request_sha256,status,run_sha256,created_at) SELECT ?, '00000000-0000-0000-0000-'||printf('%012d',v), ?, ?, ?, ?, 'creation-fenced',NULL,strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM n",
    )
    .bind(
      999 - total.n,
      f.owner,
      f.projectId,
      f.profileSaveId,
      f.profileSha256,
      'a'.repeat(64),
    )
    .run();
  const capRace = await Promise.allSettled([
    stopOwnedAutoSellRunRecord(
      db,
      f.owner,
      request(crypto.randomUUID()),
      signal(),
    ),
    stopOwnedAutoSellRunRecord(
      db,
      f.owner,
      request(crypto.randomUUID()),
      signal(),
    ),
  ]);
  expect(capRace.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  expect(
    await stopOwnedAutoSellRunRecord(
      db,
      f.owner,
      request(f.createInput.id),
      signal(),
    ),
  ).toEqual(fenced);
}
it.each(['turso', 'd1'] as const)(
  'guards real %s terminal record-stop transactions and immutable evidence',
  async (engine) => {
    const client =
      engine === 'turso' ? createClient({ url: 'file::memory:' }) : null;
    let mf: Miniflare | undefined;
    try {
      const db = client
        ? createTursoDatabase(client)
        : ((await (mf = new Miniflare({
            telemetry: { enabled: false },
            workers: [
              {
                config: {
                  name: 'record-stop-local',
                  type: 'worker',
                  compatibilityDate: '2026-09-01',
                  manifest: {
                    mainModule: 'index.js',
                    modules: {
                      'index.js': {
                        type: 'esm',
                        contents:
                          'export default {fetch(){return new Response("local only")}}',
                      },
                    },
                  },
                  env: { DB: { type: 'd1', id: 'record-stop-local' } },
                },
              },
            ],
          })).getD1Database(
            'DB',
            'record-stop-local',
          )) as unknown as D1Database);
      await exercise(db);
    } finally {
      client?.close();
      await mf?.dispose();
    }
  },
  60000,
);
