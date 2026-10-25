import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createClient, type Client } from '@libsql/client';
import { createHash } from 'node:crypto';
import { createTursoDatabase } from '../db/turso';
import {
  initializeAutoSellRunPacketStorageFixture,
  setupAutoSellRunPacketStorageFixture,
} from '../test/auto-sell-run-packet-storage-fixture';
import {
  autoSellRunPacketWriteReady,
  prepareAutoSellRunPacketWrite,
  readOwnedAutoSellRunPacket,
} from './auto-sell-run-packet-storage';
import { saveSwapPreparation } from './imported-swap-preparation-history';
import {
  stopOwnedAutoSellRun,
  readOwnedAutoSellAttempts,
} from './auto-sell-run-storage';
let client: Client,
  db: D1Database,
  f: Awaited<ReturnType<typeof setupAutoSellRunPacketStorageFixture>>;
const signal = () => new AbortController().signal;
beforeEach(async () => {
  client = createClient({ url: 'file::memory:' });
  db = createTursoDatabase(client);
  await initializeAutoSellRunPacketStorageFixture(db);
  f = await setupAutoSellRunPacketStorageFixture(db);
});
afterEach(() => {
  vi.restoreAllMocks();
  client.close();
});
async function count(table: string) {
  return (await db
    .prepare(`SELECT count(*) AS n FROM ${table} WHERE owner_id=?`)
    .bind(f.owner)
    .first<{ n: number }>())!.n;
}
const read = () =>
  readOwnedAutoSellRunPacket(db, f.owner, f.run.id, f.attempt.id, signal());
const write = (database = db, transaction: unknown = f.transaction) =>
  saveSwapPreparation(
    database,
    f.owner,
    f.context,
    f.summary,
    undefined,
    undefined,
    undefined,
    f.guard!,
    transaction as string,
  );
const originalStatement = (where = '1=1') =>
  db
    .prepare(
      `INSERT INTO imported_swap_preparations(id,owner_id,project_id,project_revision,wallet_address,wallet_revision,document,created_at) SELECT ?,?,?,?,?,?,?,? WHERE ${where}`,
    )
    .bind(
      f.attempt.preparationId,
      f.owner,
      f.projectId,
      1,
      f.context.wallet,
      1,
      f.summaryText,
      new Date().toISOString(),
    );
it('atomically retains original unsigned packet and exact summary through the actual writer', async () => {
  await autoSellRunPacketWriteReady(db);
  const saved = await write();
  expect(saved?.id).toBe(f.attempt.preparationId);
  const r = await read();
  expect(r.status).toBe('retained');
  expect(r.summary?.document).toEqual(f.summary);
  expect(r.packet).toMatchObject({
    transaction: f.transaction,
    packetSha256: f.summary.transaction.sha256,
    packetBytes: f.summary.transaction.bytes,
    signingAllowed: false,
    executionAllowed: false,
    automaticResumeAllowed: false,
  });
  expect(r).toMatchObject({
    signingAllowed: false,
    executionAllowed: false,
    automaticResumeAllowed: false,
  });
  const { sha256, ...body } = r.packet!;
  expect(sha256).toBe(
    createHash('sha256')
      .update(JSON.stringify(['auto-sell-run-packet-v1', body]))
      .digest('hex'),
  );
  expect(await count('auto_sell_run_packets')).toBe(1);
  expect(await count('imported_swap_preparations')).toBe(1);
});
it('retains exact original expiry and bytes after Stop, source archival and wall-clock expiry', async () => {
  await write();
  const before = await read();
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
  vi.spyOn(Date, 'now').mockReturnValue(
    Date.parse(f.summary.expiresAt) + 3600000,
  );
  const recovered = await read();
  expect(recovered).toEqual(before);
  expect(recovered.summary?.document.expiresAt).toBe(f.summary.expiresAt);
  expect(
    (await readOwnedAutoSellAttempts(db, f.owner, f.run.id, signal()))
      .accounting.accountedRaw,
  ).toBe(f.attempt.inputRaw);
});
it('distinguishes a started attempt with no result and one that never started', async () => {
  expect((await read()).status).toBe('started-without-result');
  const other = await setupAutoSellRunPacketStorageFixture(db, {
    start: false,
  });
  const r = await readOwnedAutoSellRunPacket(
    db,
    other.owner,
    other.run.id,
    other.attempt.id,
    signal(),
  );
  expect(r.status).toBe('not-started');
  expect(r.summary).toBeNull();
  expect(r.packet).toBeNull();
});
it('labels legacy exact summaries as summary-only and refuses after-the-fact packet attachment', async () => {
  await originalStatement().run();
  const r = await read();
  expect(r.status).toBe('summary-only');
  expect(r.summary?.id).toBe(f.attempt.preparationId);
  expect(r.packet).toBeNull();
  await expect(
    prepareAutoSellRunPacketWrite(
      db,
      originalStatement('0'),
      f.owner,
      f.attempt.preparationId,
      f.summaryText,
      f.transaction,
      f.summary,
      f.guard!,
    ),
  ).rejects.toMatchObject({ status: 409 });
  expect(await count('auto_sell_run_packets')).toBe(0);
});
it.each([false, true])(
  'aborts a zero-change original insert even if a legacy summary appeared after the pre-read (%s)',
  async (existing) => {
    const commit = await prepareAutoSellRunPacketWrite(
      db,
      originalStatement('0'),
      f.owner,
      f.attempt.preparationId,
      f.summaryText,
      f.transaction,
      f.summary,
      f.guard!,
    );
    if (existing) await originalStatement().run();
    await expect(commit()).rejects.toThrow();
    expect(await count('auto_sell_run_packets')).toBe(0);
    expect(await count('imported_swap_preparations')).toBe(existing ? 1 : 0);
    expect((await read()).status).toBe(
      existing ? 'summary-only' : 'started-without-result',
    );
  },
);
it('rolls back the original summary when the packet insert fails', async () => {
  await db
    .prepare(
      "CREATE TRIGGER synthetic_packet_failure BEFORE INSERT ON auto_sell_run_packets BEGIN SELECT RAISE(ABORT,'synthetic packet persistence failure'); END",
    )
    .run();
  await expect(write()).rejects.toThrow();
  expect(await count('imported_swap_preparations')).toBe(0);
  expect(await count('auto_sell_run_packets')).toBe(0);
  expect(await count('auto_sell_run_preparation_starts')).toBe(1);
  expect((await read()).status).toBe('started-without-result');
});
it('recovers a committed pair after a lost batch reply without another write', async () => {
  const lost = {
    prepare: db.prepare.bind(db),
    async batch(statements: D1PreparedStatement[]) {
      const result = await db.batch(statements);
      if (statements.length === 2)
        throw Error('synthetic lost acknowledgement');
      return result;
    },
  } as D1Database;
  await expect(write(lost)).rejects.toThrow('lost acknowledgement');
  expect((await read()).status).toBe('retained');
  expect(await count('imported_swap_preparations')).toBe(1);
  expect(await count('auto_sell_run_packets')).toBe(1);
  await expect(write()).rejects.toThrow();
  expect(await count('auto_sell_run_packets')).toBe(1);
});
it('does not dispatch the same prepared publication callback twice', async () => {
  const commit = await prepareAutoSellRunPacketWrite(
    db,
    originalStatement(),
    f.owner,
    f.attempt.preparationId,
    f.summaryText,
    f.transaction,
    f.summary,
    f.guard!,
  );
  const result = await commit();
  expect(result.meta.changes).toBe(1);
  await expect(commit()).rejects.toMatchObject({ status: 409 });
  expect((await read()).status).toBe('retained');
});
it.each([
  'auto_sell_run_packets_insert',
  'auto_sell_run_signing_disabled',
  'auto_sell_run_preparations_no_update',
])(
  'detects schema drift with the same object count in %s on every readiness read',
  async (name) => {
    await autoSellRunPacketWriteReady(db);
    const target =
      name === 'auto_sell_run_packets_insert'
        ? 'auto_sell_run_packets'
        : name === 'auto_sell_run_signing_disabled'
          ? 'imported_swap_signing_intents'
          : 'imported_swap_preparations';
    await db.prepare('DROP TRIGGER ' + name).run();
    await db
      .prepare(
        `CREATE TRIGGER ${name} BEFORE INSERT ON ${target} BEGIN SELECT 1; END`,
      )
      .run();
    await expect(autoSellRunPacketWriteReady(db)).rejects.toMatchObject({
      status: 503,
    });
    await expect(read()).rejects.toMatchObject({ status: 503 });
    expect(await count('imported_swap_preparations')).toBe(0);
  },
);
it('refuses disabled foreign keys before any packet write', async () => {
  await client.execute('PRAGMA foreign_keys=OFF');
  await expect(autoSellRunPacketWriteReady(db)).rejects.toMatchObject({
    status: 503,
  });
});
it('keeps foreign owners from inspecting packet or original summary data', async () => {
  await write();
  await expect(
    readOwnedAutoSellRunPacket(
      db,
      'another-owner',
      f.run.id,
      f.attempt.id,
      signal(),
    ),
  ).rejects.toMatchObject({ status: 404 });
});
it.each(['signed', 'mismatch', 'duplicate-summary'])(
  'refuses %s input before summary publication',
  async (kind) => {
    if (kind === 'duplicate-summary') {
      const raw = f.summaryText.replace(
        '"side":"Sell"',
        '"side":"Sell","side":"Sell"',
      );
      await expect(
        prepareAutoSellRunPacketWrite(
          db,
          originalStatement(),
          f.owner,
          f.attempt.preparationId,
          raw,
          f.transaction,
          f.summary,
          f.guard!,
        ),
      ).rejects.toMatchObject({ status: 409 });
    } else
      await expect(
        write(
          db,
          kind === 'signed'
            ? f.native.signed.transaction
            : f.transaction.slice(0, -4) + 'AAAA',
        ),
      ).rejects.toMatchObject({ status: 409 });
    expect(await count('imported_swap_preparations')).toBe(0);
    expect(await count('auto_sell_run_packets')).toBe(0);
  },
);
it('protects immutable packet identity and all rowid aliases with recursive triggers disabled', async () => {
  await write();
  await client.execute('PRAGMA recursive_triggers=OFF');
  for (const sql of [
    'UPDATE auto_sell_run_packets SET transaction_text=transaction_text',
    'DELETE FROM auto_sell_run_packets',
    'INSERT OR REPLACE INTO auto_sell_run_packets SELECT * FROM auto_sell_run_packets',
  ])
    await expect(client.execute(sql)).rejects.toThrow();
  for (const alias of ['rowid', 'oid', '_rowid_'])
    await expect(
      client.execute(
        `INSERT OR REPLACE INTO auto_sell_run_packets(${alias}) VALUES(1)`,
      ),
    ).rejects.toThrow();
  expect((await read()).status).toBe('retained');
});
it('rehashes packet bytes even if corrupted stored metadata has a self-consistent record hash', async () => {
  await write();
  const original = await read();
  const packet = original.packet!;
  const raw = Buffer.from(f.transaction, 'base64');
  raw[raw.length - 1] ^= 1;
  const changed = raw.toString('base64'),
    packetSha256 = createHash('sha256').update(raw).digest('hex');
  const { sha256: _old, ...body } = packet;
  const replaced = { ...body, transaction: changed, packetSha256 };
  const sha256 = createHash('sha256')
    .update(JSON.stringify(['auto-sell-run-packet-v1', replaced]))
    .digest('hex');
  const trigger = (await db
    .prepare(
      "SELECT sql FROM sqlite_master WHERE name='auto_sell_run_packets_no_update'",
    )
    .first<{ sql: string }>())!.sql;
  await db.prepare('DROP TRIGGER auto_sell_run_packets_no_update').run();
  await db
    .prepare(
      'UPDATE auto_sell_run_packets SET transaction_text=?,packet_sha256=?,document=?,sha256=? WHERE owner_id=?',
    )
    .bind(
      changed,
      packetSha256,
      JSON.stringify({ ...replaced, sha256 }),
      sha256,
      f.owner,
    )
    .run();
  await db.prepare(trigger).run();
  await autoSellRunPacketWriteReady(db);
  await expect(read()).rejects.toMatchObject({ status: 503 });
});
