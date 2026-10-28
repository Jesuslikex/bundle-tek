import { readFileSync } from 'node:fs';
import { createClient } from '@libsql/client';
import { Miniflare } from 'miniflare';
import { expect, it } from 'vitest';
import { createTursoDatabase } from '../db/turso';
import { jitoBundleFixture } from './jito-bundle-fixture';
import { jitoDatabase } from './jito-sqlite';

it.each(['turso', 'd1'] as const)(
  'serializes begin versus cancellation using local %s',
  async (engine) => {
    const client =
      engine === 'turso' ? createClient({ url: 'file::memory:' }) : null;
    let mf: Miniflare | undefined;
    const f = await jitoBundleFixture();
    const source = jitoDatabase(f.manifest, false);
    try {
      source.sqlite.exec(
        'CREATE TABLE solana_execution_reservations(owner_id TEXT NOT NULL,wallet_address TEXT NOT NULL,scope TEXT NOT NULL,intent_id TEXT NOT NULL,state TEXT NOT NULL,PRIMARY KEY(owner_id,wallet_address))',
      );
      source.sqlite.exec(
        'INSERT INTO solana_execution_reservations SELECT owner_id,wallet_address,scope,intent_id,state FROM solana_swap_reservations',
      );
      source.sqlite.exec(
        'CREATE TRIGGER fixture_execution_update AFTER UPDATE OF state ON solana_swap_reservations BEGIN UPDATE solana_execution_reservations SET state=NEW.state WHERE owner_id=NEW.owner_id AND wallet_address=NEW.wallet_address; END',
      );
      const db = client
        ? createTursoDatabase(client)
        : ((await (mf = new Miniflare({
            telemetry: { enabled: false },
            workers: [
              {
                config: {
                  name: 'jito-v2-local',
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
                  env: { DB: { type: 'd1', id: 'jito-v2-test-only' } },
                },
              },
            ],
          })).getD1Database('DB', 'jito-v2-local')) as unknown as D1Database);
      const objects = source.sqlite
        .prepare(
          "SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END",
        )
        .all() as { type: string; name: string; sql: string }[];
      for (const object of objects.filter((o) => o.type === 'table')) {
        await db.prepare(object.sql).run();
        for (const row of source.sqlite
          .prepare(`SELECT * FROM "${object.name}"`)
          .all()) {
          const values = Object.values(row) as (string | number | null)[];
          await db
            .prepare(
              `INSERT INTO "${object.name}" VALUES(${values.map(() => '?').join(',')})`,
            )
            .bind(...values)
            .run();
        }
      }
      for (const object of objects.filter((o) => o.type !== 'table'))
        await db.prepare(object.sql).run();
      const statements = readFileSync(
        'drizzle/0163_jito_signing_reservations.sql',
        'utf8',
      )
        .split('--> statement-breakpoint')
        .map((s) => s.trim())
        .filter(Boolean);
      for (const sql of statements) await db.prepare(sql).run();
      await db.batch([
        db
          .prepare(
            "INSERT INTO jito_bundles VALUES(?,?,?,?,?,'reviewed',NULL,?,?)",
          )
          .bind(
            'owner',
            f.manifest.id,
            f.manifest.projectId,
            f.manifest.sessionId,
            JSON.stringify(f.manifest),
            f.manifest.createdAt,
            f.manifest.createdAt,
          ),
        db
          .prepare('INSERT INTO jito_bundle_protocol VALUES(?,?,?,?,?)')
          .bind(
            'owner',
            f.manifest.id,
            2,
            f.manifest.sha256,
            f.manifest.createdAt,
          ),
        db
          .prepare('INSERT INTO jito_bundle_packets VALUES(?,?,?,?,NULL,NULL)')
          .bind('owner', f.manifest.id, 0, f.review.id),
        db
          .prepare('INSERT INTO jito_bundle_packets VALUES(?,?,?,?,NULL,NULL)')
          .bind('owner', f.manifest.id, 1, null),
      ]);
      const race = await Promise.allSettled([
        db
          .prepare('INSERT INTO jito_sign_attempts VALUES(?,?,?,?,?,?,?,?)')
          .bind(
            'owner',
            f.manifest.id,
            0,
            crypto.randomUUID(),
            f.manifest.sha256,
            f.review.wallet,
            f.review.id,
            new Date().toISOString(),
          )
          .run(),
        db
          .prepare(
            "UPDATE jito_bundles SET state='cancelled' WHERE owner_id=? AND id=? AND state='reviewed'",
          )
          .bind('owner', f.manifest.id)
          .run(),
      ]);
      const row = await db
        .prepare('SELECT state FROM jito_bundles WHERE owner_id=? AND id=?')
        .bind('owner', f.manifest.id)
        .first<{ state: string }>();
      const attempts = await db
        .prepare('SELECT count(*) AS n FROM jito_sign_attempts')
        .first<{ n: number }>();
      expect(
        (row?.state === 'reviewed' && attempts?.n === 1) ||
          (row?.state === 'cancelled' && attempts?.n === 0),
      ).toBe(true);
      expect(
        race.filter((r) => r.status === 'fulfilled').length,
      ).toBeGreaterThanOrEqual(1);
    } finally {
      source.sqlite.close();
      client?.close();
      await mf?.dispose();
    }
  },
  60000,
);
