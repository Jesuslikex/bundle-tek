import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { Miniflare } from 'miniflare';
it('applies the entire journal to local D1 and retains every migration-created schema object', async () => {
  const journal = JSON.parse(
    readFileSync('drizzle/meta/_journal.json', 'utf8'),
  ) as { entries: { idx: number; tag: string; when: number }[] };
  const sqlite = new DatabaseSync(':memory:');
  const mf = new Miniflare({
    telemetry: { enabled: false },
    workers: [
      {
        config: {
          name: 'migration-chain-test',
          type: 'worker',
          compatibilityDate: '2026-09-01',
          manifest: {
            mainModule: 'index.js',
            modules: {
              'index.js': {
                type: 'esm',
                contents: 'export default {fetch(){return new Response("ok")}}',
              },
            },
          },
          env: { DB: { type: 'd1', id: 'migration-chain-test-only' } },
        },
      },
    ],
  });
  try {
    const db = await mf.getD1Database('DB', 'migration-chain-test');
    const names = new Set<string>();
    for (const [index, entry] of journal.entries.entries()) {
      expect(entry.idx).toBe(index);
      expect(names.has(entry.tag)).toBe(false);
      names.add(entry.tag);
      if (index > 0)
        expect(entry.when).toBeGreaterThan(journal.entries[index - 1].when);
      const statements = readFileSync(`drizzle/${entry.tag}.sql`, 'utf8')
        .split('--> statement-breakpoint')
        .map((s) => s.trim())
        .filter(Boolean);
      expect(statements.length).toBeGreaterThan(0);
      for (const statement of statements) sqlite.exec(statement);
      await db.batch(statements.map((statement) => db.prepare(statement)));
    }
    const expected = sqlite
      .prepare(
        "SELECT type,name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name",
      )
      .all();
    const actual = await db
      .prepare(
        "SELECT type,name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name",
      )
      .all<{ type: string; name: string }>();
    const keys = new Set(
      actual.results.map((object) => `${object.type}/${object.name}`),
    );
    for (const object of expected)
      expect(
        keys.has(`${String(object.type)}/${String(object.name)}`),
        `${String(object.type)}/${String(object.name)}`,
      ).toBe(true);
    for (const table of [
      'jito_bundles',
      'jito_bundle_packets',
      'holder_index_runs',
      'holder_index_pages',
      'supply_movement_evidence',
    ])
      expect(keys.has(`table/${table}`)).toBe(true);
    for (const trigger of [
      'jito_packet_signature',
      'jito_bundle_claim',
      'jito_preparation_immutable',
      'jito_preparation_retained',
    ])
      expect(keys.has(`trigger/${trigger}`)).toBe(true);
  } finally {
    sqlite.close();
    await mf.dispose();
  }
}, 60000);
