import { expect, it } from 'vitest';
import { createClient } from '@libsql/client';
import { Miniflare } from 'miniflare';
import { createTursoDatabase } from '../db/turso';
import { executionCapacityManifest } from '../test/warmup-execution-capacity-fixture';
import {
  packWarmupExecutionArchive,
  unpackWarmupExecutionArchive,
} from './wallet-warmup-execution-archive';

/** Primitive BLOB transport proof only, not production root/consent storage. */
it.each(['turso', 'd1'] as const)(
  'round trips the complete manifest through disposable %s BLOB bindings',
  async (platform) => {
    const client =
      platform === 'turso' ? createClient({ url: 'file::memory:' }) : null;
    const mf =
      platform === 'd1'
        ? new Miniflare({
            telemetry: { enabled: false },
            workers: [
              {
                config: {
                  name: 'warmup-archive-blob-test',
                  type: 'worker',
                  compatibilityDate: '2026-09-01',
                  manifest: {
                    mainModule: 'index.js',
                    modules: {
                      'index.js': {
                        type: 'esm',
                        contents:
                          'export default {fetch(){return new Response("fixture only")}}',
                      },
                    },
                  },
                  env: {
                    DB: { type: 'd1', id: 'warmup-archive-blob-test-only' },
                  },
                },
              },
            ],
          })
        : null;
    try {
      const db = client
        ? createTursoDatabase(client)
        : ((await mf!.getD1Database(
            'DB',
            'warmup-archive-blob-test',
          )) as unknown as D1Database);
      await db
        .prepare(
          "CREATE TABLE archive_chunks(idx INTEGER PRIMARY KEY,data BLOB NOT NULL CHECK(typeof(data)='blob' AND length(data)<=737280))",
        )
        .run();
      const manifest = executionCapacityManifest('mixed'),
        archive = await packWarmupExecutionArchive(manifest);
      await db.batch(
        archive.chunks.map((c) =>
          db
            .prepare('INSERT INTO archive_chunks(idx,data) VALUES(?,?)')
            .bind(c.index, Uint8Array.from(c.data).buffer),
        ),
      );
      const rows = await db
        .prepare('SELECT idx,data FROM archive_chunks ORDER BY idx')
        .all<{ idx: number; data: unknown }>();
      const chunks = rows.results.map((row) => {
        let data: Uint8Array;
        if (row.data instanceof ArrayBuffer) data = new Uint8Array(row.data);
        else if (row.data instanceof Uint8Array)
          data = Uint8Array.from(row.data);
        else if (
          Array.isArray(row.data) &&
          row.data.every((b) => Number.isInteger(b) && b >= 0 && b <= 255)
        )
          data = Uint8Array.from(row.data);
        else throw Error('Unsupported synthetic BLOB transport');
        return { index: row.idx, data };
      });
      const expected = {
        id: archive.header.id,
        ownerId: archive.header.ownerId,
        manifestSha256: archive.header.manifestSha256,
      };
      expect(
        (await unpackWarmupExecutionArchive(archive.header, chunks, expected))
          .manifest,
      ).toEqual(manifest);
      await expect(
        unpackWarmupExecutionArchive(archive.header, chunks.slice(1), expected),
      ).rejects.toThrow();
    } finally {
      client?.close();
      await mf?.dispose();
    }
  },
);
