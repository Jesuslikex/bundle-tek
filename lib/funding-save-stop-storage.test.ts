import { afterEach, beforeEach, expect, it } from 'vitest';
import { createClient, type Client } from '@libsql/client';
import { readFileSync } from 'node:fs';
import { createTursoDatabase } from '../db/turso';
import { fundingOwnerScope } from './funding-owner-scope';
import {
  fundingSaveStopRequestHash,
  type FundingSaveStopRequest,
} from './funding-save-stop';
import {
  retainFundingSaveStop,
  readFundingSaveStop,
  readFundingSaveStopRecovery,
  readFundingSaveStopForRevision,
  hasFundingSaveStop,
} from './funding-save-stop-storage';

const signal = () => new AbortController().signal;
let client: Client, db: D1Database;
const owner = 'alice';
function request(
  expectedRevision = 0,
  action: 'save' | 'archive' | 'restore' = 'save',
  stopId = 'stop-one',
): FundingSaveStopRequest {
  return {
    format: 'funding-save-stop-request-v1',
    stopId,
    reminder: {
      format: 'funding-save-reminder-v1',
      ownerScope: fundingOwnerScope(owner),
      id: 'draft-one',
      action,
      expectedRevision,
      documentHash: 'a'.repeat(64),
    },
    consent: 'stop-draft-save-v1',
  };
}
const raw = ' { "name": "Original", "chain":"Solana" } ';
async function seed(revision = 1, archived = 0, document = raw) {
  await db
    .prepare('INSERT INTO funding_plans VALUES(?,?,?,?,?,?,?)')
    .bind(
      owner,
      'draft-one',
      document,
      revision,
      archived,
      'original-mutation',
      '2026-10-25T10:00:00.000Z',
    )
    .run();
}
async function source() {
  return db
    .prepare('SELECT * FROM funding_plans WHERE owner_id=? AND id=?')
    .bind(owner, 'draft-one')
    .first<Record<string, unknown>>();
}
beforeEach(async () => {
  client = createClient({ url: 'file::memory:' });
  db = createTursoDatabase(client);
  for (const file of [
    '0007_superb_iron_monger.sql',
    '0152_funding_save_stops.sql',
  ])
    for (const sql of readFileSync('drizzle/' + file, 'utf8')
      .split('--> statement-breakpoint')
      .filter((s) => s.trim()))
      await client.execute(sql);
});
afterEach(() => client.close());
it('fences an absent initial save without manufacturing a funding plan or event', async () => {
  const r = await retainFundingSaveStop(db, owner, request(), signal());
  expect(r).toMatchObject({
    outcome: 'creation_fenced',
    beforeRevision: null,
    afterRevision: null,
    transfersCancelled: false,
    signingAuthorized: false,
  });
  expect(await source()).toBeNull();
  expect(
    (await db
      .prepare('SELECT count(*) AS n FROM funding_events')
      .first<{ n: number }>())!.n,
  ).toBe(0);
  await expect(seed()).rejects.toThrow(/fenced/);
  expect(await hasFundingSaveStop(db, owner, 'draft-one', signal())).toBe(true);
  expect(
    await readFundingSaveStopRecovery(db, owner, 'draft-one', 0, signal()),
  ).toEqual({ plan: null, stop: r });
});
it.each([0, 1])(
  'advances revision preserving exact document bytes and archive state %s',
  async (archived) => {
    await seed(1, archived);
    const r = await retainFundingSaveStop(db, owner, request(1), signal());
    expect(r).toMatchObject({
      outcome: 'revision_advanced',
      beforeRevision: 1,
      afterRevision: 2,
    });
    expect(await source()).toMatchObject({
      document: raw,
      archived,
      revision: 2,
      mutation_id: 'stop-one',
      updated_at: r.createdAt,
    });
    expect(
      (
        await db
          .prepare(
            'UPDATE funding_plans SET document=?,revision=revision+1 WHERE owner_id=? AND id=? AND revision=1',
          )
          .bind('late-original', owner, 'draft-one')
          .run()
      ).meta.changes,
    ).toBe(0);
    await db
      .prepare(
        'UPDATE funding_plans SET document=?,revision=revision+1,mutation_id=? WHERE owner_id=? AND id=? AND revision=2',
      )
      .bind('future-user-edit', 'fresh-mutation', owner, 'draft-one')
      .run();
    expect(await source()).toMatchObject({
      document: 'future-user-edit',
      archived,
      revision: 3,
    });
  },
);
it('retains already-advanced evidence without claiming the original save won or bumping again', async () => {
  await seed(3);
  const before = await source();
  const r = await retainFundingSaveStop(db, owner, request(1), signal());
  expect(r).toMatchObject({
    outcome: 'already_advanced',
    beforeRevision: 3,
    afterRevision: 3,
  });
  expect(await source()).toEqual(before);
});
it('records initial-create stops after a different creation has already won', async () => {
  await seed();
  const r = await retainFundingSaveStop(db, owner, request(), signal());
  expect(r.outcome).toBe('already_advanced');
  expect((await source())!.revision).toBe(1);
});
it('supports archive and restore attempt stops without changing archived bits', async () => {
  await seed();
  await retainFundingSaveStop(db, owner, request(1, 'archive'), signal());
  expect(await source()).toMatchObject({ revision: 2, archived: 0 });
  await db
    .prepare(
      'UPDATE funding_plans SET revision=3,archived=1 WHERE owner_id=? AND id=? AND revision=2',
    )
    .bind(owner, 'draft-one')
    .run();
  await retainFundingSaveStop(
    db,
    owner,
    request(3, 'restore', 'stop-two'),
    signal(),
  );
  expect(await source()).toMatchObject({ revision: 4, archived: 1 });
});
it('exact replay survives later source changes and capacity checks', async () => {
  await seed();
  const q = request(1),
    first = await retainFundingSaveStop(db, owner, q, signal());
  await db
    .prepare(
      'UPDATE funding_plans SET revision=revision+1,document=? WHERE owner_id=? AND id=?',
    )
    .bind('later', owner, 'draft-one')
    .run();
  expect(await retainFundingSaveStop(db, owner, q, signal())).toEqual(first);
  expect(await readFundingSaveStop(db, owner, q.stopId, signal())).toEqual(
    first,
  );
});
it('rejects another binding for the same stop ID and another ID for the same original revision', async () => {
  const q = request();
  await retainFundingSaveStop(db, owner, q, signal());
  await expect(
    retainFundingSaveStop(
      db,
      owner,
      { ...q, reminder: { ...q.reminder, documentHash: 'b'.repeat(64) } },
      signal(),
    ),
  ).rejects.toMatchObject({ status: 409 });
  await expect(
    retainFundingSaveStop(db, owner, request(0, 'save', 'stop-two'), signal()),
  ).rejects.toMatchObject({ status: 409 });
});
it('keeps owner namespaces isolated', async () => {
  const q = request();
  await retainFundingSaveStop(db, owner, q, signal());
  expect(await readFundingSaveStop(db, 'bob', q.stopId, signal())).toBeNull();
  expect(await hasFundingSaveStop(db, 'bob', 'draft-one', signal())).toBe(
    false,
  );
  await expect(
    retainFundingSaveStop(db, 'bob', q, signal()),
  ).rejects.toMatchObject({ status: 403 });
  await retainFundingSaveStop(
    db,
    'bob',
    { ...q, reminder: { ...q.reminder, ownerScope: fundingOwnerScope('bob') } },
    signal(),
  );
});
it('refuses future revisions, absent noninitial drafts and unapproved requests without writes', async () => {
  await expect(
    retainFundingSaveStop(db, owner, request(1), signal()),
  ).rejects.toMatchObject({ status: 409 });
  await seed();
  await expect(
    retainFundingSaveStop(db, owner, request(2), signal()),
  ).rejects.toMatchObject({ status: 409 });
  await expect(
    retainFundingSaveStop(
      db,
      owner,
      { ...request(), consent: false },
      signal(),
    ),
  ).rejects.toMatchObject({ status: 400 });
  expect(
    (await db
      .prepare('SELECT count(*) AS n FROM funding_save_stops')
      .first<{ n: number }>())!.n,
  ).toBe(0);
});
it('preserves and independently fences a corrupt current document', async () => {
  await seed(1, 0, 'not-json');
  const r = await retainFundingSaveStop(db, owner, request(1), signal());
  const recovered = await readFundingSaveStopRecovery(
    db,
    owner,
    'draft-one',
    1,
    signal(),
  );
  expect(recovered.stop).toEqual(r);
  expect(recovered.plan).toMatchObject({ document: 'not-json', revision: 2 });
});
it('atomically includes stop provenance for an unchanged-document revision bump', async () => {
  await seed();
  const r = await retainFundingSaveStop(db, owner, request(1), signal());
  expect(
    await readFundingSaveStopRecovery(db, owner, 'draft-one', 1, signal()),
  ).toMatchObject({ plan: { revision: 2, document: raw }, stop: r });
  expect(
    (await readFundingSaveStopRecovery(db, owner, 'draft-one', 2, signal()))
      .stop,
  ).toBeNull();
  expect(
    (await readFundingSaveStopRecovery(db, owner, 'draft-one', null, signal()))
      .stop,
  ).toEqual(r);
});
it('serializes both original-writer and stop-writer race orders without a late CAS winning', async () => {
  await seed();
  const [r] = await Promise.all([
    retainFundingSaveStop(db, owner, request(1), signal()),
    db
      .prepare(
        'UPDATE funding_plans SET revision=revision+1,document=? WHERE owner_id=? AND id=? AND revision=1',
      )
      .bind('original-writer', owner, 'draft-one')
      .run(),
  ]);
  expect(['revision_advanced', 'already_advanced']).toContain(r.outcome);
  expect((await source())!.revision).toBe(2);
  expect(
    (
      await db
        .prepare(
          'UPDATE funding_plans SET revision=revision+1 WHERE owner_id=? AND id=? AND revision=1',
        )
        .bind(owner, 'draft-one')
        .run()
    ).meta.changes,
  ).toBe(0);
});
it('identical concurrent stop requests return the same immutable receipt', async () => {
  const results = await Promise.all([
    retainFundingSaveStop(db, owner, request(), signal()),
    retainFundingSaveStop(db, owner, request(), signal()),
  ]);
  expect(results[0]).toEqual(results[1]);
});
it('aborts without losing a committed stop receipt', async () => {
  const control = new AbortController();
  control.abort();
  await expect(
    retainFundingSaveStop(db, owner, request(), control.signal),
  ).rejects.toMatchObject({ status: 499 });
  const r = await retainFundingSaveStop(db, owner, request(), signal());
  expect(await readFundingSaveStop(db, owner, r.stopId, signal())).toEqual(r);
});
it('recovers the exact stop when cancellation occurs after its atomic insert', async () => {
  const control = new AbortController();
  const delegate = db;
  const interrupted = {
    // This collector only uses prepare; preserve the real bound statements.
    prepare(sql: string) {
      const statement = delegate.prepare(sql);
      if (!sql.includes('INSERT INTO funding_save_stops')) return statement;
      return {
        bind(...args: unknown[]) {
          const bound = statement.bind(...args);
          return {
            async run() {
              const result = await bound.run();
              control.abort();
              return result;
            },
          };
        },
      };
    },
  } as unknown as D1Database;
  await expect(
    retainFundingSaveStop(interrupted, owner, request(), control.signal),
  ).rejects.toMatchObject({ status: 499 });
  const recovered = await readFundingSaveStop(
    db,
    owner,
    request().stopId,
    signal(),
  );
  expect(recovered?.outcome).toBe('creation_fenced');
  expect(await retainFundingSaveStop(db, owner, request(), signal())).toEqual(
    recovered,
  );
});
it('guards immutability, rekey, rollback, deletion and OR REPLACE with recursive triggers disabled', async () => {
  await client.execute('PRAGMA recursive_triggers=OFF');
  await seed();
  await retainFundingSaveStop(db, owner, request(1), signal());
  for (const sql of [
    "UPDATE funding_save_stops SET action='archive'",
    'DELETE FROM funding_save_stops',
    'INSERT OR REPLACE INTO funding_save_stops SELECT * FROM funding_save_stops',
    "UPDATE funding_plans SET id='new-id',revision=3",
    "UPDATE funding_plans SET owner_id='bob',revision=3",
    'UPDATE funding_plans SET revision=1',
    'UPDATE funding_plans SET revision=4',
    'DELETE FROM funding_plans',
    'INSERT OR REPLACE INTO funding_plans SELECT * FROM funding_plans',
  ])
    await expect(client.execute(sql)).rejects.toThrow();
  expect(await source()).toMatchObject({ revision: 2, document: raw });
});
it('allows the final bounded revision advance and refuses invalid read revisions', async () => {
  await seed(1_000_000_000);
  const r = await retainFundingSaveStop(
    db,
    owner,
    request(1_000_000_000),
    signal(),
  );
  expect(r.afterRevision).toBe(1_000_000_001);
  for (const n of [-1, -0, 1.1, 1_000_000_001, NaN])
    await expect(
      readFundingSaveStopForRevision(db, owner, 'draft-one', n, signal()),
    ).rejects.toMatchObject({ status: 400 });
});
it('enforces owner capacity at SQL time while preserving exact replay', async () => {
  const q = request(),
    h = await fundingSaveStopRequestHash(q),
    scope = fundingOwnerScope(owner);
  await client.execute({
    sql: `WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<999)
    INSERT INTO funding_save_stops(owner_id,stop_id,plan_id,expected_revision,action,document_hash,owner_scope,request_hash,request_json,outcome,before_revision,after_revision,source_document,source_archived,created_at)
    SELECT ?, 'seed-'||x, 'seed-'||x,0,'save',?,?,?,
      json_object('format','funding-save-stop-request-v1','stopId','seed-'||x,'reminder',json_object('format','funding-save-reminder-v1','ownerScope',?,'id','seed-'||x,'action','save','expectedRevision',0,'documentHash',?),'consent','stop-draft-save-v1'),
      'creation_fenced',NULL,NULL,NULL,NULL,'2026-10-25T12:00:00.000Z' FROM n`,
    args: [owner, 'a'.repeat(64), scope, h, scope, 'a'.repeat(64)],
  });
  const r = await retainFundingSaveStop(db, owner, q, signal());
  expect(await retainFundingSaveStop(db, owner, q, signal())).toEqual(r);
  await expect(
    retainFundingSaveStop(
      db,
      owner,
      {
        ...q,
        stopId: 'one-too-many',
        reminder: { ...q.reminder, id: 'different' },
      },
      signal(),
    ),
  ).rejects.toMatchObject({ status: 409 });
});
