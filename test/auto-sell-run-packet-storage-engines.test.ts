import { expect, it, vi } from 'vitest';
import { createClient } from '@libsql/client';
import { Miniflare } from 'miniflare';
import { createTursoDatabase } from '../db/turso';
import {
  initializeAutoSellRunPacketStorageFixture,
  setupAutoSellRunPacketStorageFixture,
} from './auto-sell-run-packet-storage-fixture';
import {
  autoSellRunPacketWriteReady,
  prepareAutoSellRunPacketWrite,
  readOwnedAutoSellRunPacket,
} from '../lib/auto-sell-run-packet-storage';
import { saveSwapPreparation } from '../lib/imported-swap-preparation-history';
import {
  startOwnedAutoSellPreparation,
  stopOwnedAutoSellRun,
  readOwnedAutoSellAttempts,
} from '../lib/auto-sell-run-storage';
const signal = () => new AbortController().signal;
async function exercise(db: D1Database) {
  await autoSellRunPacketWriteReady(db);
  const f = await setupAutoSellRunPacketStorageFixture(db, { start: false });
  const read = () =>
    readOwnedAutoSellRunPacket(db, f.owner, f.run.id, f.attempt.id, signal());
  expect((await read()).status).toBe('not-started');
  const guard = await startOwnedAutoSellPreparation(
    db,
    f.owner,
    f.run.id,
    f.attempt.id,
    signal(),
  );
  expect((await read()).status).toBe('started-without-result');
  const write = await saveSwapPreparation(
    db,
    f.owner,
    f.context,
    f.summary,
    undefined,
    undefined,
    undefined,
    guard,
    f.transaction,
  );
  expect(write?.id).toBe(f.attempt.preparationId);
  const original = await read();
  expect(original.status).toBe('retained');
  expect(original.packet?.transaction).toBe(f.transaction);
  expect(original.summary?.document).toEqual(f.summary);
  expect(original).toMatchObject({
    signingAllowed: false,
    executionAllowed: false,
    automaticResumeAllowed: false,
  });
  await expect(
    db
      .prepare(
        'INSERT INTO imported_swap_signing_intents VALUES(?,?,?,?,?,?,?,?,?)',
      )
      .bind(
        crypto.randomUUID(),
        f.owner,
        f.attempt.preparationId,
        f.context.wallet,
        '{}',
        'awaiting_signature',
        null,
        new Date().toISOString(),
        new Date().toISOString(),
      )
      .run(),
  ).rejects.toThrow(/signing remains disabled/);
  await stopOwnedAutoSellRun(
    db,
    f.owner,
    { id: crypto.randomUUID(), runId: f.run.id, runSha256: f.run.sha256 },
    signal(),
  );
  await db
    .prepare(
      'UPDATE imported_token_projects SET archived=1,revision=revision+1 WHERE owner_id=?',
    )
    .bind(f.owner)
    .run();
  await db
    .prepare(
      'UPDATE workspace_wallets SET archived=1,revision=revision+1 WHERE owner_id=?',
    )
    .bind(f.owner)
    .run();
  const clock = vi
    .spyOn(Date, 'now')
    .mockReturnValue(Date.parse(f.summary.expiresAt) + 3600000);
  try {
    expect(await read()).toEqual(original);
  } finally {
    clock.mockRestore();
  }
  expect(
    (await readOwnedAutoSellAttempts(db, f.owner, f.run.id, signal()))
      .accounting.accountedRaw,
  ).toBe(f.attempt.inputRaw);
  await db.prepare('PRAGMA recursive_triggers=OFF').run();
  for (const sql of [
    'UPDATE auto_sell_run_packets SET transaction_text=transaction_text',
    'DELETE FROM auto_sell_run_packets',
    'INSERT OR REPLACE INTO auto_sell_run_packets SELECT * FROM auto_sell_run_packets',
  ])
    await expect(db.prepare(sql).run()).rejects.toThrow();
  for (const alias of ['rowid', 'oid', '_rowid_'])
    await expect(
      db.prepare(`SELECT ${alias} FROM auto_sell_run_packets`).first(),
    ).rejects.toThrow();
  // Both zero-change cases must abort the second statement, including the
  // race where an old summary appears after the builder's pre-read.
  for (const existing of [false, true]) {
    const g = await setupAutoSellRunPacketStorageFixture(db);
    const primary = (where: string) =>
      db
        .prepare(
          `INSERT INTO imported_swap_preparations(id,owner_id,project_id,project_revision,wallet_address,wallet_revision,document,created_at) SELECT ?,?,?,?,?,?,?,? WHERE ${where}`,
        )
        .bind(
          g.attempt.preparationId,
          g.owner,
          g.projectId,
          1,
          g.context.wallet,
          1,
          g.summaryText,
          new Date().toISOString(),
        );
    const commit = await prepareAutoSellRunPacketWrite(
      db,
      primary('0'),
      g.owner,
      g.attempt.preparationId,
      g.summaryText,
      g.transaction,
      g.summary,
      g.guard!,
    );
    if (existing) await primary('1=1').run();
    await expect(commit()).rejects.toThrow(/new original preparation/);
    const recovered = await readOwnedAutoSellRunPacket(
      db,
      g.owner,
      g.run.id,
      g.attempt.id,
      signal(),
    );
    expect(recovered.status).toBe(
      existing ? 'summary-only' : 'started-without-result',
    );
    expect(recovered.packet).toBeNull();
  }
  // Failure in the actual packet insert rolls back the actual primary insert.
  const broken = await setupAutoSellRunPacketStorageFixture(db);
  await db
    .prepare(
      "CREATE TRIGGER synthetic_packet_refusal BEFORE INSERT ON auto_sell_run_packets BEGIN SELECT RAISE(ABORT,'synthetic packet failure'); END",
    )
    .run();
  await expect(
    saveSwapPreparation(
      db,
      broken.owner,
      broken.context,
      broken.summary,
      undefined,
      undefined,
      undefined,
      broken.guard!,
      broken.transaction,
    ),
  ).rejects.toThrow();
  await db.prepare('DROP TRIGGER synthetic_packet_refusal').run();
  const retained = await readOwnedAutoSellRunPacket(
    db,
    broken.owner,
    broken.run.id,
    broken.attempt.id,
    signal(),
  );
  expect(retained.status).toBe('started-without-result');
  expect(retained.summary).toBeNull();
  // Object count is unchanged; only the actual publication guard has drifted.
  await autoSellRunPacketWriteReady(db);
  await db.prepare('DROP TRIGGER auto_sell_run_packets_insert').run();
  await db
    .prepare(
      'CREATE TRIGGER auto_sell_run_packets_insert BEFORE INSERT ON auto_sell_run_packets BEGIN SELECT 1; END',
    )
    .run();
  await expect(autoSellRunPacketWriteReady(db)).rejects.toMatchObject({
    status: 503,
  });
}
it.each(['native-turso', 'local-d1'] as const)(
  'atomically retains exact unsigned packet pairs and historical recovery on %s',
  async (engine) => {
    const client =
      engine === 'native-turso'
        ? createClient({ url: 'file::memory:' })
        : undefined;
    let mf: Miniflare | undefined;
    try {
      const db = client
        ? createTursoDatabase(client)
        : ((await (mf = new Miniflare({
            telemetry: { enabled: false },
            workers: [
              {
                config: {
                  name: 'auto-sell-packet-local',
                  type: 'worker',
                  compatibilityDate: '2026-09-01',
                  manifest: {
                    mainModule: 'index.js',
                    modules: {
                      'index.js': {
                        type: 'esm',
                        contents:
                          'export default {fetch(){return new Response("unsigned packet archive only")}}',
                      },
                    },
                  },
                  env: { DB: { type: 'd1', id: 'auto-sell-packet-local' } },
                },
              },
            ],
          })).getD1Database(
            'DB',
            'auto-sell-packet-local',
          )) as unknown as D1Database);
      await initializeAutoSellRunPacketStorageFixture(db);
      await exercise(db);
    } finally {
      vi.restoreAllMocks();
      client?.close();
      await mf?.dispose();
    }
  },
);
