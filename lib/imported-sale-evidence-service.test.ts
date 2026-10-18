import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { afterEach, beforeAll, expect, it } from 'vitest';
import { importedSaleEvidenceFixture } from '../test/imported-sale-evidence-fixture';
import { collectImportedSaleEvidence } from './imported-sale-evidence';
import {
  canonicalPumpHolderJson as canonical,
  pumpHolderDigest,
} from './pump-holder-review';
import {
  readOwnedImportedSaleEvidence as read,
  readOwnedImportedSaleSource as source,
  retainOwnedImportedSaleEvidence as retain,
} from './imported-sale-evidence-service';
const signal = () => new AbortController().signal;
let f: Awaited<ReturnType<typeof importedSaleEvidenceFixture>>;
const databases: DatabaseSync[] = [];
beforeAll(async () => {
  f = await importedSaleEvidenceFixture(true);
});
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
function database(install = true) {
  const sqlite = new DatabaseSync(':memory:');
  databases.push(sqlite);
  // Original table definitions/constraints; historical approval admission is not
  // exercised here. Synthetic finalized parents are seeded explicitly below.
  for (const name of [
    '0041_imported_swap_preparations',
    '0047_shared_swap_reservations',
  ]) {
    for (const statement of readFileSync(`drizzle/${name}.sql`, 'utf8').split(
      '--> statement-breakpoint',
    )) {
      if (/^\s*CREATE (?:TABLE|(?:UNIQUE )?INDEX)\s/.test(statement))
        sqlite.exec(statement);
    }
  }
  sqlite.exec(
    'CREATE TABLE imported_token_project_gates(owner_id TEXT PRIMARY KEY,next_allowed_at INTEGER NOT NULL)',
  );
  const p = structuredClone(f.p),
    date = new Date().toISOString();
  sqlite
    .prepare('INSERT INTO imported_swap_preparations VALUES(?,?,?,?,?,?,?,?)')
    .run(
      p.preparationId,
      p.ownerId,
      p.projectId,
      1,
      p.wallet,
      1,
      p.preparationDocument,
      date,
    );
  sqlite
    .prepare(
      'INSERT INTO imported_swap_signing_intents VALUES(?,?,?,?,?,?,?,?,?)',
    )
    .run(
      p.intentId,
      p.ownerId,
      p.preparationId,
      p.wallet,
      p.approvalDocument,
      'finalized',
      p.signature,
      date,
      date,
    );
  sqlite
    .prepare('INSERT INTO imported_swap_receipts VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run(
      p.receiptId,
      p.ownerId,
      p.intentId,
      p.preparationId,
      p.projectId,
      1,
      1,
      p.signature,
      p.receiptDocument,
      date,
    );
  sqlite
    .prepare('INSERT INTO solana_swap_signatures VALUES(?,?,?,?)')
    .run(p.ownerId, p.signature, 'imported', p.intentId);
  if (install)
    sqlite.exec(
      readFileSync('drizzle/0115_imported_sale_receipt_evidence.sql', 'utf8'),
    );
  const hooks: {
    beforeInsert?: () => void;
    afterInsert?: () => void;
    beforeFirst?: (sql: string) => void;
  } = {};
  const db = {
    prepare(sql: string) {
      let values: SQLInputValue[] = [];
      return {
        bind(...v: SQLInputValue[]) {
          values = v;
          return this;
        },
        async first() {
          hooks.beforeFirst?.(sql);
          return sqlite.prepare(sql).get(...values) ?? null;
        },
        async run() {
          const insert = sql.startsWith(
            'INSERT INTO imported_sale_receipt_evidence',
          );
          if (insert) hooks.beforeInsert?.();
          const result = sqlite.prepare(sql).run(...values);
          if (insert) hooks.afterInsert?.();
          return { meta: { changes: Number(result.changes) } };
        },
      };
    },
  } as unknown as D1Database;
  const count = () =>
    Number(
      sqlite
        .prepare('SELECT count(*) AS n FROM imported_sale_receipt_evidence')
        .get()!.n,
    );
  return { sqlite, db, hooks, p, count };
}
it('retains original Token2022 evidence once, reloads without RPC and never exposes packet bytes', async () => {
  const d = database();
  const before = await read(d.db, 'alice', d.p.receiptId, signal());
  expect(before.entry).toBeNull();
  const calls: string[] = [];
  const rpc: typeof f.rpc = async (m, p, s) => {
    calls.push(m);
    return f.rpc(m, p, s);
  };
  const saved = await retain(d.db, 'alice', d.p.receiptId, signal(), rpc);
  expect(saved.entry).toMatchObject({
    tokenUnitsRaw: '1000',
    nativeSettlementRaw: '1000000',
    executionAllowed: false,
    profitCalculated: false,
  });
  expect(calls).toEqual(['getGenesisHash', 'getTransaction']);
  const forbidden = async () => {
    throw Error('Saved reload must not use RPC');
  };
  expect(
    await retain(d.db, 'alice', d.p.receiptId, signal(), forbidden),
  ).toEqual(saved);
  expect(await read(d.db, 'alice', d.p.receiptId, signal())).toEqual(saved);
  expect(JSON.stringify(saved)).not.toContain(f.raw.transaction[0]);
  const internal = await source(d.db, 'alice', d.p.receiptId, signal());
  expect(internal.evidence.raw.transaction).toEqual(f.raw.transaction);
  expect(d.count()).toBe(1);
});
it('fails closed for another owner, unavailable schema and missing retained proof', async () => {
  const d = database(),
    absent = database(false);
  await expect(
    read(d.db, 'bob', d.p.receiptId, signal()),
  ).rejects.toMatchObject({ status: 404 });
  await expect(
    source(d.db, 'alice', d.p.receiptId, signal()),
  ).rejects.toMatchObject({ status: 404 });
  await expect(
    read(absent.db, 'alice', absent.p.receiptId, signal()),
  ).rejects.toMatchObject({ status: 503 });
  expect(d.count()).toBe(0);
});
it('rejects a Buy parent before returning empty history or writing the throttle gate', async () => {
  const d = database();
  d.sqlite
    .prepare('UPDATE imported_swap_receipts SET document=?')
    .run(d.p.receiptDocument.replace('"side":"Sell"', '"side":"Buy"'));
  await expect(read(d.db, 'alice', d.p.receiptId, signal())).rejects.toThrow();
  await expect(
    retain(d.db, 'alice', d.p.receiptId, signal(), f.rpc),
  ).rejects.toThrow();
  expect(
    d.sqlite
      .prepare('SELECT count(*) AS n FROM imported_token_project_gates')
      .get()!.n,
  ).toBe(0);
});
it('recovers a committed insert whose response is lost without duplicate evidence or RPC retry', async () => {
  const d = database();
  d.hooks.afterInsert = () => {
    throw Error('Lost response');
  };
  const saved = await retain(d.db, 'alice', d.p.receiptId, signal(), f.rpc);
  expect(saved.entry).not.toBeNull();
  expect(d.count()).toBe(1);
  expect(await read(d.db, 'alice', d.p.receiptId, signal())).toEqual(saved);
});
it('refuses changed parents at insertion, then requires a new retained-source read', async () => {
  const d = database();
  d.hooks.beforeInsert = () =>
    d.sqlite
      .prepare('UPDATE imported_swap_preparations SET document=?')
      .run(d.p.preparationDocument + ' ');
  await expect(
    retain(d.db, 'alice', d.p.receiptId, signal(), f.rpc),
  ).rejects.toThrow('changed');
  expect(d.count()).toBe(0);
});
it('refuses changed signature registration at insertion', async () => {
  const d = database();
  d.hooks.beforeInsert = () =>
    d.sqlite.exec("UPDATE solana_swap_signatures SET scope='warmup'");
  await expect(
    retain(d.db, 'alice', d.p.receiptId, signal(), f.rpc),
  ).rejects.toThrow('changed');
  expect(d.count()).toBe(0);
});
it('throttles failed captures and leaves saved-only reads available', async () => {
  const d = database();
  await expect(
    retain(d.db, 'alice', d.p.receiptId, signal(), async () => {
      throw Error('Provider unavailable');
    }),
  ).rejects.toThrow();
  await expect(
    retain(d.db, 'alice', d.p.receiptId, signal(), f.rpc),
  ).rejects.toMatchObject({ status: 429 });
  expect((await read(d.db, 'alice', d.p.receiptId, signal())).entry).toBeNull();
  expect(d.count()).toBe(0);
});
it('does not insert after cancellation during provider IO, and recovers saved state after late cancellation', async () => {
  const d = database(),
    c = new AbortController();
  await expect(
    retain(d.db, 'alice', d.p.receiptId, c.signal, async (m, p, s) => {
      const v = await f.rpc(m, p, s);
      if (m === 'getTransaction') c.abort();
      return v;
    }),
  ).rejects.toThrow();
  expect(d.count()).toBe(0);
  d.sqlite.exec('DELETE FROM imported_token_project_gates');
  const late = new AbortController();
  d.hooks.afterInsert = () => late.abort();
  await expect(
    retain(d.db, 'alice', d.p.receiptId, late.signal, f.rpc),
  ).rejects.toThrow();
  expect(d.count()).toBe(1);
  expect(
    (await read(d.db, 'alice', d.p.receiptId, signal())).entry,
  ).not.toBeNull();
});
it('refuses publication if a source changes during an empty-history read', async () => {
  const d = database();
  let reads = 0;
  d.hooks.beforeFirst = (sql) => {
    if (sql.startsWith('SELECT r.owner_id') && ++reads === 2)
      d.sqlite.exec("UPDATE imported_swap_receipts SET document=document||' '");
  };
  await expect(read(d.db, 'alice', d.p.receiptId, signal())).rejects.toThrow(
    'source changed',
  );
});
it('rejects corruption even if a stored report and its digest are both replaced', async () => {
  const d = database();
  await retain(d.db, 'alice', d.p.receiptId, signal(), f.rpc);
  const row = d.sqlite
    .prepare('SELECT evidence FROM imported_sale_receipt_evidence')
    .get()!;
  const e = JSON.parse(String(row.evidence));
  e.report.nativeSettlementRaw = '1000001';
  const { sha256: _, ...core } = e;
  e.sha256 = await pumpHolderDigest(core);
  d.sqlite.exec('DROP TRIGGER imported_sale_evidence_no_update');
  d.sqlite
    .prepare('UPDATE imported_sale_receipt_evidence SET evidence=?,sha256=?')
    .run(canonical(e), e.sha256);
  // Reinstall the actual guard so refusal exercises parser replay, not only guard inventory.
  d.sqlite.exec(
    readFileSync('drizzle/0115_imported_sale_receipt_evidence.sql', 'utf8')
      .split('--> statement-breakpoint')
      .find((s) =>
        s.includes('CREATE TRIGGER imported_sale_evidence_no_update'),
      )!,
  );
  await expect(read(d.db, 'alice', d.p.receiptId, signal())).rejects.toThrow();
});
it('SQL protects retained evidence and every captured parent while allowing unrelated timestamps', async () => {
  const d = database();
  await retain(d.db, 'alice', d.p.receiptId, signal(), f.rpc);
  for (const table of [
    'imported_sale_receipt_evidence',
    'imported_swap_receipts',
    'imported_swap_preparations',
    'imported_swap_signing_intents',
    'solana_swap_signatures',
  ]) {
    const column =
      table === 'imported_sale_receipt_evidence'
        ? 'evidence'
        : table === 'solana_swap_signatures'
          ? 'scope'
          : 'document';
    expect(() =>
      d.sqlite.exec(`UPDATE ${table} SET ${column}=${column}`),
    ).toThrow('immutable');
    expect(() => d.sqlite.exec(`DELETE FROM ${table}`)).toThrow('immutable');
  }
  d.sqlite.exec(
    "UPDATE imported_swap_signing_intents SET updated_at='2026-10-18T23:59:59.000Z'",
  );
  expect(
    (await read(d.db, 'alice', d.p.receiptId, signal())).entry,
  ).not.toBeNull();
});
it('SQL refuses wrong owner, parent snapshot, report context and enabled authority', async () => {
  const d = database();
  const e = await collectImportedSaleEvidence(d.p, signal(), f.rpc);
  const insert = d.sqlite.prepare(
    'INSERT INTO imported_sale_receipt_evidence VALUES(?,?,?,?,?,?,?,?)',
  );
  for (const change of [
    'owner',
    'parent',
    'wallet',
    'units',
    'authority',
    'boolean',
  ]) {
    const value = structuredClone(e),
      p = structuredClone(d.p);
    if (change === 'parent') p.projectRevision++;
    if (change === 'wallet')
      value.report.wallet = '11111111111111111111111111111111';
    if (change === 'units') value.report.acquiredRaw = '999';
    if (change === 'authority')
      (value as unknown as Record<string, unknown>).signingAllowed = true;
    if (change === 'boolean')
      (value as unknown as Record<string, unknown>).executionAllowed = 0;
    expect(() =>
      insert.run(
        change === 'owner' ? 'bob' : 'alice',
        p.receiptId,
        p.signature,
        canonical(p),
        value.parentSha256,
        canonical(value),
        value.sha256,
        value.observedAt,
      ),
    ).toThrow();
  }
  expect(d.count()).toBe(0);
});
