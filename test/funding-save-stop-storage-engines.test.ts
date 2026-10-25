import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createClient } from '@libsql/client';
import { Miniflare } from 'miniflare';
import { createTursoDatabase } from '../db/turso';
import { fundingOwnerScope } from '../lib/funding-owner-scope';
import {
  fundingSaveStopRequestHash,
  type FundingSaveStopRequest,
} from '../lib/funding-save-stop';
import {
  retainFundingSaveStop,
  readFundingSaveStopRecovery,
} from '../lib/funding-save-stop-storage';

const signal = () => new AbortController().signal;
const owner = 'engine-owner';
const stamp = '2026-10-25T12:00:00.000Z';
const fields = [
  'owner_id',
  'stop_id',
  'plan_id',
  'expected_revision',
  'action',
  'document_hash',
  'owner_scope',
  'request_hash',
  'request_json',
  'outcome',
  'before_revision',
  'after_revision',
  'source_document',
  'source_archived',
  'created_at',
];
function request(id: string, expectedRevision = 0): FundingSaveStopRequest {
  return {
    format: 'funding-save-stop-request-v1',
    stopId: 'stop-' + id,
    reminder: {
      format: 'funding-save-reminder-v1',
      ownerScope: fundingOwnerScope(owner),
      id,
      action: 'save',
      expectedRevision,
      documentHash: 'a'.repeat(64),
    },
    consent: 'stop-draft-save-v1',
  };
}
async function exercise(db: D1Database) {
  const insert = async (row: Record<string, unknown>, prefix = 'INSERT') =>
    db
      .prepare(
        `${prefix} INTO funding_save_stops(${fields.join(',')}) VALUES(${fields.map(() => '?').join(',')})`,
      )
      .bind(...fields.map((key) => row[key]))
      .run();
  const q = request('missing');
  const first = await retainFundingSaveStop(db, owner, q, signal());
  expect(first.outcome).toBe('creation_fenced');
  await expect(
    db
      .prepare('INSERT INTO funding_plans VALUES(?,?,?,?,?,?,?)')
      .bind(owner, 'missing', '{}', 1, 0, 'late', stamp)
      .run(),
  ).rejects.toThrow();
  await db
    .prepare('INSERT INTO funding_plans VALUES(?,?,?,?,?,?,?)')
    .bind(owner, 'current', 'unparseable raw source', 1, 1, 'old', stamp)
    .run();
  const current = request('current', 1);
  const r = await retainFundingSaveStop(db, owner, current, signal());
  expect(r.outcome).toBe('revision_advanced');
  expect(
    await readFundingSaveStopRecovery(db, owner, 'current', 1, signal()),
  ).toMatchObject({
    stop: r,
    plan: { revision: 2, archived: 1, document: 'unparseable raw source' },
  });
  expect(
    (
      await db
        .prepare(
          'UPDATE funding_plans SET revision=revision+1 WHERE owner_id=? AND id=? AND revision=1',
        )
        .bind(owner, 'current')
        .run()
    ).meta.changes,
  ).toBe(0);
  await db
    .prepare(
      'UPDATE funding_plans SET revision=3,archived=0 WHERE owner_id=? AND id=? AND revision=2',
    )
    .bind(owner, 'current')
    .run();
  expect(
    (await readFundingSaveStopRecovery(db, owner, 'current', 2, signal())).stop,
  ).toBeNull();
  expect(await retainFundingSaveStop(db, owner, current, signal())).toEqual(r);
  const third = await retainFundingSaveStop(
    db,
    owner,
    { ...request('current', 0), stopId: 'stop-initial-current' },
    signal(),
  );
  expect(third.outcome).toBe('already_advanced');
  await db.prepare('PRAGMA recursive_triggers=OFF').run();
  const targetRowId = (await db
    .prepare('SELECT rowid AS rid FROM funding_plans WHERE owner_id=? AND id=?')
    .bind(owner, 'current')
    .first<{ rid: number }>())!.rid;
  await db
    .prepare('INSERT INTO funding_plans VALUES(?,?,?,?,?,?,?)')
    .bind(
      owner,
      'rowid-attacker',
      'untouched unfenced source',
      1,
      0,
      'attacker',
      stamp,
    )
    .run();
  for (const alias of ['rowid', 'oid', '_rowid_']) {
    const fresh = request('alias-' + alias.replaceAll('_', ''));
    const freshRow: Record<string, unknown> = {
      owner_id: owner,
      stop_id: fresh.stopId,
      plan_id: fresh.reminder.id,
      expected_revision: 0,
      action: 'save',
      document_hash: fresh.reminder.documentHash,
      owner_scope: fresh.reminder.ownerScope,
      request_hash: await fundingSaveStopRequestHash(fresh),
      request_json: JSON.stringify(fresh),
      outcome: 'creation_fenced',
      before_revision: null,
      after_revision: null,
      source_document: null,
      source_archived: null,
      created_at: stamp,
    };
    await expect(
      db.prepare(`SELECT ${alias} FROM funding_save_stops LIMIT 1`).first(),
    ).rejects.toThrow();
    await expect(
      db
        .prepare(
          `INSERT OR REPLACE INTO funding_save_stops(${alias},${fields.join(',')}) VALUES(?,${fields.map(() => '?').join(',')})`,
        )
        .bind(1, ...fields.map((key) => freshRow[key]))
        .run(),
    ).rejects.toThrow();
    await expect(
      db
        .prepare(
          `INSERT OR REPLACE INTO funding_plans(${alias},owner_id,id,document,revision,archived,mutation_id,updated_at) VALUES(?,?,?,?,?,?,?,?)`,
        )
        .bind(
          targetRowId,
          'replacement-owner',
          'replacement-draft',
          'replacement',
          1,
          0,
          'replacement',
          stamp,
        )
        .run(),
    ).rejects.toThrow();
    await expect(
      db
        .prepare(
          `UPDATE OR REPLACE funding_plans SET ${alias}=?,owner_id=?,id=?,revision=revision+1 WHERE owner_id=? AND id=?`,
        )
        .bind(
          targetRowId,
          'replacement-owner',
          'replacement-draft',
          owner,
          'rowid-attacker',
        )
        .run(),
    ).rejects.toThrow();
    await expect(
      db
        .prepare(
          `UPDATE funding_plans SET ${alias}=?,revision=revision+1 WHERE owner_id=? AND id=?`,
        )
        .bind(99999, owner, 'current')
        .run(),
    ).rejects.toThrow();
    expect(
      (await readFundingSaveStopRecovery(db, owner, 'current', 1, signal()))
        .stop,
    ).toEqual(r);
    expect(
      (await db
        .prepare('SELECT document FROM funding_plans WHERE owner_id=? AND id=?')
        .bind(owner, 'rowid-attacker')
        .first<{ document: string }>())!.document,
    ).toBe('untouched unfenced source');
  }
  for (const sql of [
    "UPDATE funding_save_stops SET outcome='already_advanced'",
    'DELETE FROM funding_save_stops',
    'INSERT OR REPLACE INTO funding_save_stops SELECT * FROM funding_save_stops',
    'INSERT OR REPLACE INTO funding_plans SELECT * FROM funding_plans',
    "UPDATE funding_plans SET owner_id='different',revision=4 WHERE id='current'",
    "UPDATE funding_plans SET id='different',revision=4 WHERE id='current'",
    "UPDATE funding_plans SET revision=1 WHERE id='current'",
    "DELETE FROM funding_plans WHERE id='current'",
  ])
    await expect(db.prepare(sql).run()).rejects.toThrow();
  // Every malformed insertion gets a fresh actual source so a null CHECK cannot
  // be masked by a duplicate identity or a missing-source admission refusal.
  const mutations: Array<(row: Record<string, unknown>) => void> = [
    (row) => {
      row.after_revision = null;
    },
    (row) => {
      row.source_archived = null;
    },
    (row) => {
      row.before_revision = null;
    },
    (row) => {
      row.after_revision = 3;
    },
    (row) => {
      row.source_document = null;
    },
    (row) => {
      row.source_document = 'wrong bytes';
    },
    (row) => {
      row.source_archived = 1;
    },
    (row) => {
      row.created_at = 'invalid';
    },
    (row) => {
      row.request_json = String(row.request_json).replace(
        '"consent":',
        '"extra":true,"consent":',
      );
    },
    (row) => {
      row.request_json = String(row.request_json).replace(
        '"format":"funding-save-stop-request-v1"',
        '"format":"funding-save-stop-request-v1","format":"funding-save-stop-request-v1"',
      );
    },
    (row) => {
      row.request_json = String(row.request_json).replace(
        '"action":"save"',
        '"action":"save","action":"save"',
      );
    },
    (row) => {
      row.request_json = String(row.request_json).replace(
        '"expectedRevision":1',
        '"expectedRevision":1.0',
      );
    },
    (row) => {
      row.request_json = String(row.request_json).replace(
        '"consent":"stop-draft-save-v1"',
        '"consent":true',
      );
    },
  ];
  for (let i = 0; i < mutations.length; i++) {
    const id = 'bad-' + i,
      input = request(id, 1);
    await db
      .prepare('INSERT INTO funding_plans VALUES(?,?,?,?,?,?,?)')
      .bind(owner, id, 'raw', 1, 0, 'source', stamp)
      .run();
    const row: Record<string, unknown> = {
      owner_id: owner,
      stop_id: input.stopId,
      plan_id: id,
      expected_revision: 1,
      action: 'save',
      document_hash: input.reminder.documentHash,
      owner_scope: input.reminder.ownerScope,
      request_hash: await fundingSaveStopRequestHash(input),
      request_json: JSON.stringify(input),
      outcome: 'revision_advanced',
      before_revision: 1,
      after_revision: 2,
      source_document: 'raw',
      source_archived: 0,
      created_at: stamp,
    };
    mutations[i](row);
    await expect(insert(row)).rejects.toThrow();
    expect(
      (await db
        .prepare('SELECT revision FROM funding_plans WHERE owner_id=? AND id=?')
        .bind(owner, id)
        .first<{ revision: number }>())!.revision,
    ).toBe(1);
  }
  expect(
    (await db
      .prepare('SELECT count(*) AS n FROM funding_save_stops')
      .first<{ n: number }>())!.n,
  ).toBe(3);
  expect(
    (await db
      .prepare('SELECT count(*) AS n FROM funding_events')
      .first<{ n: number }>())!.n,
  ).toBe(0);
  // SQLite reports -1 for both an unspecified insert rowid and an explicit
  // negative rowid. A fenced legacy -1 must fail closed in either spelling.
  await db
    .prepare(
      'INSERT INTO funding_plans(rowid,owner_id,id,document,revision,archived,mutation_id,updated_at) VALUES(?,?,?,?,?,?,?,?)',
    )
    .bind(-1, owner, 'negative-row', 'legacy source', 1, 0, 'legacy', stamp)
    .run();
  const negative = await retainFundingSaveStop(
    db,
    owner,
    request('negative-row', 1),
    signal(),
  );
  expect(negative.outcome).toBe('revision_advanced');
  await expect(
    db
      .prepare(
        'INSERT OR REPLACE INTO funding_plans(rowid,owner_id,id,document,revision,archived,mutation_id,updated_at) VALUES(?,?,?,?,?,?,?,?)',
      )
      .bind(
        -1,
        'replacement-owner',
        'negative-replacement',
        'replacement',
        1,
        0,
        'replacement',
        stamp,
      )
      .run(),
  ).rejects.toThrow();
  await expect(
    db
      .prepare('INSERT INTO funding_plans VALUES(?,?,?,?,?,?,?)')
      .bind(owner, 'ordinary-new-draft', 'ordinary', 1, 0, 'ordinary', stamp)
      .run(),
  ).rejects.toThrow();
  expect(
    (await readFundingSaveStopRecovery(db, owner, 'negative-row', 1, signal()))
      .stop,
  ).toEqual(negative);
}
it.each(['native-turso-adapter', 'local-d1'] as const)(
  'retains atomic stop/fence and malformed-SQL guards on %s',
  async (engine) => {
    let mf: Miniflare | undefined;
    const client =
      engine === 'native-turso-adapter'
        ? createClient({ url: 'file::memory:' })
        : undefined;
    try {
      const db = client
        ? createTursoDatabase(client)
        : await (mf = new Miniflare({
            telemetry: { enabled: false },
            workers: [
              {
                config: {
                  name: 'funding-stop',
                  type: 'worker',
                  compatibilityDate: '2026-09-01',
                  manifest: {
                    mainModule: 'index.js',
                    modules: {
                      'index.js': {
                        type: 'esm',
                        contents:
                          'export default {fetch(){return new Response("local stop qualification")}}',
                      },
                    },
                  },
                  env: { DB: { type: 'd1', id: 'funding-stop-test' } },
                },
              },
            ],
          })).getD1Database('DB', 'funding-stop');
      for (const file of [
        '0007_superb_iron_monger.sql',
        '0152_funding_save_stops.sql',
      ])
        for (const sql of readFileSync('drizzle/' + file, 'utf8')
          .split('--> statement-breakpoint')
          .filter((s) => s.trim()))
          await db.prepare(sql).run();
      await exercise(db as D1Database);
    } finally {
      client?.close();
      await mf?.dispose();
    }
  },
);
