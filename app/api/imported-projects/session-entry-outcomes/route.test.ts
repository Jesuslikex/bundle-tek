import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  it,
  vi,
} from 'vitest';
import { readFile } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import { nativeWarmupFixture } from '../../../../test/warmup-native-fixture';
import { unsignedPreparationSummary } from '@/lib/imported-swap-preparation-history';
import { captureTradeSession } from '@/lib/imported-trade-session-server';
import {
  decodeTradeSession,
  type TradeSession,
} from '@/lib/imported-trade-session';
import { decodeSessionEntryOutcomes } from '@/lib/session-entry-outcomes';
import {
  queueSessionPreparation,
  runSessionPreparationJobs,
} from '@/lib/session-preparation-jobs';
import { decodeWarmupReceipt } from '@/lib/warmup-buy-receipt';
import {
  requireWarmupSigningReview,
  type WarmupSigningReview,
} from '@/lib/warmup-signing';
const context = vi.hoisted(() => ({
  user: null as { userId: string } | null,
  db: null as unknown as D1Database,
}));
vi.mock('@/app/chatgpt-auth', () => ({
  getChatGPTUser: async () => context.user,
}));
vi.mock('@/db', () => ({ getD1: () => context.db }));
import { GET } from './route';
import { POST as manageSession } from '../trade-sessions/route';

let mf: Miniflare,
  db: D1Database,
  owner: string,
  projectId: string,
  session: TradeSession;
let fixtures: Awaited<ReturnType<typeof nativeWarmupFixture>>[];
let sellFixture: Awaited<ReturnType<typeof nativeWarmupFixture>>;
let migrationCount = 0;
const post = (body: unknown) =>
  manageSession(
    new Request('http://localhost/api/imported-projects/trade-sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
const query = (scope: Record<string, string> = { sessionId: session.id }) =>
  new Request(
    'http://localhost/api/imported-projects/session-entry-outcomes?' +
      new URLSearchParams({ projectId, ...scope }),
  );
const scope = () => ({ owner, projectId, sessionId: session.id });
const cancel = () =>
  post({ action: 'cancel', id: session.id, projectId, revision: 1 });
beforeAll(async () => {
  mf = new Miniflare({
    telemetry: { enabled: false },
    workers: [
      {
        config: {
          name: 'session-outcomes-test',
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
          env: { DB: { type: 'd1', id: 'session-outcomes-disposable' } },
        },
      },
    ],
  });
  db = await mf.getD1Database('DB', 'session-outcomes-test');
  const journal = JSON.parse(
    await readFile('drizzle/meta/_journal.json', 'utf8'),
  ) as { entries: { tag: string }[] };
  migrationCount = journal.entries.length;
  for (const { tag } of journal.entries) {
    const sql = await readFile(`drizzle/${tag}.sql`, 'utf8');
    await db.batch(
      sql
        .split('--> statement-breakpoint')
        .filter((s) => s.trim())
        .map((s) => db.prepare(s)),
    );
  }
  fixtures = await Promise.all(
    Array.from({ length: 6 }, (_, i) =>
      nativeWarmupFixture({ lookup: true, v2: true, walletSeed: 7 + i }),
    ),
  );
  sellFixture = await nativeWarmupFixture({
    side: 'Sell',
    lookup: true,
    v2: true,
  });
});
afterAll(async () => {
  await mf?.dispose();
});
beforeEach(async () => {
  owner = crypto.randomUUID();
  projectId = crypto.randomUUID();
  context.user = { userId: owner };
  context.db = db;
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('External provider calls forbidden.');
    }),
  );
  const now = new Date().toISOString();
  await db
    .prepare(
      "INSERT INTO imported_token_projects(owner_id,id,chain,address,document,revision,archived,mutation_id,updated_at) VALUES(?,?,'Solana',?,?,1,0,?,?)",
    )
    .bind(
      owner,
      projectId,
      fixtures[0].mint,
      JSON.stringify({
        token: { chain: 'Solana', address: fixtures[0].mint, decimals: 6 },
      }),
      crypto.randomUUID(),
      now,
    )
    .run();
  for (const f of fixtures)
    await db
      .prepare(
        "INSERT INTO workspace_wallets(owner_id,chain,address,folder_id,label,role,archived,revision,updated_at) VALUES(?,'Solana',?,'default','Synthetic wallet','trade',0,1,?)",
      )
      .bind(owner, f.wallet, now)
      .run();
  const response = await post({
    action: 'create',
    id: crypto.randomUUID(),
    projectId,
    projectRevision: 1,
    side: 'Buy',
    entries: fixtures.map((f) => ({
      wallet: f.wallet,
      walletRevision: 1,
      amount: '0.001',
    })),
  });
  expect(response.status).toBe(200);
  session = decodeTradeSession(
    ((await response.json()) as { session: unknown }).session,
  );
});
afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

async function preparation(entry: number, f = fixtures[entry - 1]) {
  const capture = await captureTradeSession(
    db,
    owner,
    { sessionId: session.id, revision: 1, entry },
    {
      projectId,
      projectRevision: 1,
      wallet: f.wallet,
      walletRevision: 1,
      side: session.terms.side,
      unitsRaw: f.order.inAmount,
      mint: f.mint,
      decimals: 6,
    },
  );
  const now = new Date().toISOString();
  const document = {
    ...unsignedPreparationSummary(f.order, f.simulation),
    session: capture.selection,
  };
  const history = {
    id: crypto.randomUUID(),
    projectId,
    projectRevision: 1,
    walletRevision: 1,
    createdAt: now,
    document,
  };
  await db
    .prepare(
      'INSERT INTO imported_swap_preparations(id,owner_id,project_id,project_revision,wallet_address,wallet_revision,document,created_at) VALUES(?,?,?,?,?,?,?,?)',
    )
    .bind(
      history.id,
      owner,
      projectId,
      1,
      f.wallet,
      1,
      JSON.stringify(document),
      now,
    )
    .run();
  return { history, order: f.order, simulation: f.simulation };
}
async function queued(entry: number) {
  return queueSessionPreparation(
    db,
    owner,
    crypto.randomUUID(),
    session,
    entry,
  );
}
async function prepared(entry: number, f = fixtures[entry - 1]) {
  const job = await queued(entry);
  const packet = await preparation(entry, f);
  expect(
    (
      await runSessionPreparationJobs(
        db,
        async () => Response.json(packet),
        scope(),
        1,
      )
    ).processed,
  ).toBe(1);
  return { job, packet };
}
async function approval(entry: number, f = fixtures[entry - 1]) {
  const packet = await preparation(entry, f);
  const id = crypto.randomUUID(),
    now = new Date().toISOString();
  const review: WarmupSigningReview = {
    id,
    preparationId: packet.history.id,
    wallet: f.wallet,
    sha256: f.order.preparation.sha256,
    expiresAt: f.order.expiresAt,
    network: 'mainnet',
    maximumFeeLamports: f.simulation.networkFeeLamports,
    inputRaw: f.order.inAmount,
    minimumOutputRaw: f.order.minimumOutAmount,
    inputMint: f.order.inputMint,
    outputMint: f.order.outputMint,
    transaction: f.order.preparation.transaction,
    lastValidBlockHeight: f.order.preparation.lastValidBlockHeight,
    settlement: await requireWarmupSigningReview(f.order, f.simulation),
    session: packet.history.document.session,
  };
  await db
    .prepare(
      "INSERT INTO imported_swap_signing_intents(id,owner_id,preparation_id,wallet_address,document,state,created_at,updated_at) VALUES(?,?,?,?,?,'awaiting_signature',?,?)",
    )
    .bind(
      id,
      owner,
      packet.history.id,
      f.wallet,
      JSON.stringify(review),
      now,
      now,
    )
    .run();
  return { id, packet, f, review };
}
async function transition(
  a: Awaited<ReturnType<typeof approval>>,
  state: 'signed' | 'submitted' | 'failed' | 'cancelled',
) {
  await db
    .prepare(
      'UPDATE imported_swap_signing_intents SET state=?,signature=?,updated_at=? WHERE owner_id=? AND id=?',
    )
    .bind(
      state,
      state === 'cancelled' ? null : a.f.signed.signature,
      new Date().toISOString(),
      owner,
      a.id,
    )
    .run();
}
async function finalized(entry: number, f = fixtures[entry - 1]) {
  const a = await approval(entry, f);
  await transition(a, 'signed');
  await transition(a, 'submitted');
  const proof = await decodeWarmupReceipt(
    a.f.receipt,
    a.packet.history,
    a.f.signed.signature,
    session.terms.side,
    a.review,
  );
  const { acquiredRaw, ...evidence } = proof;
  const now = new Date().toISOString(),
    receiptId = crypto.randomUUID();
  const doc = {
    ...evidence,
    side: session.terms.side,
    tokenUnitsRaw: acquiredRaw,
    source: 'receipt-fixture.test',
    observedAt: now,
    packetSentinel: 'never-return-retained-packet',
  };
  await db.batch([
    db
      .prepare(
        'INSERT INTO imported_swap_receipts(id,owner_id,intent_id,preparation_id,project_id,project_revision,wallet_revision,signature,document,created_at) VALUES(?,?,?,?,?,1,1,?,?,?)',
      )
      .bind(
        receiptId,
        owner,
        a.id,
        a.packet.history.id,
        projectId,
        a.f.signed.signature,
        JSON.stringify(doc),
        now,
      ),
    db
      .prepare(
        "UPDATE imported_swap_signing_intents SET state='finalized',updated_at=? WHERE owner_id=? AND id=?",
      )
      .bind(now, owner, a.id),
  ]);
  return { ...a, receiptId, units: proof.acquiredRaw };
}
async function outcomes() {
  const response = await GET(query());
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  return decodeSessionEntryOutcomes(await response.json(), session);
}
async function jobs() {
  return (
    await db
      .prepare(
        'SELECT entry,state,lease_token,lease_until,preparation_id,payload FROM session_preparation_jobs WHERE owner_id=? AND session_id=? ORDER BY entry',
      )
      .bind(owner, session.id)
      .all<Record<string, unknown>>()
  ).results;
}
async function count(table: string) {
  return (await db
    .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE owner_id=?`)
    .bind(owner)
    .first<{ n: number }>())!.n;
}
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

it('loads the complete current migration journal in disposable D1 and retains all saved entries without guessing attempts', async () => {
  expect(migrationCount).toBeGreaterThanOrEqual(72);
  const page = await outcomes();
  expect(page.entries).toHaveLength(6);
  expect(page.missingSources).toEqual([]);
  expect(
    page.entries.every(
      (e) =>
        !e.preparation &&
        !e.approval &&
        !e.receipt &&
        e.receiptEvidence === 'not-applicable',
    ),
  ).toBe(true);
  expect(page.entries.map((e) => e.wallet)).toEqual(
    fixtures.map((f) => f.wallet),
  );
  expect(page.session.terms).toMatchObject({
    side: 'Buy',
    totalRaw: '6000000',
    mint: fixtures[0].mint,
    decimals: 6,
  });
  expect(page.executionAllowed).toBe(false);
});
it('authenticates exact project/session or owned immutable event selectors and rejects foreign scopes', async () => {
  const eventId = (await db
    .prepare(
      'SELECT id FROM imported_trade_session_events WHERE owner_id=? AND session_id=?',
    )
    .bind(owner, session.id)
    .first<{ id: string }>())!.id;
  const eventResponse = await GET(query({ eventId }));
  expect(eventResponse.status).toBe(200);
  const fromEvent = decodeSessionEntryOutcomes(
    await eventResponse.json(),
    session,
    eventId,
  );
  expect(fromEvent.sourceEventId).toBe(eventId);
  const badScopes: Record<string, string>[] = [
    { eventId: session.id },
    { eventId: 'f'.repeat(32), sessionId: session.id },
    { sessionId: session.id, unexpected: 'yes' },
  ];
  for (const bad of badScopes) expect((await GET(query(bad))).status).toBe(400);
  expect((await GET(query({ eventId: 'f'.repeat(32) }))).status).toBe(404);
  expect(
    (await GET(new Request(query().url + '&sessionId=' + session.id))).status,
  ).toBe(400);
  context.user = { userId: 'foreign' };
  expect((await GET(query())).status).toBe(404);
  expect((await GET(query({ eventId }))).status).toBe(404);
  context.user = null;
  expect((await GET(query())).status).toBe(401);
});
it('projects exact Sell token input and matching consumed units rather than treating token amounts as SOL', async () => {
  const response = await post({
    action: 'create',
    id: crypto.randomUUID(),
    projectId,
    projectRevision: 1,
    side: 'Sell',
    entries: [
      { wallet: sellFixture.wallet, walletRevision: 1, amount: '0.001' },
    ],
  });
  expect(response.status).toBe(200);
  session = decodeTradeSession(
    ((await response.json()) as { session: unknown }).session,
  );
  await prepared(1, sellFixture);
  const sale = await finalized(1, sellFixture);
  const page = await outcomes();
  expect(page.session.terms).toMatchObject({
    side: 'Sell',
    totalRaw: '1000',
    decimals: 6,
  });
  expect(page.entries[0]).toMatchObject({
    amount: '0.001',
    unitsRaw: '1000',
    receiptEvidence: 'matching',
    receipt: {
      id: sale.receiptId,
      document: { side: 'Sell', tokenUnitsRaw: '1000' },
    },
  });
  const real = context.db;
  context.db = {
    prepare: real.prepare.bind(real),
    async batch(statements: D1PreparedStatement[]) {
      const results = await real.batch<Record<string, unknown>>(statements);
      const row = results[3].results[0],
        doc = JSON.parse(row.document as string);
      doc.tokenUnitsRaw = '999';
      row.document = JSON.stringify(doc);
      return results;
    },
  } as unknown as D1Database;
  expect((await outcomes()).entries[0]).toMatchObject({
    approval: { state: 'finalized' },
    receiptEvidence: 'contradictory',
    receipt: null,
  });
  context.db = real;
});
it('returns mixed unsigned, broad failure, recoverable signing and finalized receipt evidence without packets or duplicate counts', async () => {
  const unsigned = await prepared(1);
  await queued(2);
  await runSessionPreparationJobs(
    db,
    async () =>
      Response.json(
        { error: 'Insufficient OR unsupported token balance' },
        { status: 422 },
      ),
    scope(),
    1,
  );
  await queued(3);
  const recoverable = await approval(4);
  await transition(recoverable, 'signed');
  const buy = await finalized(5);
  const page = await outcomes();
  expect(
    page.entries.map((e) => e.preparation?.document.state ?? null),
  ).toEqual(['prepared', 'failed', 'queued', null, null, null]);
  expect(page.entries[0].preparation?.document.preparationId).toBe(
    unsigned.packet.history.id,
  );
  expect(page.entries[1].preparation?.document.error).toBe(
    'balance-unavailable',
  );
  expect(page.entries[3].approval).toMatchObject({
    intentId: recoverable.id,
    state: 'signed',
    signature: recoverable.f.signed.signature,
  });
  expect(page.entries[4]).toMatchObject({
    approval: { state: 'finalized', receiptId: buy.receiptId },
    receiptEvidence: 'matching',
    receipt: {
      id: buy.receiptId,
      document: { tokenUnitsRaw: buy.units, side: 'Buy' },
    },
  });
  const text = JSON.stringify(page);
  for (const forbidden of [
    'transaction',
    'lease_token',
    'payload',
    'never-return-retained-packet',
    'rawInstructions',
  ])
    expect(text).not.toContain(forbidden);
  expect(Object.keys(page.session).sort()).toEqual([
    'createdAt',
    'id',
    'revision',
    'state',
    'terms',
    'updatedAt',
  ]);
  expect(
    page.entries.filter((e) => e.receiptEvidence === 'matching'),
  ).toHaveLength(1);
});
it('cancels queued and running unsigned jobs atomically, retains terminal history, and rejects a stale prepared response', async () => {
  const old = await prepared(1);
  await queued(2);
  await runSessionPreparationJobs(
    db,
    async () => Response.json({}, { status: 422 }),
    scope(),
    1,
  );
  await queued(3);
  const started = deferred<void>(),
    release = deferred<Response>();
  const packet = await preparation(3);
  const runner = runSessionPreparationJobs(
    db,
    async () => {
      started.resolve();
      return release.promise;
    },
    scope(),
    1,
  );
  await started.promise;
  await queued(4);
  const buy = await finalized(5);
  const eventId = (await db
    .prepare(
      "SELECT id FROM imported_trade_session_events WHERE owner_id=? AND session_id=? AND type='session.saved'",
    )
    .bind(owner, session.id)
    .first<{ id: string }>())!.id;
  expect((await cancel()).status).toBe(200);
  const immediate = await jobs();
  expect(immediate.map((j) => j.state)).toEqual([
    'prepared',
    'failed',
    'cancelled',
    'cancelled',
  ]);
  expect(immediate[0].preparation_id).toBe(old.packet.history.id);
  expect(
    immediate
      .slice(2)
      .every(
        (j) =>
          j.lease_token === null &&
          j.lease_until === null &&
          j.preparation_id === null &&
          j.payload === null,
      ),
  ).toBe(true);
  const page = await outcomes();
  expect(page.session.state).toBe('cancelled');
  expect(
    page.entries.slice(2, 4).map((e) => e.preparation?.document.state),
  ).toEqual(['cancelled', 'cancelled']);
  expect(page.entries[4].receipt?.id).toBe(buy.receiptId);
  release.resolve(Response.json(packet));
  await runner;
  expect(await jobs()).toEqual(immediate);
  expect(
    await db
      .prepare(
        'SELECT document FROM imported_swap_preparations WHERE owner_id=? AND id=?',
      )
      .bind(owner, packet.history.id)
      .first(),
  ).toBeTruthy();
  const historical = await GET(query({ eventId }));
  expect(
    decodeSessionEntryOutcomes(await historical.json(), session, eventId)
      .session.state,
  ).toBe('cancelled');
  const savedEvent = await db
    .prepare(
      'SELECT document FROM imported_trade_session_events WHERE owner_id=? AND id=?',
    )
    .bind(owner, eventId)
    .first<{ document: string }>();
  expect(JSON.parse(savedEvent!.document).state).toBe('active');
  expect((await cancel()).status).toBe(409);
});
it('a cancelled running response cannot create a preparation through a new session capture', async () => {
  await queued(1);
  const started = deferred<void>(),
    resume = deferred<void>();
  const runner = runSessionPreparationJobs(
    db,
    async () => {
      started.resolve();
      await resume.promise;
      return Response.json(await preparation(1));
    },
    scope(),
    1,
  );
  await started.promise;
  expect((await cancel()).status).toBe(200);
  resume.resolve();
  await runner;
  expect(await count('imported_swap_preparations')).toBe(0);
  expect((await jobs())[0]).toMatchObject({
    state: 'cancelled',
    payload: null,
    preparation_id: null,
    lease_token: null,
  });
});
it.each(['awaiting_signature', 'signed', 'submitted'] as const)(
  'blocks parent cancellation with a retained live %s approval and leaves queued jobs and events intact',
  async (state) => {
    await queued(1);
    const a = await approval(2);
    if (state !== 'awaiting_signature') await transition(a, 'signed');
    if (state === 'submitted') await transition(a, 'submitted');
    const before = await jobs(),
      sessionEvents = await count('imported_trade_session_events'),
      jobEvents = await count('session_preparation_job_events');
    expect((await cancel()).status).toBe(409);
    expect(await jobs()).toEqual(before);
    expect(await count('imported_trade_session_events')).toBe(sessionEvents);
    expect(await count('session_preparation_job_events')).toBe(jobEvents);
    expect((await outcomes()).session.state).toBe('active');
  },
);
it('rolls back the parent cancellation when immediate job event capture fails', async () => {
  await queued(1);
  const before = await jobs(),
    sessionEvents = await count('imported_trade_session_events'),
    jobEvents = await count('session_preparation_job_events');
  await db
    .prepare(
      "CREATE TRIGGER outcome_cancel_capture_failure BEFORE INSERT ON session_preparation_job_events WHEN json_extract(NEW.document,'$.state')='cancelled' BEGIN SELECT RAISE(ABORT,'Synthetic immutable event capture failure'); END",
    )
    .run();
  try {
    expect((await cancel()).status).toBe(503);
    expect(await jobs()).toEqual(before);
    expect(await count('imported_trade_session_events')).toBe(sessionEvents);
    expect(await count('session_preparation_job_events')).toBe(jobEvents);
    expect((await outcomes()).session.state).toBe('active');
  } finally {
    await db.prepare('DROP TRIGGER outcome_cancel_capture_failure').run();
  }
  expect((await cancel()).status).toBe(200);
});
it('retains failed and cancelled approval states without inventing finalized execution evidence', async () => {
  const failed = await approval(1);
  await transition(failed, 'signed');
  await transition(failed, 'failed');
  const cancelled = await approval(2);
  await transition(cancelled, 'cancelled');
  const page = await outcomes();
  expect(
    page.entries
      .slice(0, 2)
      .map((e) => [e.approval?.state, e.receiptEvidence, e.receipt]),
  ).toEqual([
    ['failed', 'not-applicable', null],
    ['cancelled', 'not-applicable', null],
  ]);
  expect((await cancel()).status).toBe(200);
});
it('reads immutable historical entries after roster removal and archival without requiring current execution context', async () => {
  const buy = await finalized(5);
  await db
    .prepare(
      'UPDATE imported_token_projects SET archived=1,revision=revision+1 WHERE owner_id=? AND id=?',
    )
    .bind(owner, projectId)
    .run();
  await db
    .prepare('DELETE FROM workspace_wallets WHERE owner_id=?')
    .bind(owner)
    .run();
  const page = await outcomes();
  expect(page.entries).toHaveLength(6);
  expect(page.entries[4].receipt?.id).toBe(buy.receiptId);
});
it('preserves finalized approval when a retained receipt contradicts its exact wallet or chronology', async () => {
  await finalized(5);
  const real = context.db;
  const corrupt = (
    kind:
      | 'wallet'
      | 'future'
      | 'mint'
      | 'amount'
      | 'minimum'
      | 'settlement'
      | 'program'
      | 'preparation',
  ) =>
    ({
      prepare: real.prepare.bind(real),
      async batch(statements: D1PreparedStatement[]) {
        const results = await real.batch<Record<string, unknown>>(statements);
        const receipts = results[3]?.results;
        if (receipts?.length) {
          const row = receipts[0],
            doc = JSON.parse(row.document as string);
          if (kind === 'wallet') doc.wallet = fixtures[0].wallet;
          if (kind === 'future')
            row.createdAt = new Date(Date.now() + 60000).toISOString();
          if (kind === 'mint') doc.mint = fixtures[0].wallet;
          if (kind === 'amount') doc.tokenUnitsRaw = '18446744073709551616';
          if (kind === 'minimum') doc.tokenUnitsRaw = '1';
          if (kind === 'settlement') doc.nativeSettlementRaw = '-999999';
          if (kind === 'program') doc.tokenProgram = fixtures[0].wallet;
          if (kind === 'preparation')
            row.preparationWallet = fixtures[0].wallet;
          row.document = JSON.stringify(doc);
        }
        return results;
      },
    }) as unknown as D1Database;
  for (const kind of [
    'wallet',
    'future',
    'mint',
    'amount',
    'minimum',
    'settlement',
    'program',
    'preparation',
  ] as const) {
    context.db = corrupt(kind);
    const page = await outcomes();
    expect(page.entries[4]).toMatchObject({
      approval: { state: 'finalized' },
      receiptEvidence: 'contradictory',
      receipt: null,
    });
    expect(page.entries).toHaveLength(6);
  }
  context.db = real;
});
it('keeps all entries and labels missing optional outcome sources explicitly', async () => {
  await finalized(5);
  const real = context.db;
  const missing = {
    prepare(sql: string) {
      if (sql.startsWith('SELECT name FROM sqlite_master'))
        return {
          async all() {
            return { results: [] };
          },
        };
      return real.prepare(sql);
    },
    batch: real.batch.bind(real),
  } as unknown as D1Database;
  context.db = missing;
  const page = await outcomes();
  expect(page.missingSources).toEqual(['preparation', 'approval', 'receipts']);
  expect(page.entries).toHaveLength(6);
  expect(
    page.entries.every((e) => !e.approval && !e.preparation && !e.receipt),
  ).toBe(true);
  context.db = real;
});
it('rejects malformed retained immutable event scope without returning packets or partial misleading evidence', async () => {
  await prepared(1);
  const real = context.db;
  context.db = {
    prepare: real.prepare.bind(real),
    async batch(statements: D1PreparedStatement[]) {
      const results = await real.batch<Record<string, unknown>>(statements);
      results[1].results[0].sessionId = crypto.randomUUID();
      return results;
    },
  } as unknown as D1Database;
  const response = await GET(query());
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({
    error: 'Retained session wallet outcomes unavailable.',
  });
  context.db = real;
});
it('preserves legacy session cancellation and all entries when optional job and receipt sources are physically absent', async () => {
  await db.prepare('DROP TABLE session_preparation_jobs').run();
  await db.prepare('DROP TABLE session_preparation_job_events').run();
  await db.prepare('DROP TABLE imported_swap_receipts').run();
  expect((await cancel()).status).toBe(200);
  const page = await outcomes();
  expect(page.session.state).toBe('cancelled');
  expect(page.entries).toHaveLength(6);
  expect(page.missingSources).toEqual(['preparation', 'receipts']);
});
