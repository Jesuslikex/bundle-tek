import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createClient, type Client } from '@libsql/client';
import bs58 from 'bs58';
import { Miniflare } from 'miniflare';
import { createTursoDatabase } from '@/db/turso';
import { marketplaceOwnedFixture } from '../test/marketplace-owned-fixture';
import {
  savedEvidenceAuthority,
  savedHistoryCursor,
  savedWalletCursor,
  savedEvidenceCursor,
  SAVED_EVIDENCE_HISTORY_BYTES,
  type SavedEvidenceRequest,
} from './marketplace-saved-evidence';
import {
  readMarketplaceSavedEvidence,
  SavedEvidenceStoredError,
} from './marketplace-saved-evidence-server';

const now = Date.parse('2026-10-24T12:00:00.000Z'),
  fixture = marketplaceOwnedFixture(now),
  signal = () => new AbortController().signal;
let client: Client, db: D1Database;
const address = (index: number) => {
  const bytes = new Uint8Array(32);
  new DataView(bytes.buffer).setUint32(0, index + 1);
  return bs58.encode(bytes);
};
beforeEach(async () => {
  client = createClient({ url: 'file::memory:' });
  db = createTursoDatabase(client);
  const walletDDL = readFileSync(
    new URL('../drizzle/0011_huge_donald_blake.sql', import.meta.url),
    'utf8',
  ).split('--> statement-breakpoint');
  for (const sql of walletDDL.filter((sql) =>
    sql.includes('workspace_wallets'),
  ))
    await db.prepare(sql).run();
  for (const sql of readFileSync(
    new URL('../drizzle/0028_warmup_history_runs.sql', import.meta.url),
    'utf8',
  )
    .split('--> statement-breakpoint')
    .filter((sql) => sql.trim()))
    await db.prepare(sql).run();
  // Real committed table/index DDL only. This does not exercise any financial writer.
});
afterEach(() => {
  vi.restoreAllMocks();
  client.close();
});
const addWallet = (
  wallet = fixture.a,
  owner = 'alice',
  revision = 2,
  archived = 0,
  chain = 'Solana',
  label = 'Saved wallet',
  updated = fixture.date(3600000),
) =>
  db
    .prepare(
      "INSERT INTO workspace_wallets(owner_id,chain,address,folder_id,label,role,archived,revision,updated_at) VALUES(?,?,?,'',?,'holder',?,?,?)",
    )
    .bind(owner, chain, wallet, label, archived, revision, updated)
    .run();
const document = () =>
  JSON.parse(JSON.stringify(fixture.document)) as typeof fixture.document;
const addRun = (
  id = 'run-001',
  doc = JSON.stringify(document()),
  owner = 'alice',
  createdAt = fixture.date(600000),
  updatedAt = fixture.date(100000),
) =>
  db
    .prepare(
      "INSERT INTO warmup_history_runs(owner_id,id,plan_id,plan_revision,document,state,revision,created_at,updated_at) VALUES(?,?,'plan',1,?,'completed',3,?,?)",
    )
    .bind(owner, id, doc, createdAt, updatedAt)
    .run();
const read = (
  request: SavedEvidenceRequest = { view: 'wallets', cursor: null },
  owner = 'alice',
  abort = signal(),
) => readMarketplaceSavedEvidence(db, owner, request, abort, now);
const history = (
  cursor: string | null = null,
  revision = 2,
  wallet = fixture.a,
): SavedEvidenceRequest => ({
  view: 'history',
  address: wallet,
  revision,
  cursor,
});
it('pages current owned Solana wallet metadata20 at a time without provider or proof reads', async () => {
  for (let n = 0; n < 43; n++) await addWallet(address(n));
  await addWallet(fixture.a, 'bob');
  await addWallet(fixture.b, 'alice', 1, 1);
  await addWallet('0x123', 'alice', 1, 0, 'Base');
  const fetcher = vi
    .spyOn(globalThis, 'fetch')
    .mockRejectedValue(Error('provider forbidden'));
  const seen: string[] = [];
  let cursor: string | null = null;
  for (let n = 0; n < 3; n++) {
    const page = await read({ view: 'wallets', cursor });
    expect(page.view).toBe('wallets');
    if (page.view !== 'wallets') throw Error();
    expect(page.wallets).toHaveLength(n < 2 ? 20 : 3);
    seen.push(...page.wallets.map((w) => w.address));
    cursor = page.nextCursor;
    expect(page).toMatchObject({ ...savedEvidenceAuthority, chain: 'Solana' });
    expect(JSON.stringify(page)).not.toMatch(
      /ownershipProof|savedHistoryChecks|oldest|balance|listingEnabled/,
    );
  }
  expect(cursor).toBeNull();
  expect(new Set(seen).size).toBe(43);
  expect(seen).toEqual([...seen].sort());
  expect(fetcher).not.toHaveBeenCalled();
});
it('reads101 legacy history rows through stable timestamp/id pages without total or age claims', async () => {
  await addWallet();
  for (let n = 0; n < 101; n++)
    await addRun('run-' + String(n).padStart(3, '0'));
  const ids: string[] = [];
  let cursor: string | null = null;
  for (let n = 0; n < 6; n++) {
    const page = await read(history(cursor));
    if (page.view !== 'history') throw Error();
    expect(page.records).toHaveLength(n === 5 ? 1 : 20);
    ids.push(...page.records.map((r) => r.id));
    cursor = page.nextCursor;
    expect(JSON.stringify(page)).not.toMatch(
      /observedActivityAge|oldestRecordedActivity|receiptCount|ownershipProof|completeInventory":true|coverageTotal|SECRET/,
    );
  }
  expect(cursor).toBeNull();
  expect(ids).toEqual(
    Array.from(
      { length: 101 },
      (_, n) => 'run-' + String(100 - n).padStart(3, '0'),
    ),
  );
});
it('uses one batch with current owner/address/revision guarded again inside the history query', async () => {
  await addWallet();
  await addRun();
  const batch = vi.spyOn(db, 'batch'),
    prepare = vi.spyOn(db, 'prepare');
  const page = await read(history());
  expect(page.view).toBe('history');
  expect(batch).toHaveBeenCalledOnce();
  const queries = prepare.mock.calls.map(([sql]) => sql);
  expect(queries).toHaveLength(2);
  expect(queries[0]).toContain('w.owner_id=h.owner_id');
  expect(queries[0]).toContain('w.revision=? AND w.archived=0');
  expect(queries.join(' ')).not.toMatch(
    /wallet_warmup_plans|ownership_proofs|buy_receipts|sell_receipts|INSERT|UPDATE|DELETE/,
  );
});
it('keeps each selected run observation distinct and ignores other wallet/private source fields', async () => {
  await addWallet();
  const doc = document();
  doc.wallets.push({ address: fixture.b, revision: 1 });
  doc.results.push({
    address: fixture.b,
    observation: {
      ...fixture.observation,
      address: fixture.b,
      coverage: 'SECRET_OTHER_WALLET',
    },
  });
  await addRun('run-001', JSON.stringify(doc));
  const page = await read(history());
  if (page.view !== 'history') throw Error();
  expect(page.records[0]).toMatchObject({
    id: 'run-001',
    revision: 3,
    capturedWalletRevision: 2,
    outcome: 'observation',
    observation: {
      runId: 'run-001',
      walletRevision: 2,
      balanceLamports: '1234567891',
      source: 'rpc.example',
    },
  });
  expect(JSON.stringify(page)).not.toMatch(
    /SECRET|document|coverage|oldestRecordedActivity|savedHistoryChecks/,
  );
});
it.each(['read-failed', 'not-recorded'] as const)(
  'represents%s without leaking the raw error or claiming zero lifetime history',
  async (outcome) => {
    await addWallet();
    const doc = document();
    const value = {
      ...doc,
      results:
        outcome === 'read-failed'
          ? [{ address: fixture.a, error: 'SECRET_PROVIDER_ERROR' }]
          : [],
    };
    await addRun('run-001', JSON.stringify(value));
    const page = await read(history());
    if (page.view !== 'history') throw Error();
    expect(page.records[0]).toMatchObject({ outcome, observation: null });
    expect(JSON.stringify(page)).not.toMatch(
      /SECRET|failedHistoryChecks|savedHistoryChecks/,
    );
  },
);
it('admits an explicitly older captured revision without rebinding it to the current wallet', async () => {
  await addWallet(fixture.a, 'alice', 3);
  await addRun();
  const page = await read(history(null, 3));
  if (page.view !== 'history') throw Error();
  expect(page.wallet.revision).toBe(3);
  expect(page.records[0].capturedWalletRevision).toBe(2);
  expect(page.records[0].observation?.walletRevision).toBe(2);
});
it('refuses a future captured revision rather than silently omitting it', async () => {
  await addWallet();
  const doc = document();
  doc.wallets[0].revision = 3;
  await addRun('run-001', JSON.stringify(doc));
  await expect(read(history())).rejects.toMatchObject({ status: 503 });
});
it('returns an already byte-bounded prefix without visiting a later invalid-size suffix', async () => {
  await addWallet();
  // The same labelled legacy raw-JSON capacity canary as above; not ordinary
  // writer output or evidence of actual wallet activity.
  const original = JSON.stringify(document()),
    field = JSON.stringify(fixture.observation.coverage);
  const raw = original.replace(
    '"coverage":' + field,
    '"coverage":' +
      JSON.stringify('界'.repeat(120000)) +
      ',"coverage":' +
      field,
  );
  for (let n = 0; n < 25; n++)
    await addRun('run-' + String(n).padStart(3, '0'), raw);
  await db
    .prepare(
      'UPDATE warmup_history_runs SET document=? WHERE owner_id=? AND id=?',
    )
    .bind(original + ' '.repeat(131073), 'alice', 'run-010')
    .run();
  const batch = vi.spyOn(db, 'batch');
  const first = await read(history());
  if (first.view !== 'history') throw Error();
  expect(first.records.map((r) => r.id)).toEqual(
    Array.from(
      { length: 11 },
      (_, n) => 'run-' + String(24 - n).padStart(3, '0'),
    ),
  );
  expect(first.nextCursor).toBe(
    savedHistoryCursor(
      { address: fixture.a, revision: 2 },
      fixture.date(600000),
      'run-014',
    ),
  );
  const metadata = (await batch.mock.results[0].value)[1].results as Array<{
    id: string;
    ordinal: number;
    document: string | null;
  }>;
  expect(metadata.find((row) => row.id === 'run-010')).toMatchObject({
    ordinal: 15,
    document: null,
  });
  expect(metadata.slice(11).every((row) => row.document === null)).toBe(true);
  // The cursor did not skip the invalid run. It falls inside the next attempted
  // prefix, which refuses completely instead of returning the preceding3 rows.
  await expect(read(history(first.nextCursor))).rejects.toMatchObject({
    status: 503,
  });
});
it.each([
  { owner: 'bob', archived: 0, revision: 2, status: 404 },
  { owner: 'alice', archived: 1, revision: 2, status: 409 },
  { owner: 'alice', archived: 0, revision: 3, status: 409 },
])(
  'distinguishes unavailable or changed current wallet $status',
  async ({ owner, archived, revision, status }) => {
    await addWallet(fixture.a, owner, revision, archived);
    await addRun();
    await expect(read(history())).rejects.toMatchObject({ status });
  },
);
it('does not disclose another owner history even for the same public wallet', async () => {
  await addWallet();
  await addWallet(fixture.a, 'bob');
  await addRun('bob-only', JSON.stringify(document()), 'bob');
  const page = await read(history());
  if (page.view !== 'history') throw Error();
  expect(page.records).toEqual([]);
});
it('does not join a current plan or require provider or lifecycle evidence', async () => {
  await addWallet();
  await addRun();
  const page = await read(history());
  expect(page).toMatchObject(savedEvidenceAuthority);
});
it('returns a21st lookahead as metadata only and uses the last returned row cursor', async () => {
  await addWallet();
  for (let n = 0; n < 21; n++)
    await addRun('run-' + String(n).padStart(3, '0'));
  const batch = vi.spyOn(db, 'batch');
  const page = await read(history());
  if (page.view !== 'history') throw Error();
  const rows = (await batch.mock.results[0].value)[1].results as Array<{
    ordinal: number;
    document: string | null;
  }>;
  expect(rows).toHaveLength(21);
  expect(rows[20]).toMatchObject({ ordinal: 21, document: null });
  expect(page.nextCursor).toBe(
    savedHistoryCursor(
      history() as Extract<SavedEvidenceRequest, { view: 'history' }>,
      page.records[19].createdAt,
      page.records[19].id,
    ),
  );
});
it('does not fetch an oversized sentinel body or skip it on the next page', async () => {
  await addWallet();
  for (let n = 1; n <= 20; n++)
    await addRun('run-' + String(n).padStart(3, '0'));
  await addRun('run-000', JSON.stringify(document()) + ' '.repeat(131073));
  const page = await read(history());
  if (page.view !== 'history') throw Error();
  expect(page.records).toHaveLength(20);
  await expect(read(history(page.nextCursor))).rejects.toMatchObject({
    status: 503,
  });
});
it('bounds a multibyte raw JSON prefix to4MiB and resumes before its first omitted row', async () => {
  await addWallet();
  // Raw-byte capacity fixture. Duplicate coverage keys deliberately retain the
  // unchanged JSON.parse last-key semantics; SQL membership keys are unaffected.
  const original = JSON.stringify(document());
  const field = JSON.stringify(fixture.observation.coverage);
  const raw = original.replace(
    '"coverage":' + field,
    '"coverage":' +
      JSON.stringify('界'.repeat(120000)) +
      ',"coverage":' +
      field,
  );
  expect(raw.length).toBeLessThan(131072);
  expect(new TextEncoder().encode(raw).length).toBeGreaterThan(300000);
  for (let n = 0; n < 25; n++)
    await addRun('run-' + String(n).padStart(3, '0'), raw);
  let cursor: string | null = null;
  const seen: string[] = [];
  const batch = vi.spyOn(db, 'batch');
  for (let n = 0; n < 3; n++) {
    const page = await read(history(cursor));
    if (page.view !== 'history') throw Error();
    expect(page.records).toHaveLength(n < 2 ? 11 : 3);
    seen.push(...page.records.map((r) => r.id));
    cursor = page.nextCursor;
    const rows = (await batch.mock.results[n].value)[1].results as Array<{
      document: string | null;
    }>;
    expect(
      rows.reduce(
        (sum, row) =>
          sum +
          (row.document === null
            ? 0
            : new TextEncoder().encode(row.document).length),
        0,
      ),
    ).toBeLessThanOrEqual(SAVED_EVIDENCE_HISTORY_BYTES);
  }
  expect(cursor).toBeNull();
  expect(new Set(seen).size).toBe(25);
  expect(seen).toEqual(
    Array.from(
      { length: 25 },
      (_, n) => 'run-' + String(24 - n).padStart(3, '0'),
    ),
  );
});
it.each([
  'invalid-json',
  'oversized-first',
  'oversized-second',
  'astral-js-length',
])('refuses%s without a partial page', async (kind) => {
  await addWallet();
  const original = JSON.stringify(document());
  if (kind === 'oversized-second') await addRun('run-002');
  let raw =
    kind === 'invalid-json' ? 'SECRET_NOT_JSON' : original + ' '.repeat(131073);
  if (kind === 'astral-js-length')
    raw = original.replace(
      '"coverage":' + JSON.stringify(fixture.observation.coverage),
      '"coverage":' +
        JSON.stringify('😀'.repeat(70000)) +
        ',"coverage":' +
        JSON.stringify(fixture.observation.coverage),
    );
  await addRun('run-001', raw);
  await expect(read(history())).rejects.toMatchObject({
    status: 503,
    message: 'Saved wallet evidence is unavailable. No partial page is shown.',
  });
});
it.each(['duplicate-membership', 'invalid-observation', 'invalid-revision'])(
  'refuses%s instead of projecting incomplete evidence',
  async (kind) => {
    await addWallet();
    const doc = document();
    if (kind === 'duplicate-membership')
      doc.wallets.push({ ...doc.wallets[0] });
    if (kind === 'invalid-observation')
      doc.results[0].observation.successfulSampleCount = 51;
    if (kind === 'invalid-revision') doc.wallets[0].revision = 0;
    await addRun('run-001', JSON.stringify(doc));
    await expect(read(history())).rejects.toMatchObject({ status: 503 });
  },
);
it.each(['id', 'created_at', 'updated_at'])(
  'refuses oversized metadata%s rather than silently truncating it',
  async (column) => {
    await addWallet();
    await addRun();
    await db
      .prepare(`UPDATE warmup_history_runs SET ${column}=?`)
      .bind('x'.repeat(10000))
      .run();
    await expect(read(history())).rejects.toMatchObject({ status: 503 });
  },
);
it('refuses oversized wallet labels and invalid addresses rather than truncating them', async () => {
  await addWallet(fixture.a, 'alice', 2, 0, 'Solana', 'x'.repeat(10000));
  await expect(read()).rejects.toMatchObject({ status: 503 });
  await db
    .prepare("UPDATE workspace_wallets SET label='valid',address=?")
    .bind('x'.repeat(10000))
    .run();
  await expect(read()).rejects.toMatchObject({ status: 503 });
});
it('rejects mismatched cursor scope before database access', async () => {
  const prepare = vi.spyOn(db, 'prepare');
  await expect(
    read(
      history(
        savedHistoryCursor(
          { address: fixture.b, revision: 2 },
          fixture.date(600000),
          'run-001',
        ),
      ),
    ),
  ).rejects.toBeInstanceOf(SavedEvidenceStoredError);
  expect(prepare).not.toHaveBeenCalled();
});
it('captures request identity before awaiting the database', async () => {
  await addWallet();
  await addRun();
  const request = history();
  const original = db.batch.bind(db);
  vi.spyOn(db, 'batch').mockImplementation(async (statements) => {
    const result = await original(statements);
    if (request.view === 'history') request.address = fixture.b;
    return result;
  });
  expect((await read(request)).request).toEqual(history());
});
it('cancels before database access and discards a late batch result', async () => {
  const c = new AbortController(),
    reason = Error('cancelled'),
    prepare = vi.spyOn(db, 'prepare');
  c.abort(reason);
  await expect(read(history(), 'alice', c.signal)).rejects.toBe(reason);
  expect(prepare).not.toHaveBeenCalled();
  prepare.mockRestore();
  await addWallet();
  await addRun();
  const later = new AbortController(),
    batch = db.batch.bind(db);
  vi.spyOn(db, 'batch').mockImplementation(async (statements) => {
    const result = await batch(statements);
    later.abort(reason);
    return result;
  });
  await expect(read(history(), 'alice', later.signal)).rejects.toBe(reason);
});
it('fails closed if either source table is unavailable', async () => {
  await addWallet();
  await db.prepare('DROP TABLE warmup_history_runs').run();
  await expect(read(history())).rejects.toMatchObject({ status: 503 });
});
it('retains exact wallet cursor scope without treating it as authorization', async () => {
  await addWallet();
  const page = await read(
    { view: 'wallets', cursor: savedWalletCursor(fixture.a) },
    'bob',
  );
  if (page.view !== 'wallets') throw Error();
  expect(page.wallets).toEqual([]);
});
it('keeps the same raw character-sized ASCII control inside a full20-row page', async () => {
  await addWallet();
  const original = JSON.stringify(document()),
    field = JSON.stringify(fixture.observation.coverage);
  const raw = original.replace(
    '"coverage":' + field,
    '"coverage":' + JSON.stringify('x'.repeat(120000)) + ',"coverage":' + field,
  );
  for (let n = 0; n < 21; n++)
    await addRun('run-' + String(n).padStart(3, '0'), raw);
  const batch = vi.spyOn(db, 'batch'),
    page = await read(history());
  if (page.view !== 'history') throw Error();
  expect(page.records).toHaveLength(20);
  const rows = (await batch.mock.results[0].value)[1].results as Array<{
    document: string | null;
  }>;
  expect(rows.filter((row) => row.document !== null)).toHaveLength(20);
  expect(
    rows.reduce(
      (sum, row) =>
        sum +
        (row.document === null
          ? 0
          : new TextEncoder().encode(row.document).length),
      0,
    ),
  ).toBeLessThan(SAVED_EVIDENCE_HISTORY_BYTES);
});
it('suppresses every document after a malformed-size row within the attempted page', async () => {
  await addWallet();
  await addRun('run-003');
  await addRun('run-002', JSON.stringify(document()) + ' '.repeat(131073));
  await addRun('run-001');
  const batch = vi.spyOn(db, 'batch');
  await expect(read(history())).rejects.toMatchObject({ status: 503 });
  const rows = (await batch.mock.results[0].value)[1].results as Array<{
    id: string;
    document: string | null;
  }>;
  expect(rows[0].document).not.toBeNull();
  expect(rows[1].document).toBeNull();
  expect(rows[2].document).toBeNull();
});
it('runs the same owner-bound window/prefix query against disposable nativeD1', async () => {
  const mf = new Miniflare({
    telemetry: { enabled: false },
    workers: [
      {
        config: {
          name: 'saved-evidence-only',
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
          env: { DB: { type: 'd1', id: 'saved-evidence-only' } },
        },
      },
    ],
  });
  const before = db;
  try {
    db = (await mf.getD1Database(
      'DB',
      'saved-evidence-only',
    )) as unknown as D1Database;
    for (const sql of readFileSync(
      new URL('../drizzle/0011_huge_donald_blake.sql', import.meta.url),
      'utf8',
    )
      .split('--> statement-breakpoint')
      .filter((sql) => sql.includes('workspace_wallets')))
      await db.prepare(sql).run();
    for (const sql of readFileSync(
      new URL('../drizzle/0028_warmup_history_runs.sql', import.meta.url),
      'utf8',
    )
      .split('--> statement-breakpoint')
      .filter((sql) => sql.trim()))
      await db.prepare(sql).run();
    await addWallet();
    await addWallet(fixture.a, 'bob');
    await addRun('foreign', JSON.stringify(document()), 'bob');
    for (let n = 0; n < 21; n++)
      await addRun('run-' + String(n).padStart(3, '0'));
    const page = await read(history());
    if (page.view !== 'history') throw Error();
    expect(page.records).toHaveLength(20);
    expect(page.records.every((row) => row.id.startsWith('run-'))).toBe(true);
    const next = await read(history(page.nextCursor));
    if (next.view !== 'history') throw Error();
    expect(next.records).toHaveLength(1);
    expect(next.nextCursor).toBeNull();
    expect(page).toMatchObject(savedEvidenceAuthority);
  } finally {
    db = before;
    await mf.dispose();
  }
});
it('round trips printable legacy run IDs and safely pages their exact SQLite ASCII order', async () => {
  await addWallet();
  const ids = [
    ' legacy',
    'legacy ',
    '/',
    '+legacy',
    '_legacy',
    '.legacy',
    '-legacy',
    ' ',
    '[]{}:"',
    ...Array.from(
      { length: 18 },
      (_, n) => 'row ' + String(n).padStart(2, '0'),
    ),
  ];
  for (const id of ids) await addRun(id);
  let cursor: string | null = null;
  const observed: string[] = [];
  do {
    const page = await read(history(cursor));
    if (page.view !== 'history') throw Error();
    observed.push(...page.records.map((row) => row.id));
    cursor = page.nextCursor;
    if (cursor !== null)
      expect(savedEvidenceCursor(history(cursor))).toEqual({
        createdAt: page.records.at(-1)!.createdAt,
        id: page.records.at(-1)!.id,
      });
  } while (cursor !== null);
  expect(observed).toEqual(
    [...ids].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0)),
  );
  for (const id of ids)
    expect(
      savedEvidenceCursor(
        history(
          savedHistoryCursor(
            { address: fixture.a, revision: 2 },
            fixture.date(600000),
            id,
          ),
        ),
      ),
    ).toEqual({ createdAt: fixture.date(600000), id });
});
it.each(['id', 'date'] as const)(
  'does not let a hidden21st bad%s block its valid page, but refuses when reached',
  async (field) => {
    await addWallet();
    for (let n = 1; n <= 20; n++)
      await addRun('run-' + String(n).padStart(3, '0'));
    const hiddenId = field === 'id' ? '\u0001hidden' : 'hidden-date';
    await addRun(
      hiddenId,
      JSON.stringify(document()),
      'alice',
      field === 'date' ? '0000-invalid-date' : fixture.date(600000),
    );
    const page = await read(history());
    if (page.view !== 'history') throw Error();
    expect(page.records).toHaveLength(20);
    expect(page.records.every((row) => row.id.startsWith('run-'))).toBe(true);
    expect(page.nextCursor).toBe(
      savedHistoryCursor(
        { address: fixture.a, revision: 2 },
        fixture.date(600000),
        'run-001',
      ),
    );
    await expect(read(history(page.nextCursor))).rejects.toMatchObject({
      status: 503,
    });
  },
);
it.each(['id', 'date'] as const)(
  'does not validate hidden bad%s after the byte cut, and never skips it',
  async (field) => {
    await addWallet();
    // Legacy raw JSON/decoder-capacity canary, not normal writer output or
    // evidence of actual history. SQL membership keys are not duplicated here.
    const original = JSON.stringify(document()),
      coverage = JSON.stringify(fixture.observation.coverage);
    const raw = original.replace(
      '"coverage":' + coverage,
      '"coverage":' +
        JSON.stringify('界'.repeat(120000)) +
        ',"coverage":' +
        coverage,
    );
    for (let n = 0; n < 25; n++)
      await addRun(
        'run-' + String(n).padStart(3, '0'),
        raw,
        'alice',
        fixture.date(600000 + (24 - n) * 1000),
      );
    if (field === 'id')
      await db
        .prepare(
          "UPDATE warmup_history_runs SET id=? WHERE owner_id='alice' AND id='run-010'",
        )
        .bind('run-010\u0001')
        .run();
    else
      await db
        .prepare(
          "UPDATE warmup_history_runs SET created_at=? WHERE owner_id='alice' AND id='run-010'",
        )
        .bind(fixture.date(614000) + 'x')
        .run();
    const batch = vi.spyOn(db, 'batch'),
      page = await read(history());
    if (page.view !== 'history') throw Error();
    expect(page.records.map((row) => row.id)).toEqual(
      Array.from(
        { length: 11 },
        (_, n) => 'run-' + String(24 - n).padStart(3, '0'),
      ),
    );
    expect(page.nextCursor).toBe(
      savedHistoryCursor(
        { address: fixture.a, revision: 2 },
        fixture.date(610000),
        'run-014',
      ),
    );
    const rows = (await batch.mock.results[0].value)[1].results as Array<{
      ordinal: number;
      document: string | null;
    }>;
    expect(rows[14]).toMatchObject({ ordinal: 15, document: null });
    await expect(read(history(page.nextCursor))).rejects.toMatchObject({
      status: 503,
    });
  },
);
it.each(['chain', 'wallets'] as const)(
  'labels partial matching scope when SQLite sees the first duplicate%s key',
  async (field) => {
    await addWallet();
    await addRun('normal');
    const ordinary = JSON.stringify(document());
    const prefix =
      field === 'chain'
        ? '"chain":"Base",'
        : '"wallets":' +
          JSON.stringify([{ address: fixture.b, revision: 1 }]) +
          ',';
    const raw = '{' + prefix + ordinary.slice(1);
    expect(JSON.parse(raw)).toEqual(document());
    await addRun('sql-nonmatch', raw);
    const page = await read(history());
    if (page.view !== 'history') throw Error();
    expect(page.records.map((row) => row.id)).toEqual(['normal']);
    expect(page).toMatchObject({
      completeHistory: false,
      completeInventory: false,
      controlProven: false,
    });
  },
);
it.each(['chain', 'wallets'] as const)(
  'refuses conflicting last-key duplicate%s data that SQLite selected',
  async (field) => {
    await addWallet();
    const ordinary = JSON.stringify(document());
    const suffix =
      field === 'chain'
        ? ',"chain":"Base"}'
        : ',"wallets":' +
          JSON.stringify([{ address: fixture.b, revision: 1 }]) +
          '}';
    await addRun('conflicting', ordinary.slice(0, -1) + suffix);
    await expect(read(history())).rejects.toMatchObject({ status: 503 });
  },
);
it('retains a legacy wallet label only as literal metadata without authority or HTML interpretation', async () => {
  const label = '<img src=x onerror=alert(1)>';
  await addWallet(fixture.a, 'alice', 2, 0, 'Solana', label);
  const page = await read();
  if (page.view !== 'wallets') throw Error();
  expect(page.wallets[0].label).toBe(label);
  expect(page).toMatchObject(savedEvidenceAuthority);
});
