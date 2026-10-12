import { warmupAccountKeysHash } from '@/lib/warmup-native-settlement';
import type { SavedWarmupPreparation } from '@/lib/warmup-preparation-history';
import { WARMUP_HISTORY_LIMIT } from '@/lib/warmup-history-capacity';
import { nativeWarmupFixture } from '../../../../../test/warmup-native-fixture';
import { signApprovedExternalWarmupPacket } from '../../../../../lib/warmup-external-signer';
import { restoreRegisteredWarmupPacket } from '../../../../../lib/warmup-approval-history';
import {
  POST as verifySellReceipt,
  GET as sellReceipts,
} from '../sell-receipts/route';
import {
  beforeAll,
  afterAll,
  afterEach,
  beforeEach,
  it,
  expect,
  vi,
} from 'vitest';
import { env } from 'cloudflare:workers';
const testEnv = env as unknown as Record<string, string | undefined>;
import * as swapQuotes from '@/lib/warmup-swap-quote';
import * as simulations from '@/lib/imported-swap-simulation';
import * as sellInventory from '@/lib/warmup-sell-inventory';
import {
  saveWarmupSellReceipt,
  type WarmupSellReceipt,
} from '@/lib/warmup-sell-receipt';
import { warmupBuyLink } from '@/lib/warmup-buy-link';
import * as buyReceiptReader from '@/lib/warmup-buy-receipt';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { solanaTransferMessage } from '@/lib/solana-funding';
import * as warmupSigningHelpers from '@/lib/warmup-signing';
import {
  signApprovedWarmupPacket,
  type WarmupSigningReview,
} from '@/lib/warmup-signing';
import type { VaultSession } from '@/lib/browser-wallet-vault';
import { POST as signingAction, GET as signingStatus } from '../signing/route';
import { SOLANA_MAINNET_GENESIS } from '@/lib/wallet-balances';
import { readFileSync } from 'node:fs';
import { Miniflare } from 'miniflare';
const mocks = vi.hoisted(() => ({
  user: null as { userId: string } | null,
  db: null as unknown as D1Database,
  preflight: vi.fn(),
}));
vi.mock('@/app/chatgpt-auth', () => ({
  getChatGPTUser: async () => mocks.user,
}));
vi.mock('@/db', () => ({ getD1: () => mocks.db }));
import { GET, POST } from './route';
vi.mock('@/lib/wallet-warmup-preflight', () => ({
  inspectWarmupPreflight: mocks.preflight,
}));
import { POST as preflight } from '../preflight/route';
import { POST as quoteBuy } from '../quote/route';
import { POST as prepareBuy } from '../prepare/route';
import { GET as preparationHistory } from '../preparations/route';
import {
  GET as buyReceipts,
  POST as verifyBuyReceipt,
} from '../buy-receipts/route';
import { preparationHistoryFixture } from '../../../../../test/imported-preparation-history-fixture';
import {
  warmupPreparationSummary,
  saveWarmupPreparation,
} from '@/lib/warmup-preparation-history';
import { GET as history } from '../events/route';
import { GET as activity } from '../activity/route';
import { GET as signingActivity } from '../signing-activity/route';
import { GET as cycleProgress } from '../cycle-progress/route';
import type { SavedWarmup, WarmupPlanEvent } from '@/lib/wallet-warmup-storage';
let mf: Miniflare;
afterEach(() => {
  vi.restoreAllMocks();
  delete testEnv.JUPITER_API_KEY;
});
const address = '0x1111111111111111111111111111111111111111';
const document = () => ({
  name: 'QA durable warmup',
  chain: 'Base',
  addresses: [address],
  walletRevisions: [{ address, revision: 1 }],
  tokens: ['0x4200000000000000000000000000000000000006'],
  amount: '0.001',
  feeReserve: '0.01',
  cycles: 3,
  intervalMinutes: 60,
  startAt: new Date(Date.now() + 3600000).toISOString(),
  executionAllowed: true,
  totalBudget: '999',
  actions: ['malicious payload'],
});
const request = (
  body: unknown = {
    id: 'qa',
    expectedRevision: 0,
    action: 'save',
    document: document(),
  },
  headers = {},
) =>
  POST(
    new Request('http://localhost/api/wallet-workspace/warmup/plans', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    }),
  );
const list = async () =>
  (await (await GET()).json()) as { plans: SavedWarmup[] };
const eventList = (cursor?: string) =>
  history(
    new Request(
      'http://localhost/api/wallet-workspace/warmup/events?id=qa' +
        (cursor ? '&cursor=' + cursor : ''),
    ),
  );
it('opens the latest owned warmup by ID including archived plans', async () => {
  await request();
  await request({ id: 'qa', expectedRevision: 1, action: 'archive' });
  const detail = () =>
    GET(
      new Request('http://localhost/api/wallet-workspace/warmup/plans?id=qa'),
    );
  expect(await (await detail()).json()).toMatchObject({
    plan: { id: 'qa', revision: 2, archived: true },
  });
  mocks.user = { userId: 'two' };
  expect((await detail()).status).toBe(404);
  expect(
    (
      await GET(
        new Request('http://localhost/api/wallet-workspace/warmup/plans?id='),
      )
    ).status,
  ).toBe(400);
});
it('pages compact owner-scoped warmup Activity without duplicating tied timestamps', async () => {
  await request();
  const date = '2026-10-10T13:00:00.000Z';
  await mocks.db
    .prepare(
      "WITH RECURSIVE n(v) AS (SELECT 2 UNION ALL SELECT v+1 FROM n WHERE v<55) INSERT INTO wallet_warmup_plan_events(id,owner_id,plan_id,type,revision,document,created_at) SELECT printf('00000000-0000-4000-8000-%012d',v),owner_id,id,'plan.save',v,document,? FROM n,wallet_warmup_plans WHERE id='qa'",
    )
    .bind(date)
    .run();
  await mocks.db
    .prepare('UPDATE wallet_warmup_plan_events SET created_at=?')
    .bind(date)
    .run();
  const readActivity = (cursor?: string) =>
    activity(
      new Request(
        'http://localhost/api/wallet-workspace/warmup/activity' +
          (cursor ? '?cursor=' + encodeURIComponent(cursor) : ''),
      ),
    );
  const first = (await (await readActivity()).json()) as {
    events: Array<{ id: string; summary: object }>;
    nextCursor: string;
  };
  expect(first.events).toHaveLength(50);
  expect(first.events[0].summary).toMatchObject({
    name: 'QA durable warmup',
    chain: 'Base',
    walletCount: 1,
    cycles: 3,
    amount: '0.001',
    totalBudget: '0.013',
  });
  expect(first.events[0]).not.toHaveProperty('document');
  const second = (await (await readActivity(first.nextCursor)).json()) as {
    events: Array<{ id: string }>;
    nextCursor: string | null;
  };
  expect(second.events).toHaveLength(5);
  expect(
    new Set([...first.events, ...second.events].map((e) => e.id)).size,
  ).toBe(55);
  expect(second.nextCursor).toBeNull();
  expect((await readActivity('invalid')).status).toBe(400);
  expect(
    (
      await readActivity(
        JSON.stringify([
          '2026-02-30T00:00:00.000Z',
          '00000000-0000-4000-8000-000000000001',
        ]),
      )
    ).status,
  ).toBe(400);
  mocks.user = { userId: 'two' };
  expect(await (await readActivity()).json()).toMatchObject({ events: [] });
  mocks.user = null;
  expect((await readActivity()).status).toBe(401);
});
it('records immutable warmup snapshots once per winning revision, including archived plans', async () => {
  const fixed = new Date(Date.now() + 3600000).toISOString();
  vi.spyOn(Date.prototype, 'toISOString').mockReturnValue(fixed);
  expect((await request()).status).toBe(200);
  const edit = {
    id: 'qa',
    expectedRevision: 1,
    action: 'save',
    document: { ...document(), name: 'Changed warmup' },
  };
  const writes = await Promise.all([request(edit), request(edit)]);
  expect(writes.map((r) => r.status).sort((a, b) => a - b)).toEqual([200, 409]);
  expect(
    (await request({ id: 'qa', expectedRevision: 2, action: 'archive' }))
      .status,
  ).toBe(200);
  const page = (await (await eventList()).json()) as {
    events: Array<{
      type: string;
      revision: number;
      document: { name: string };
    }>;
  };
  expect(page.events.map((e) => [e.type, e.revision])).toEqual([
    ['plan.archive', 3],
    ['plan.save', 2],
    ['plan.create', 1],
  ]);
  expect(page.events[2].document.name).toBe('QA durable warmup');
  expect(page.events[0].document.name).toBe('Changed warmup');
  expect(page.events[2].document).not.toHaveProperty('executionAllowed');
  expect(
    (await request({ id: 'qa', expectedRevision: 3, action: 'restore' }))
      .status,
  ).toBe(200);
  expect(
    ((await (await eventList()).json()) as { events: WarmupPlanEvent[] })
      .events[0].type,
  ).toBe('plan.restore');
  mocks.user = { userId: 'two' };
  expect((await eventList()).status).toBe(404);
  mocks.user = null;
  expect((await eventList()).status).toBe(401);
});
it('rolls back warmup state when immutable history storage fails', async () => {
  await mocks.db
    .prepare(
      "CREATE TRIGGER reject_warmup_events BEFORE INSERT ON wallet_warmup_plan_events BEGIN SELECT RAISE(ABORT,'test history failure'); END",
    )
    .run();
  try {
    expect((await request()).status).toBe(503);
    expect((await list()).plans).toEqual([]);
  } finally {
    await mocks.db.exec('DROP TRIGGER reject_warmup_events');
  }
});
it('paginates warmup history by immutable revision and validates cursors', async () => {
  await request();
  await mocks.db
    .prepare(
      "WITH RECURSIVE n(v) AS (SELECT 2 UNION ALL SELECT v+1 FROM n WHERE v<55) INSERT INTO wallet_warmup_plan_events(id,owner_id,plan_id,type,revision,document,created_at) SELECT 'page-'||v,owner_id,id,'plan.save',v,document,updated_at FROM n,wallet_warmup_plans WHERE id='qa'",
    )
    .run();
  await mocks.db.exec('UPDATE wallet_warmup_plans SET revision=55');
  const first = (await (await eventList()).json()) as {
    events: WarmupPlanEvent[];
    nextCursor: string;
  };
  expect(first.events).toHaveLength(50);
  expect(first.nextCursor).toBe('6');
  const second = (await (await eventList(first.nextCursor)).json()) as {
    events: WarmupPlanEvent[];
    nextCursor: string | null;
  };
  expect(second.events.map((e: { revision: number }) => e.revision)).toEqual([
    5, 4, 3, 2, 1,
  ]);
  expect(second.nextCursor).toBeNull();
  expect((await eventList('01')).status).toBe(400);
  expect((await eventList('1e3')).status).toBe(400);
});
beforeAll(async () => {
  mf = new Miniflare({
    telemetry: { enabled: false },
    workers: [
      {
        config: {
          name: 'warmup-plans-test',
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
          env: { DB: { type: 'd1', id: 'warmup-plans-test-db' } },
        },
      },
    ],
  });
  mocks.db = (await mf.getD1Database(
    'DB',
    'warmup-plans-test',
  )) as unknown as D1Database;
  await mocks.db
    .prepare(
      'CREATE TABLE workspace_wallets(owner_id TEXT,chain TEXT,address TEXT,revision INTEGER,archived INTEGER)',
    )
    .run();
  await mocks.db
    .prepare(
      readFileSync(
        new URL(
          '../../../../../drizzle/0021_wallet_warmup_plans.sql',
          import.meta.url,
        ),
        'utf8',
      ),
    )
    .run();
  const eventMigration = readFileSync(
    new URL(
      '../../../../../drizzle/0025_warmup_plan_events.sql',
      import.meta.url,
    ),
    'utf8',
  );
  for (const sql of eventMigration.split('--> statement-breakpoint'))
    await mocks.db.prepare(sql).run();
  for (const sql of readFileSync(
    new URL(
      '../../../../../drizzle/0042_warmup_swap_preparations.sql',
      import.meta.url,
    ),
    'utf8',
  ).split('--> statement-breakpoint'))
    await mocks.db.prepare(sql).run();
  for (const sql of readFileSync(
    'drizzle/0043_warmup_buy_receipts.sql',
    'utf8',
  ).split('--> statement-breakpoint'))
    await mocks.db.prepare(sql).run();
  for (const sql of readFileSync(
    'drizzle/0045_warmup_signing_intents.sql',
    'utf8',
  ).split('--> statement-breakpoint')) {
    if (sql.trim()) await mocks.db.prepare(sql).run();
  }
  for (const sql of readFileSync(
    'drizzle/0047_shared_swap_reservations.sql',
    'utf8',
  ).split('--> statement-breakpoint')) {
    if (sql.trim()) await mocks.db.prepare(sql).run();
  }
  for (const sql of readFileSync(
    'drizzle/0044_warmup_sell_receipts.sql',
    'utf8',
  ).split('--> statement-breakpoint')) {
    if (sql.trim()) await mocks.db.prepare(sql).run();
  }
  for (const sql of readFileSync(
    'drizzle/0046_warmup_signing_events.sql',
    'utf8',
  ).split('--> statement-breakpoint')) {
    if (sql.trim()) await mocks.db.prepare(sql).run();
  }
  for (const sql of readFileSync(
    'drizzle/0052_warmup_swap_failure.sql',
    'utf8',
  ).split('--> statement-breakpoint'))
    if (sql.trim()) await mocks.db.prepare(sql).run();
});
afterAll(async () => mf.dispose());
beforeEach(async () => {
  mocks.preflight.mockReset();
  mocks.preflight.mockResolvedValue({
    executionAllowed: false,
    status: 'Observed',
  });
  mocks.user = { userId: 'one' };
  await mocks.db.exec(
    'DROP TRIGGER IF EXISTS warmup_signing_events_immutable_delete; DELETE FROM warmup_signing_events; DELETE FROM warmup_signing_intents; DELETE FROM solana_swap_signatures; DELETE FROM imported_swap_signing_intents; DELETE FROM imported_swap_receipts; DELETE FROM solana_swap_reservations; DELETE FROM warmup_sell_receipts; DELETE FROM warmup_buy_receipts; DELETE FROM warmup_swap_preparations; DELETE FROM workspace_wallets; DELETE FROM wallet_warmup_plans; DELETE FROM wallet_warmup_plan_events;',
  );
  await mocks.db
    .prepare(
      "CREATE TRIGGER warmup_signing_events_immutable_delete BEFORE DELETE ON warmup_signing_events BEGIN SELECT RAISE(ABORT,'Warmup signing event is immutable'); END",
    )
    .run();
  await mocks.db
    .prepare('INSERT INTO workspace_wallets VALUES (?,?,?,?,?)')
    .bind('one', 'Base', address, 1, 0)
    .run();
});
const check = () =>
  preflight(
    new Request('http://localhost/api/wallet-workspace/warmup/preflight', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'qa', revision: 1 }),
    }),
  );
async function seedSigningApprovals(count = 52) {
  await request();
  const f = await nativeWarmupFixture({ v2: true, lookup: true });
  const date = '2026-10-10T01:00:00.000Z';
  const statements: D1PreparedStatement[] = [];
  for (let n = 1; n <= count; n++) {
    const id = `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
      preparationId = `20000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
    const review: WarmupSigningReview = {
      id,
      preparationId,
      wallet: f.wallet,
      network: 'mainnet',
      sha256: f.order.preparation.sha256,
      transaction: f.order.preparation.transaction,
      expiresAt: new Date(0).toISOString(),
      maximumFeeLamports: '5000',
      inputRaw: f.order.inAmount,
      minimumOutputRaw: f.order.minimumOutAmount,
      inputMint: f.order.inputMint,
      outputMint: f.order.outputMint,
      lastValidBlockHeight: '1000',
    };
    statements.push(
      mocks.db
        .prepare(
          'INSERT INTO warmup_swap_preparations (id,owner_id,plan_id,plan_revision,cycle,wallet_address,wallet_revision,document,created_at) VALUES (?,?,?,?,?,?,?,?,?)',
        )
        .bind(
          preparationId,
          'one',
          'qa',
          1,
          1,
          f.wallet,
          1,
          JSON.stringify({
            ...preparationHistoryFixture(),
            side: 'Buy',
            wallet: f.wallet,
          }),
          date,
        ),
    );
    statements.push(
      mocks.db
        .prepare(
          "INSERT INTO warmup_signing_intents(id,owner_id,preparation_id,wallet_address,document,state,signature,created_at,updated_at) VALUES (?,?,?,?,?,'cancelled',NULL,?,?)",
        )
        .bind(
          id,
          'one',
          preparationId,
          f.wallet,
          JSON.stringify(review),
          date,
          date,
        ),
    );
  }
  await mocks.db.batch(statements);
}
it('pages owner-scoped approval recovery across archives with tied creation times and rejects unrelated cursors', async () => {
  await seedSigningApprovals();
  await request({ id: 'qa', expectedRevision: 1, action: 'archive' });
  const load = (cursor?: string) =>
    signingStatus(
      new Request(
        'http://localhost/api/wallet-workspace/warmup/signing?planId=qa' +
          (cursor ? '&cursor=' + cursor : ''),
      ),
    );
  const first = await load();
  expect(first.status).toBe(200);
  const page = (await first.json()) as {
    planId: string;
    intents: Array<{ id: string; state: string; planRevision: number }>;
    nextCursor: string;
  };
  expect(page.planId).toBe('qa');
  expect(page.intents).toHaveLength(50);
  expect(page.intents[0]).toMatchObject({
    id: '10000000-0000-4000-8000-000000000052',
    state: 'cancelled',
    planRevision: 1,
  });
  const older = (await (await load(page.nextCursor)).json()) as {
    intents: Array<{ id: string }>;
    nextCursor: null;
  };
  expect(older.intents).toHaveLength(2);
  expect(
    new Set([...page.intents, ...older.intents].map((row) => row.id)).size,
  ).toBe(52);
  expect(older.nextCursor).toBeNull();
  const executionRead = (cursor?: string, plan = 'qa') =>
    signingActivity(
      new Request(
        'http://localhost/api/wallet-workspace/warmup/signing-activity?planId=' +
          plan +
          (cursor ? '&cursor=' + cursor : ''),
      ),
    );
  const eventPage = await executionRead();
  expect(eventPage.status).toBe(200);
  const events = (await eventPage.json()) as {
    events: Array<{
      id: string;
      sequence: number;
      type: string;
      state: string;
    }>;
    nextCursor: string;
  };
  expect(events.events).toHaveLength(50);
  expect(
    events.events.every(
      (e) => e.type === 'approval.baseline' && e.state === 'cancelled',
    ),
  ).toBe(true);
  expect(events.events[0].sequence).toBeGreaterThan(events.events[49].sequence);
  const tail = (await (await executionRead(events.nextCursor)).json()) as {
    events: Array<{ id: string }>;
    nextCursor: null;
  };
  expect(tail.events).toHaveLength(2);
  expect(tail.nextCursor).toBeNull();
  expect(
    new Set([...events.events, ...tail.events].map((e) => e.id)).size,
  ).toBe(52);
  expect((await executionRead('f'.repeat(32))).status).toBe(400);
  expect((await executionRead('bad')).status).toBe(400);
  expect((await executionRead(events.nextCursor, 'absent')).status).toBe(404);
  expect((await load(crypto.randomUUID())).status).toBe(400);
  expect(
    (
      await signingStatus(
        new Request(
          'http://localhost/api/wallet-workspace/warmup/signing?planId=qa&preparationId=' +
            crypto.randomUUID(),
        ),
      )
    ).status,
  ).toBe(400);
  mocks.user = { userId: 'two' };
  expect((await load(page.nextCursor)).status).toBe(404);
  expect((await executionRead(events.nextCursor)).status).toBe(404);
  expect(
    (
      await signingActivity(
        new Request(
          'http://localhost/api/wallet-workspace/warmup/signing-activity?cursor=' +
            events.nextCursor,
        ),
      )
    ).status,
  ).toBe(400);
  expect(
    await (
      await signingActivity(
        new Request(
          'http://localhost/api/wallet-workspace/warmup/signing-activity',
        ),
      )
    ).json(),
  ).toEqual({ events: [], nextCursor: null });
  mocks.user = null;
  expect((await load()).status).toBe(401);
  expect((await executionRead()).status).toBe(401);
});
it('baselines existing approvals at migration time without reconstructing earlier transitions', async () => {
  await seedSigningApprovals(2);
  await mocks.db
    .prepare('DROP TRIGGER warmup_signing_events_immutable_delete')
    .run();
  await mocks.db.prepare('DELETE FROM warmup_signing_events').run();
  await mocks.db
    .prepare(
      "CREATE TRIGGER warmup_signing_events_immutable_delete BEFORE DELETE ON warmup_signing_events BEGIN SELECT RAISE(ABORT,'Warmup signing event is immutable'); END",
    )
    .run();
  await mocks.db
    .prepare(
      readFileSync('drizzle/0046_warmup_signing_events.sql', 'utf8').split(
        '--> statement-breakpoint',
      )[3],
    )
    .run();
  await request({ id: 'qa', expectedRevision: 1, action: 'archive' });
  const response = await signingActivity(
    new Request(
      'http://localhost/api/wallet-workspace/warmup/signing-activity?planId=qa',
    ),
  );
  expect(response.status).toBe(200);
  const page = (await response.json()) as {
    events: Array<{ type: string; state: string; createdAt: string }>;
    nextCursor: null;
  };
  expect(page.events).toHaveLength(2);
  expect(
    page.events.every(
      (e) =>
        e.type === 'approval.baseline' &&
        e.state === 'cancelled' &&
        Date.parse(e.createdAt) > Date.parse('2026-10-10T01:00:00.000Z'),
    ),
  ).toBe(true);
  expect(page.nextCursor).toBeNull();
});
it('reports inconsistent execution records and storage failures without fabricating empty activity', async () => {
  await seedSigningApprovals(1);
  const read = () =>
    signingActivity(
      new Request(
        'http://localhost/api/wallet-workspace/warmup/signing-activity',
      ),
    );
  await mocks.db
    .prepare('DROP TRIGGER warmup_signing_events_immutable_update')
    .run();
  await mocks.db
    .prepare(
      "UPDATE warmup_signing_events SET document=json_set(document,'$.sha256','invalid')",
    )
    .run();
  await mocks.db
    .prepare(
      "CREATE TRIGGER warmup_signing_events_immutable_update BEFORE UPDATE ON warmup_signing_events BEGIN SELECT RAISE(ABORT,'Warmup signing event is immutable'); END",
    )
    .run();
  expect((await read()).status).toBe(503);
  const prior = mocks.db;
  try {
    mocks.db = {
      prepare: () => {
        throw new Error('private storage details');
      },
    } as unknown as D1Database;
    const failed = await read();
    expect(failed.status).toBe(503);
    expect(await failed.text()).not.toContain('private storage details');
  } finally {
    mocks.db = prior;
  }
});
it('configured quote checks cycle bounds and withholds results after plan/wallet mutations', async () => {
  await mocks.db
    .prepare(
      'CREATE TABLE IF NOT EXISTS wallet_balance_gates(owner_id TEXT PRIMARY KEY,next_allowed_at INTEGER)',
    )
    .run();
  await mocks.db.exec('DELETE FROM wallet_balance_gates');
  await request();
  testEnv.JUPITER_API_KEY = 'disposable-test-key';
  const quoteRequest = (cycle = 2) =>
    quoteBuy(
      new Request('http://localhost/api/wallet-workspace/warmup/quote', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'qa', revision: 1, cycle }),
      }),
    );
  const mock = vi.spyOn(swapQuotes, 'quoteWarmupBuy').mockResolvedValue({
    executionAllowed: false,
    cycle: 2,
    expiresAt: new Date(Date.now() + 30000).toISOString(),
  } as swapQuotes.WarmupSwapQuote);
  expect((await quoteRequest(4)).status).toBe(400);
  expect(mock).not.toHaveBeenCalled();
  expect((await quoteRequest()).status).toBe(200);
  expect(mock.mock.calls[0][4]).toBe(2);
  expect((await quoteRequest()).status).toBe(429);
  await mocks.db.exec('DELETE FROM wallet_balance_gates');
  mock.mockImplementation(async () => {
    await mocks.db.exec('UPDATE workspace_wallets SET revision=2');
    return {
      expiresAt: new Date(Date.now() + 30000).toISOString(),
    } as swapQuotes.WarmupSwapQuote;
  });
  expect((await quoteRequest()).status).toBe(409);
  await mocks.db.exec(
    'DELETE FROM wallet_balance_gates; UPDATE workspace_wallets SET revision=1',
  );
  mock.mockImplementation(async () => {
    await mocks.db.exec('UPDATE wallet_warmup_plans SET archived=1');
    return {
      expiresAt: new Date(Date.now() + 30000).toISOString(),
    } as swapQuotes.WarmupSwapQuote;
  });
  expect((await quoteRequest()).status).toBe(409);
});
it('quote endpoint requires saved ownership and reports missing server configuration without a provider request', async () => {
  const quoteRequest = () =>
    quoteBuy(
      new Request('http://localhost/api/wallet-workspace/warmup/quote', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'qa', revision: 1 }),
      }),
    );
  mocks.user = null;
  expect((await quoteRequest()).status).toBe(401);
  mocks.user = { userId: 'one' };
  expect((await quoteRequest()).status).toBe(409);
  await request();
  const response = await quoteRequest();
  expect(response.status).toBe(503);
  expect(await response.text()).toContain('not configured');
  mocks.user = { userId: 'two' };
  expect((await quoteRequest()).status).toBe(409);
});
it('preflight requires an active owned unchanged plan and shared read gate', async () => {
  await mocks.db
    .prepare(
      'CREATE TABLE IF NOT EXISTS wallet_balance_gates(owner_id TEXT PRIMARY KEY,next_allowed_at INTEGER)',
    )
    .run();
  await mocks.db.exec('DELETE FROM wallet_balance_gates');
  await request();
  mocks.user = { userId: 'two' };
  expect((await check()).status).toBe(409);
  mocks.user = { userId: 'one' };
  expect((await check()).status).toBe(200);
  expect((await check()).status).toBe(429);
  expect(mocks.preflight).toHaveBeenCalledTimes(1);
  await mocks.db.exec(
    'DELETE FROM wallet_balance_gates; UPDATE workspace_wallets SET archived=1',
  );
  expect((await check()).status).toBe(409);
});
it('preflight withholds stale plan/wallet revisions after asynchronous checks', async () => {
  await mocks.db
    .prepare(
      'CREATE TABLE IF NOT EXISTS wallet_balance_gates(owner_id TEXT PRIMARY KEY,next_allowed_at INTEGER)',
    )
    .run();
  await mocks.db.exec('DELETE FROM wallet_balance_gates');
  await request();
  mocks.preflight.mockImplementation(async () => {
    await mocks.db.exec('UPDATE wallet_warmup_plans SET revision=2');
    return { executionAllowed: false };
  });
  expect((await check()).status).toBe(409);
  await mocks.db.exec(
    'DELETE FROM wallet_balance_gates; UPDATE wallet_warmup_plans SET revision=1',
  );
  mocks.preflight.mockImplementation(async () => {
    await mocks.db.exec('UPDATE workspace_wallets SET revision=2');
    return { executionAllowed: false };
  });
  expect((await check()).status).toBe(409);
});
it('preflight does not expose raw failure messages or grant a result on archived plans', async () => {
  await mocks.db
    .prepare(
      'CREATE TABLE IF NOT EXISTS wallet_balance_gates(owner_id TEXT PRIMARY KEY,next_allowed_at INTEGER)',
    )
    .run();
  await mocks.db.exec('DELETE FROM wallet_balance_gates');
  await request();
  mocks.preflight.mockRejectedValue(new Error('secret-preflight-rpc'));
  const r = await check();
  expect(r.status).toBe(502);
  expect(await r.text()).not.toContain('secret-preflight-rpc');
  await mocks.db.exec('UPDATE wallet_warmup_plans SET archived=1');
  expect((await check()).status).toBe(409);
});
it('persists only server-rebuilt public settings and isolates owners', async () => {
  expect((await request()).status).toBe(200);
  const p = (await list()).plans[0];
  expect(p.document.totalBudget).toBe('0.013');
  expect(p.revision).toBe(1);
  expect(p.document).not.toHaveProperty('executionAllowed');
  expect(p.document).not.toHaveProperty('actions');
  mocks.user = { userId: 'two' };
  expect((await list()).plans).toEqual([]);
  expect(
    (await request({ id: 'qa', expectedRevision: 1, action: 'archive' }))
      .status,
  ).toBe(409);
  expect((await request()).status).toBe(409);
});
it('allows exactly one concurrent edit and guards archive/restore revisions', async () => {
  await request();
  const edit = {
    id: 'qa',
    expectedRevision: 1,
    action: 'save',
    document: document(),
  };
  const responses = await Promise.all([request(edit), request(edit)]);
  expect(responses.map((r) => r.status).sort((a, b) => a - b)).toEqual([
    200, 409,
  ]);
  expect(
    (await request({ id: 'qa', expectedRevision: 2, action: 'archive' }))
      .status,
  ).toBe(200);
  expect((await request({ ...edit, expectedRevision: 3 })).status).toBe(409);
  expect(
    (await request({ id: 'qa', expectedRevision: 3, action: 'restore' }))
      .status,
  ).toBe(200);
  expect((await list()).plans[0]).toMatchObject({
    revision: 4,
    archived: false,
  });
});
it('rejects stale, archived and cross-chain wallet snapshots at save time', async () => {
  await mocks.db.exec('UPDATE workspace_wallets SET revision=2');
  expect((await request()).status).toBe(409);
  await mocks.db.exec('UPDATE workspace_wallets SET revision=1,archived=1');
  expect((await request()).status).toBe(409);
  await mocks.db.exec(
    "UPDATE workspace_wallets SET archived=0,chain='Ethereum'",
  );
  expect((await request()).status).toBe(409);
  expect((await list()).plans).toEqual([]);
});
it('requires auth/origin and bounds names, input and per-owner storage', async () => {
  mocks.user = null;
  expect((await GET()).status).toBe(401);
  expect((await request()).status).toBe(401);
  mocks.user = { userId: 'one' };
  expect(
    (await request(undefined, { origin: 'https://other.test' })).status,
  ).toBe(403);
  expect(
    (
      await request({
        id: 'qa',
        expectedRevision: 0,
        action: 'save',
        document: { ...document(), name: '\nsecret' },
      })
    ).status,
  ).toBe(400);
  const insert = mocks.db.prepare(
    'INSERT INTO wallet_warmup_plans(owner_id,id,document,revision,archived,updated_at) VALUES (?,?,?,1,0,?)',
  );
  await mocks.db.batch(
    Array.from({ length: 100 }, (_, i) =>
      insert.bind(
        'one',
        'full-' + i,
        JSON.stringify(document()),
        new Date().toISOString(),
      ),
    ),
  );
  expect((await request()).status).toBe(409);
  expect((await list()).plans).toHaveLength(100);
});

const solWallet = 'A1TMhSGzQxMr1TboBKtgixKz1sS6REASMxPo1qsyTSJd';
const solTokens = [
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  'So11111111111111111111111111111111111111112',
];
function preparedFixture(side: 'Buy' | 'Sell' = 'Buy') {
  const fixture = preparationHistoryFixture();
  const order = {
    executionAllowed: false,
    side,
    inputMint: side === 'Buy' ? solTokens[1] : solTokens[0],
    outputMint: side === 'Buy' ? solTokens[0] : solTokens[1],
    inAmount: side === 'Buy' ? '1000000' : '1000001',
    outAmount: '1000',
    minimumOutAmount: '995',
    slippageBps: 50,
    router: 'metis',
    source: 'fixture.test',
    observedAt: fixture.quotedAt,
    expiresAt: fixture.expiresAt,
    preparation: {
      executionAllowed: false,
      instructionsVerified: false,
      wallet: solWallet,
      sha256: fixture.transaction.sha256,
      transaction: 'private-packet-sentinel',
      transactionBytes: 300,
      instructionCount: 2,
      lookupTableCount: 0,
      lastValidBlockHeight: '200',
      estimatedFeesLamports: '5000',
    },
  } as swapQuotes.SolanaSwapPreparation;
  const simulation = {
    ...fixture.simulation,
    executionAllowed: false,
    instructionsVerified: false,
    wallet: solWallet,
    sha256: fixture.transaction.sha256,
    logs: ['private-log-sentinel'],
  } as unknown as simulations.ImportedSwapSimulation;
  return { order, simulation };
}
const prepareRequest = (overrides = {}, headers = {}) =>
  prepareBuy(
    new Request('http://localhost/api/wallet-workspace/warmup/prepare', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({
        id: 'qa',
        revision: 1,
        cycle: 3,
        wallet: solWallet,
        ...overrides,
      }),
    }),
  );
async function saveSolWarmup() {
  await mocks.db.exec(
    'DELETE FROM workspace_wallets; CREATE TABLE IF NOT EXISTS wallet_balance_gates(owner_id TEXT PRIMARY KEY,next_allowed_at INTEGER); DELETE FROM wallet_balance_gates',
  );
  await mocks.db
    .prepare('INSERT INTO workspace_wallets VALUES (?,?,?,?,?)')
    .bind('one', 'Solana', solWallet, 1, 0)
    .run();
  expect(
    (
      await request({
        id: 'qa',
        expectedRevision: 0,
        action: 'save',
        document: {
          ...document(),
          chain: 'Solana',
          addresses: [solWallet],
          walletRevisions: [{ address: solWallet, revision: 1 }],
          tokens: solTokens,
        },
      })
    ).status,
  ).toBe(200);
}
it('warmup sell inventory requires owned saved context but no Jupiter key', async () => {
  await saveSolWarmup();
  const inventory = vi
    .spyOn(sellInventory, 'inspectWarmupSellInventory')
    .mockResolvedValue({
      executionAllowed: false,
      decimals: 6,
      preparationSupported: true,
      amountCovered: true,
    } as sellInventory.WarmupSellInventory);
  const prepare = vi.spyOn(swapQuotes, 'prepareSolanaSwap');
  const response = await prepareRequest({ side: 'Sell', mode: 'inventory' });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    id: 'qa',
    revision: 1,
    cycle: 3,
    walletRevision: 1,
    inventory: { executionAllowed: false },
  });
  expect(inventory.mock.calls[0].slice(0, 2)).toEqual([
    solWallet,
    solTokens[0],
  ]);
  expect(prepare).not.toHaveBeenCalled();
  await mocks.db.exec('DELETE FROM wallet_balance_gates');
  inventory.mockImplementation(async () => {
    await mocks.db.exec('UPDATE workspace_wallets SET revision=2');
    return { executionAllowed: false } as sellInventory.WarmupSellInventory;
  });
  expect(
    (await prepareRequest({ side: 'Sell', mode: 'inventory' })).status,
  ).toBe(409);
});
it('warmup sell preparation uses fresh holdings decimals and withholds uncovered or unsupported inputs', async () => {
  await saveSolWarmup();
  testEnv.JUPITER_API_KEY = 'disposable-test-key';
  const inventory = vi
    .spyOn(sellInventory, 'inspectWarmupSellInventory')
    .mockResolvedValue({
      executionAllowed: false,
      wallet: solWallet,
      mint: solTokens[0],
      requestedRaw: '1000001',
      unfrozenRaw: '2000000',
      source: 'fixture.test',
      observedAt: new Date().toISOString(),
      minSlot: 100,
      maxSlot: 101,
      decimals: 6,
      preparationSupported: true,
      amountCovered: true,
    } as sellInventory.WarmupSellInventory);
  const fixture = preparedFixture('Sell');
  const prepare = vi
    .spyOn(swapQuotes, 'prepareSolanaSwap')
    .mockResolvedValue(fixture.order);
  vi.spyOn(simulations, 'simulateImportedSwap').mockResolvedValue(
    fixture.simulation,
  );
  expect(
    (await prepareRequest({ side: 'Sell', amount: '1.000001' })).status,
  ).toBe(200);
  expect(inventory.mock.calls[0][3]).toBe('1.000001');
  expect(prepare.mock.calls[0][0]).toEqual({
    tokenMint: solTokens[0],
    side: 'Sell',
    amount: '1.000001',
    decimals: 6,
    wallet: solWallet,
  });
  for (const held of [
    { preparationSupported: false, amountCovered: true },
    { preparationSupported: true, amountCovered: false },
    { preparationSupported: true, amountCovered: true, decimals: null },
  ]) {
    await mocks.db.exec('DELETE FROM wallet_balance_gates');
    inventory.mockResolvedValue({
      decimals: 6,
      ...held,
    } as sellInventory.WarmupSellInventory);
    expect(
      (await prepareRequest({ side: 'Sell', amount: '1.000001' })).status,
    ).toBe(409);
  }
  expect(prepare).toHaveBeenCalledTimes(1);
  expect((await prepareRequest({ side: 'Sell' })).status).toBe(400);
  await mocks.db.exec('DELETE FROM wallet_balance_gates');
  inventory.mockRejectedValue(
    new sellInventory.WarmupSellAmountError(
      'Use a positive sell amount within the observed token decimals and Solana limits.',
    ),
  );
  expect(
    (await prepareRequest({ side: 'Sell', amount: '1.0000001' })).status,
  ).toBe(400);
});
it('warmup preparation derives the exact saved cycle, wallet and input and shares the read gate', async () => {
  await saveSolWarmup();
  testEnv.JUPITER_API_KEY = 'disposable-test-key';
  const { order, simulation } = preparedFixture();
  const prepare = vi
    .spyOn(swapQuotes, 'prepareSolanaSwap')
    .mockResolvedValue(order);
  const simulate = vi
    .spyOn(simulations, 'simulateImportedSwap')
    .mockResolvedValue(simulation);
  const response = await prepareRequest({
    amount: '999',
    tokenMint: solTokens[1],
    walletRevision: 99,
  });
  expect(response.status).toBe(200);
  const preparedResponse = (await response.json()) as { reviewWaitMs: number };
  expect(preparedResponse.reviewWaitMs).toBeGreaterThan(0);
  expect(preparedResponse.reviewWaitMs).toBeLessThanOrEqual(15000);
  expect(preparedResponse).toMatchObject({
    id: 'qa',
    revision: 1,
    cycle: 3,
    walletRevision: 1,
    simulation,
  });
  expect(prepare.mock.calls[0][0]).toEqual({
    tokenMint: solTokens[0],
    side: 'Buy',
    amount: '0.001',
    decimals: 9,
    wallet: solWallet,
  });
  expect(simulate.mock.calls[0][0]).toBe(order);
  expect((await prepareRequest()).status).toBe(429);
});
it('warmup preparation rejects unauthorized, stale, out-of-plan and unconfigured requests before provider work', async () => {
  const prepare = vi.spyOn(swapQuotes, 'prepareSolanaSwap');
  mocks.user = null;
  expect((await prepareRequest()).status).toBe(401);
  mocks.user = { userId: 'one' };
  expect(
    (await prepareRequest({}, { origin: 'https://other.test' })).status,
  ).toBe(403);
  expect((await prepareRequest({ cycle: 0 })).status).toBe(400);
  await saveSolWarmup();
  expect((await prepareRequest({ cycle: 4 })).status).toBe(400);
  expect((await prepareRequest({ wallet: solTokens[0] })).status).toBe(400);
  expect((await prepareRequest()).status).toBe(503);
  mocks.user = { userId: 'two' };
  expect((await prepareRequest()).status).toBe(409);
  mocks.user = { userId: 'one' };
  await mocks.db.exec('UPDATE workspace_wallets SET revision=2');
  expect((await prepareRequest()).status).toBe(409);
  expect(prepare).not.toHaveBeenCalled();
});
it('warmup preparation withholds changed or expired orders and sanitizes provider failures', async () => {
  await saveSolWarmup();
  testEnv.JUPITER_API_KEY = 'disposable-test-key';
  const { order } = preparedFixture();
  const prepare = vi
    .spyOn(swapQuotes, 'prepareSolanaSwap')
    .mockImplementation(async () => {
      await mocks.db.exec('UPDATE workspace_wallets SET archived=1');
      return order;
    });
  const simulate = vi
    .spyOn(simulations, 'simulateImportedSwap')
    .mockResolvedValue({
      executionAllowed: false,
    } as simulations.ImportedSwapSimulation);
  expect((await prepareRequest()).status).toBe(409);
  expect(simulate).not.toHaveBeenCalled();
  await mocks.db.exec(
    'DELETE FROM wallet_balance_gates; UPDATE workspace_wallets SET archived=0',
  );
  prepare.mockResolvedValue(order);
  simulate.mockImplementation(async () => {
    await mocks.db.exec('UPDATE wallet_warmup_plans SET archived=1');
    return { executionAllowed: false } as simulations.ImportedSwapSimulation;
  });
  expect((await prepareRequest()).status).toBe(409);
  await mocks.db.exec(
    'DELETE FROM wallet_balance_gates; UPDATE wallet_warmup_plans SET archived=0',
  );
  prepare.mockResolvedValue({
    ...order,
    expiresAt: new Date(Date.now() - 1).toISOString(),
  });
  expect((await prepareRequest()).status).toBe(409);
  await mocks.db.exec('DELETE FROM wallet_balance_gates');
  prepare.mockRejectedValue(new Error('private-provider-error'));
  const response = await prepareRequest();
  expect(response.status).toBe(502);
  expect(await response.text()).not.toContain('private-provider-error');
});

const readPreparationHistory = (cursor?: string) =>
  preparationHistory(
    new Request(
      `http://localhost/api/wallet-workspace/warmup/preparations?id=qa${cursor ? '&cursor=' + encodeURIComponent(cursor) : ''}`,
    ),
  );
const buySignature = bs58.encode(new Uint8Array(64).fill(3));
const receiptDocument = (): buyReceiptReader.WarmupBuyReceipt => ({
  executionAllowed: false,
  instructionsVerified: false,
  network: 'mainnet',
  commitment: 'finalized',
  signatureVerified: true,
  signature: buySignature,
  wallet: solWallet,
  mint: solTokens[0],
  preparationSha256: preparationHistoryFixture().transaction.sha256,
  slot: 99,
  blockTime: null,
  acquiredRaw: '1000001',
  decimals: 6,
  tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  accounts: [],
  networkFeeLamports: '5000',
  nativeChangeRaw: '-1005000',
  rentChangeRaw: '0',
  nativeSettlementRaw: '-1000000',
  source: 'fixture.test',
  observedAt: new Date().toISOString(),
  limitations: 'Mock receipt. No live transaction.',
});
const verifyReceipt = (
  preparationId: string,
  signature = buySignature,
  headers = {},
) =>
  verifyBuyReceipt(
    new Request('http://localhost/api/wallet-workspace/warmup/buy-receipts', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ preparationId, signature }),
    }),
  );
const receiptHistory = () =>
  buyReceipts(
    new Request(
      'http://localhost/api/wallet-workspace/warmup/buy-receipts?id=qa',
    ),
  );
it('reads owned finalized cycle progress across archives and refuses stale or inconsistent state', async () => {
  await saveSolWarmup();
  const read = (revision = 1, earlier = false) =>
    cycleProgress(
      new Request(
        `http://localhost/api/wallet-workspace/warmup/cycle-progress?id=qa&revision=${revision}&includeEarlier=${earlier}`,
      ),
    );
  const initial = await read();
  expect(initial.status).toBe(200);
  expect((await initial.json()) as object).toMatchObject({
    completedSteps: 0,
    steps: expect.any(Array),
  });
  const captured = await storedBuy();
  vi.spyOn(buyReceiptReader, 'observeWarmupBuyReceipt').mockResolvedValue(
    receiptDocument(),
  );
  const verified = await verifyReceipt(captured.id);
  expect(verified.status).toBe(200);
  const { receipt } = (await verified.json()) as {
    receipt: buyReceiptReader.SavedWarmupBuyReceipt;
  };
  const progress = (await (await read()).json()) as {
    steps: Array<{ cycle: number; state: string; remainingRaw: string }>;
  };
  expect(progress.steps.find((row) => row.cycle === 3)).toMatchObject({
    state: 'Tokens remaining',
    remainingRaw: '1000001',
  });
  await mocks.db.batch([
    mocks.db
      .prepare('UPDATE warmup_buy_receipts SET remaining_raw=? WHERE id=?')
      .bind('0', receipt.id),
    mocks.db
      .prepare('INSERT INTO warmup_sell_receipts VALUES (?,?,?,?,?,?,?,?,?)')
      .bind(
        crypto.randomUUID(),
        'one',
        crypto.randomUUID(),
        receipt.id,
        'qa',
        bs58.encode(new Uint8Array(64).fill(4)),
        '1000001',
        JSON.stringify({
          ...receipt.document,
          slot: 100,
          nativeSettlementRaw: '2000000',
          nativeChangeRaw: '1995000',
          signatureVerified: true,
          signature: bs58.encode(new Uint8Array(64).fill(4)),
          consumedRaw: '1000001',
          buyReceiptId: receipt.id,
          network: 'mainnet',
          commitment: 'finalized',
        }),
        new Date().toISOString(),
      ),
  ]);
  expect((await (await read()).json()) as object).toMatchObject({
    completedSteps: 1,
  });
  const pendingId = crypto.randomUUID();
  await mocks.db
    .prepare(
      "INSERT INTO warmup_signing_intents(id,owner_id,preparation_id,wallet_address,document,state,signature,created_at,updated_at) VALUES (?,?,?,?,?,'signed',?,?,?)",
    )
    .bind(
      pendingId,
      'one',
      crypto.randomUUID(),
      solWallet,
      '{}',
      'synthetic-reserved-signature',
      new Date().toISOString(),
      new Date().toISOString(),
    )
    .run();
  const blocked = (await (await read()).json()) as {
    activeApprovals: number;
    completedSteps: number;
    steps: Array<{ state: string }>;
  };
  expect(blocked.activeApprovals).toBe(1);
  expect(blocked.completedSteps).toBe(0);
  expect(
    blocked.steps.every((step) => step.state === 'Recovery required'),
  ).toBe(true);
  await mocks.db
    .prepare("UPDATE warmup_signing_intents SET state='cancelled' WHERE id=?")
    .bind(pendingId)
    .run();
  await request({ id: 'qa', expectedRevision: 1, action: 'archive' });
  expect((await read()).status).toBe(409);
  expect((await (await read(2)).json()) as object).toMatchObject({
    archived: true,
    completedSteps: 0,
    excludedBuys: 1,
  });
  expect((await (await read(2, true)).json()) as object).toMatchObject({
    archived: true,
    completedSteps: 1,
  });
  await mocks.db
    .prepare('UPDATE warmup_buy_receipts SET remaining_raw=? WHERE id=?')
    .bind('1', receipt.id)
    .run();
  expect((await read(2, true)).status).toBe(503);
  await mocks.db
    .prepare('UPDATE warmup_buy_receipts SET remaining_raw=? WHERE id=?')
    .bind('0', receipt.id)
    .run();
  await mocks.db
    .prepare(
      "UPDATE warmup_sell_receipts SET document=json_set(document,'$.consumedRaw','999') WHERE plan_id='qa'",
    )
    .run();
  expect((await read(2, true)).status).toBe(503);
  mocks.user = { userId: 'other' };
  expect((await read(2, true)).status).toBe(404);
  mocks.user = null;
  expect((await read(2, true)).status).toBe(401);
});
it.each(['buy', 'sell'] as const)(
  'pages archived %s receipts with tied timestamps and owned cursor fences',
  async (side) => {
    await request();
    const date = '2026-10-11T02:00:00.000Z';
    for (let n = 1; n <= 52; n++) {
      const id = `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
      if (side === 'buy')
        await mocks.db
          .prepare(
            'INSERT INTO warmup_buy_receipts(id,owner_id,preparation_id,plan_id,plan_revision,cycle,wallet_address,wallet_revision,signature,document,created_at,remaining_raw) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
          )
          .bind(
            id,
            'one',
            id,
            'qa',
            1,
            1,
            address,
            1,
            id,
            JSON.stringify({
              signatureVerified: true,
              acquiredRaw: '18446744073709551615',
            }),
            date,
            '18446744073709551615',
          )
          .run();
      else
        await mocks.db
          .prepare(
            'INSERT INTO warmup_sell_receipts(id,owner_id,preparation_id,buy_receipt_id,plan_id,signature,consumed_raw,document,created_at) VALUES (?,?,?,?,?,?,?,?,?)',
          )
          .bind(
            id,
            'one',
            id,
            id,
            'qa',
            id,
            '18446744073709551615',
            JSON.stringify({
              signatureVerified: true,
              consumedRaw: '18446744073709551615',
            }),
            date,
          )
          .run();
    }
    await request({ id: 'qa', expectedRevision: 1, action: 'archive' });
    const read = (cursor?: string, planId = 'qa') =>
      (side === 'buy' ? buyReceipts : sellReceipts)(
        new Request(
          `http://localhost/api/wallet-workspace/warmup/${side}-receipts?id=${planId}${cursor !== undefined ? '&cursor=' + encodeURIComponent(cursor) : ''}`,
        ),
      );
    const first = (await (await read()).json()) as {
      receipts: {
        id: string;
        remainingRaw?: string;
        document: { consumedRaw?: string };
      }[];
      nextCursor: string;
    };
    expect(first.receipts).toHaveLength(50);
    expect(first.receipts[0].id).toBe('00000000-0000-4000-8000-000000000052');
    if (side === 'buy')
      expect(first.receipts[0].remainingRaw).toBe('18446744073709551615');
    else
      expect(first.receipts[0].document.consumedRaw).toBe(
        '18446744073709551615',
      );
    const second = (await (
      await read(first.nextCursor)
    ).json()) as typeof first;
    expect(second.receipts).toHaveLength(2);
    expect(second.nextCursor).toBeNull();
    expect(
      new Set([...first.receipts, ...second.receipts].map((row) => row.id))
        .size,
    ).toBe(52);
    expect((await read('')).status).toBe(400);
    expect(
      (
        await read(
          JSON.stringify({
            createdAt: date,
            id: '00000000-0000-4000-8000-000000000099',
          }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await read(
          JSON.stringify({
            ...JSON.parse(first.nextCursor),
            createdAt: '2026-10-10T00:00:00.000Z',
          }),
        )
      ).status,
    ).toBe(400);
    await request({
      id: 'other',
      expectedRevision: 0,
      action: 'save',
      document: document(),
    });
    expect((await read(first.nextCursor, 'other')).status).toBe(400);
    mocks.user = { userId: 'two' };
    expect((await read(first.nextCursor)).status).toBe(404);
    mocks.user = null;
    expect((await read()).status).toBe(401);
  },
);
async function storedBuy() {
  const captured = await mocks.db
    .prepare(
      "SELECT document FROM wallet_warmup_plans WHERE owner_id='one' AND id='qa'",
    )
    .first<{ document: string }>();
  const { order, simulation } = preparedFixture();
  const record = await saveWarmupPreparation(
    mocks.db,
    'one',
    { planId: 'qa', planRevision: 1, cycle: 3, walletRevision: 1 },
    warmupPreparationSummary(order, simulation, solTokens[0]),
    captured!.document,
  );
  expect(record).not.toBeNull();
  return record!;
}
it('saves verified buy receipt context idempotently and retains it across archives with owner isolation', async () => {
  await saveSolWarmup();
  const buy = await storedBuy();
  const observe = vi
    .spyOn(buyReceiptReader, 'observeWarmupBuyReceipt')
    .mockResolvedValue(receiptDocument());
  const response = await verifyReceipt(buy.id);
  expect(response.status).toBe(200);
  const data = (await response.json()) as {
    receipt: buyReceiptReader.SavedWarmupBuyReceipt;
  };
  expect(data.receipt).toMatchObject({
    preparationId: buy.id,
    planId: 'qa',
    planRevision: 1,
    cycle: 3,
    walletRevision: 1,
    document: { signature: buySignature, acquiredRaw: '1000001' },
  });
  expect(observe.mock.calls[0][0].document.transaction.sha256).toBe(
    buy.document.transaction.sha256,
  );
  expect((await verifyReceipt(buy.id)).status).toBe(200);
  expect(observe).toHaveBeenCalledTimes(1);
  expect(
    (await verifyReceipt(buy.id, bs58.encode(new Uint8Array(64).fill(4))))
      .status,
  ).toBe(409);
  await mocks.db.exec('UPDATE wallet_warmup_plans SET archived=1,revision=2');
  expect(await (await receiptHistory()).json()).toMatchObject({
    planId: 'qa',
    executionAllowed: false,
    receipts: [data.receipt],
  });
  mocks.user = { userId: 'other' };
  expect((await receiptHistory()).status).toBe(404);
  expect((await verifyReceipt(buy.id)).status).toBe(409);
  mocks.user = null;
  expect((await receiptHistory()).status).toBe(401);
  expect((await verifyReceipt(buy.id)).status).toBe(401);
});
it('rejects invalid receipt writes before provider work and withholds receipts after plan or wallet races', async () => {
  await saveSolWarmup();
  const buy = await storedBuy();
  const observe = vi
    .spyOn(buyReceiptReader, 'observeWarmupBuyReceipt')
    .mockResolvedValue(receiptDocument());
  expect(
    (
      await verifyReceipt(buy.id, buySignature, {
        origin: 'https://other.test',
      })
    ).status,
  ).toBe(403);
  expect((await verifyReceipt('bad')).status).toBe(400);
  expect((await verifyReceipt(buy.id, 'bad')).status).toBe(400);
  expect(observe).not.toHaveBeenCalled();
  observe.mockImplementation(async () => {
    await mocks.db.exec('UPDATE wallet_warmup_plans SET revision=2');
    return receiptDocument();
  });
  expect((await verifyReceipt(buy.id)).status).toBe(409);
  await mocks.db.exec(
    'UPDATE wallet_warmup_plans SET revision=1; DELETE FROM wallet_balance_gates',
  );
  observe.mockImplementation(async () => {
    await mocks.db.exec('UPDATE workspace_wallets SET revision=2');
    return receiptDocument();
  });
  expect((await verifyReceipt(buy.id)).status).toBe(409);
  expect(await (await receiptHistory()).json()).toMatchObject({ receipts: [] });
  await mocks.db.exec(
    'UPDATE workspace_wallets SET revision=1; DELETE FROM wallet_balance_gates',
  );
  observe.mockRejectedValue(new Error('private-provider-sentinel'));
  const failure = await verifyReceipt(buy.id);
  expect(failure.status).toBe(502);
  expect(await failure.text()).not.toContain('private-provider-sentinel');
});
it('caps receipt storage and prevents reusing one signature for a second saved buy', async () => {
  await saveSolWarmup();
  const buy = await storedBuy(),
    otherBuy = await storedBuy();
  const observe = vi
    .spyOn(buyReceiptReader, 'observeWarmupBuyReceipt')
    .mockResolvedValue(receiptDocument());
  expect((await verifyReceipt(buy.id)).status).toBe(200);
  expect((await verifyReceipt(otherBuy.id)).status).toBe(429);
  expect(observe).toHaveBeenCalledTimes(1);
  await mocks.db.exec('DELETE FROM wallet_balance_gates');
  expect((await verifyReceipt(otherBuy.id)).status).toBe(409);
  await mocks.db
    .prepare(
      `WITH RECURSIVE seq(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM seq WHERE i<?)
    INSERT INTO warmup_buy_receipts(id,owner_id,preparation_id,plan_id,plan_revision,cycle,wallet_address,wallet_revision,signature,document,created_at) SELECT printf('quota-%d',i),'one',printf('preparation-%d',i),'qa',1,3,?,1,printf('signature-%d',i),?,? FROM seq`,
    )
    .bind(
      WARMUP_HISTORY_LIMIT - 2,
      solWallet,
      JSON.stringify(receiptDocument()),
      new Date().toISOString(),
    )
    .run();
  const lastSignature = bs58.encode(new Uint8Array(64).fill(9));
  observe.mockResolvedValue({ ...receiptDocument(), signature: lastSignature });
  await mocks.db.exec('DELETE FROM wallet_balance_gates');
  expect((await verifyReceipt(otherBuy.id, lastSignature)).status).toBe(200);
  expect(
    await mocks.db
      .prepare(
        "SELECT COUNT(*) AS n FROM warmup_buy_receipts WHERE owner_id='one' AND plan_id='qa'",
      )
      .first(),
  ).toEqual({ n: WARMUP_HISTORY_LIMIT });
  const nextBuy = await storedBuy();
  observe.mockClear();
  expect((await verifyReceipt(nextBuy.id)).status).toBe(409);
  expect(observe).not.toHaveBeenCalled();
});
it('retains the matched receipt in sell preparation and rejects inputs above acquisition before quoting', async () => {
  await saveSolWarmup();
  const buy = await storedBuy();
  vi.spyOn(buyReceiptReader, 'observeWarmupBuyReceipt').mockResolvedValue(
    receiptDocument(),
  );
  const data = (await (await verifyReceipt(buy.id)).json()) as {
    receipt: buyReceiptReader.SavedWarmupBuyReceipt;
  };
  await mocks.db.exec('DELETE FROM wallet_balance_gates');
  testEnv.JUPITER_API_KEY = 'fixture-key';
  const inventory = {
    executionAllowed: false,
    wallet: solWallet,
    mint: solTokens[0],
    tokenProgram: receiptDocument().tokenProgram,
    requestedRaw: '1000001',
    unfrozenRaw: '9000000',
    source: 'fixture.test',
    observedAt: new Date().toISOString(),
    minSlot: 100,
    maxSlot: 101,
    decimals: 6,
    preparationSupported: true,
    amountCovered: true,
  } as sellInventory.WarmupSellInventory;
  const inspect = vi
    .spyOn(sellInventory, 'inspectWarmupSellInventory')
    .mockResolvedValue(inventory);
  const fixture = preparedFixture('Sell');
  const prepare = vi
    .spyOn(swapQuotes, 'prepareSolanaSwap')
    .mockResolvedValue(fixture.order);
  vi.spyOn(simulations, 'simulateImportedSwap').mockResolvedValue(
    fixture.simulation,
  );
  const response = await prepareRequest({
    side: 'Sell',
    amount: '1.000001',
    buyReceiptId: data.receipt.id,
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    buyLink: { receiptId: data.receipt.id, acquiredRaw: '1000001' },
    history: {
      document: {
        buyReceipt: { receiptId: data.receipt.id, signature: buySignature },
      },
    },
  });
  for (const patch of [
    { requestedRaw: '1000002' },
    { minSlot: 98 },
    { decimals: 9 },
  ]) {
    await mocks.db.exec('DELETE FROM wallet_balance_gates');
    inspect.mockResolvedValue({ ...inventory, ...patch });
    expect(
      (
        await prepareRequest({
          side: 'Sell',
          amount: '1.000001',
          buyReceiptId: data.receipt.id,
        })
      ).status,
    ).toBe(409);
  }
  expect(prepare).toHaveBeenCalledTimes(1);
  await mocks.db.exec('UPDATE warmup_buy_receipts SET cycle=2');
  inspect.mockClear();
  expect(
    (
      await prepareRequest({
        side: 'Sell',
        amount: '1.000001',
        buyReceiptId: data.receipt.id,
      })
    ).status,
  ).toBe(409);
  expect(inspect).not.toHaveBeenCalled();
});
it('retains unsigned warmup reviews with cycle context across archives, without packets or logs', async () => {
  await saveSolWarmup();
  testEnv.JUPITER_API_KEY = 'test-key';
  const { order, simulation } = preparedFixture();
  vi.spyOn(swapQuotes, 'prepareSolanaSwap').mockResolvedValue(order);
  vi.spyOn(simulations, 'simulateImportedSwap').mockResolvedValue(simulation);
  const response = await prepareRequest();
  expect(response.status).toBe(200);
  const data = (await response.json()) as {
    history: { id: string; document: { transaction: { sha256: string } } };
  };
  expect(data.history.id).toMatch(/^[a-f0-9-]{36}$/);
  expect(data.history.document.transaction.sha256).toBe(
    order.preparation.sha256,
  );
  const saved = await (await readPreparationHistory()).json();
  expect(saved).toMatchObject({
    planId: 'qa',
    executionAllowed: false,
    preparations: [
      {
        planRevision: 1,
        cycle: 3,
        walletRevision: 1,
        document: { side: 'Buy', inventory: null, executionAllowed: false },
      },
    ],
  });
  expect(JSON.stringify(saved)).not.toMatch(
    /private-packet-sentinel|private-log-sentinel/,
  );
  await mocks.db.exec('UPDATE wallet_warmup_plans SET archived=1,revision=2');
  expect(await (await readPreparationHistory()).json()).toEqual(saved);
  mocks.user = { userId: 'another' };
  expect((await readPreparationHistory()).status).toBe(404);
  mocks.user = null;
  expect((await readPreparationHistory()).status).toBe(401);
});
it('pages tied warmup preparation timestamps and rejects foreign or malformed cursors', async () => {
  await saveSolWarmup();
  const { order, simulation } = preparedFixture(),
    summary = warmupPreparationSummary(order, simulation, solTokens[0]);
  const timestamp = '2026-10-11T00:00:00.000Z';
  await mocks.db
    .prepare(
      `WITH RECURSIVE seq(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM seq WHERE i<23)
    INSERT INTO warmup_swap_preparations SELECT printf('00000000-0000-4000-8000-%012d',i),'one','qa',1,3,?,1,?,? FROM seq`,
    )
    .bind(solWallet, JSON.stringify(summary), timestamp)
    .run();
  const first = (await (await readPreparationHistory()).json()) as {
    preparations: Array<{ id: string }>;
    nextCursor: string;
  };
  expect(first.preparations).toHaveLength(20);
  const second = (await (
    await readPreparationHistory(first.nextCursor)
  ).json()) as {
    preparations: Array<{ id: string }>;
    nextCursor: string | null;
  };
  expect(second.preparations).toHaveLength(3);
  expect(second.nextCursor).toBeNull();
  expect(
    new Set(
      [...first.preparations, ...second.preparations].map((row) => row.id),
    ).size,
  ).toBe(23);
  expect(
    (
      await readPreparationHistory(
        JSON.stringify({ createdAt: timestamp, id: crypto.randomUUID() }),
      )
    ).status,
  ).toBe(400);
  expect(
    (
      await readPreparationHistory(
        JSON.stringify({ ...JSON.parse(first.nextCursor), extra: true }),
      )
    ).status,
  ).toBe(400);
  expect((await readPreparationHistory('bad')).status).toBe(400);
});
it('withholds warmup orders on history storage failure and refuses full history before provider work', async () => {
  await saveSolWarmup();
  testEnv.JUPITER_API_KEY = 'test-key';
  const { order, simulation } = preparedFixture();
  const prepare = vi
    .spyOn(swapQuotes, 'prepareSolanaSwap')
    .mockResolvedValue(order);
  const simulate = vi
    .spyOn(simulations, 'simulateImportedSwap')
    .mockResolvedValue(simulation);
  await mocks.db
    .prepare(
      "CREATE TRIGGER fail_preparation BEFORE INSERT ON warmup_swap_preparations BEGIN SELECT RAISE(FAIL,'private-storage-sentinel'); END",
    )
    .run();
  try {
    const failed = await prepareRequest();
    expect(failed.status).toBe(502);
    expect(await failed.text()).not.toMatch(
      /private-storage-sentinel|private-packet-sentinel/,
    );
  } finally {
    await mocks.db.prepare('DROP TRIGGER fail_preparation').run();
  }
  const summary = warmupPreparationSummary(order, simulation, solTokens[0]);
  const captured = await mocks.db
    .prepare(
      "SELECT document FROM wallet_warmup_plans WHERE owner_id='one' AND id='qa'",
    )
    .first<{ document: string }>();
  const context = {
    planId: 'qa',
    planRevision: 1,
    cycle: 3,
    walletRevision: 1,
  };
  expect(
    await saveWarmupPreparation(
      mocks.db,
      'another',
      context,
      summary,
      captured!.document,
    ),
  ).toBeNull();
  expect(
    await saveWarmupPreparation(
      mocks.db,
      'one',
      { ...context, planRevision: 2 },
      summary,
      captured!.document,
    ),
  ).toBeNull();
  await mocks.db.exec('UPDATE workspace_wallets SET revision=2');
  expect(
    await saveWarmupPreparation(
      mocks.db,
      'one',
      context,
      summary,
      captured!.document,
    ),
  ).toBeNull();
  await mocks.db.exec('UPDATE workspace_wallets SET revision=1');
  await mocks.db
    .prepare(
      `WITH RECURSIVE seq(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM seq WHERE i<?)
    INSERT INTO warmup_swap_preparations SELECT printf('00000000-0000-4000-8000-%012d',i),'one','qa',1,3,?,1,?,? FROM seq`,
    )
    .bind(
      WARMUP_HISTORY_LIMIT - 1,
      solWallet,
      JSON.stringify(summary),
      new Date().toISOString(),
    )
    .run();
  const lastWrites = await Promise.all(
    Array.from({ length: 2 }, () =>
      saveWarmupPreparation(
        mocks.db,
        'one',
        context,
        summary,
        captured!.document,
      ),
    ),
  );
  expect(lastWrites.filter(Boolean)).toHaveLength(1);
  expect(
    await mocks.db
      .prepare(
        "SELECT COUNT(*) AS n FROM warmup_swap_preparations WHERE owner_id='one' AND plan_id='qa'",
      )
      .first(),
  ).toEqual({ n: WARMUP_HISTORY_LIMIT });
  expect(
    await saveWarmupPreparation(
      mocks.db,
      'one',
      context,
      summary,
      captured!.document,
    ),
  ).toBeNull();
  prepare.mockClear();
  simulate.mockClear();
  expect((await prepareRequest()).status).toBe(409);
  expect(prepare).not.toHaveBeenCalled();
  expect(simulate).not.toHaveBeenCalled();
});

it('atomically consumes remaining buy units once under concurrent sell receipts and retains exact integers', async () => {
  await saveSolWarmup();
  const buy = await storedBuy();
  vi.spyOn(buyReceiptReader, 'observeWarmupBuyReceipt').mockResolvedValue(
    receiptDocument(),
  );
  const data = (await (await verifyReceipt(buy.id)).json()) as {
    receipt: buyReceiptReader.SavedWarmupBuyReceipt;
  };
  const lot = data.receipt;
  lot.remainingRaw = '1000001';
  const context = {
    planId: lot.planId,
    planRevision: lot.planRevision,
    cycle: lot.cycle,
    walletRevision: lot.walletRevision,
    wallet: lot.document.wallet,
    mint: lot.document.mint,
  };
  const link = warmupBuyLink(lot, context);
  const sell = {
    ...buy,
    id: crypto.randomUUID(),
    document: {
      ...buy.document,
      side: 'Sell' as const,
      inputMint: lot.document.mint,
      outputMint: 'So11111111111111111111111111111111111111112',
      inAmountRaw: '600001',
      buyReceipt: link,
    },
  };
  const other = { ...sell, id: crypto.randomUUID() };
  for (const row of [sell, other])
    await mocks.db
      .prepare(
        'INSERT INTO warmup_swap_preparations VALUES (?,?,?,?,?,?,?,?,?)',
      )
      .bind(
        row.id,
        'one',
        row.planId,
        row.planRevision,
        row.cycle,
        solWallet,
        row.walletRevision,
        JSON.stringify(row.document),
        row.createdAt,
      )
      .run();
  const document = {
    ...receiptDocument(),
    signature: bs58.encode(new Uint8Array(64).fill(4)),
    consumedRaw: '600001',
    buyReceiptId: lot.id,
    slot: 100,
  } as WarmupSellReceipt;
  await mocks.db
    .prepare(
      `WITH RECURSIVE seq(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM seq WHERE i<?)
    INSERT INTO warmup_sell_receipts(id,owner_id,preparation_id,buy_receipt_id,plan_id,signature,consumed_raw,document,created_at)
    SELECT printf('quota-%d',i),'one',printf('quota-prep-%d',i),'quota-lot','qa',printf('quota-sig-%d',i),'1',?,? FROM seq`,
    )
    .bind(
      WARMUP_HISTORY_LIMIT - 1,
      JSON.stringify(document),
      new Date().toISOString(),
    )
    .run();
  const results = await Promise.all([
    saveWarmupSellReceipt(mocks.db, 'one', sell, lot, document),
    saveWarmupSellReceipt(mocks.db, 'one', other, lot, {
      ...document,
      signature: bs58.encode(new Uint8Array(64).fill(5)),
    }),
  ]);
  expect(results.filter(Boolean)).toHaveLength(1);
  expect(
    await mocks.db
      .prepare(
        "SELECT COUNT(*) AS n FROM warmup_sell_receipts WHERE owner_id='one' AND plan_id='qa'",
      )
      .first(),
  ).toEqual({ n: WARMUP_HISTORY_LIMIT });
  expect(
    await mocks.db
      .prepare('SELECT remaining_raw AS n FROM warmup_buy_receipts WHERE id=?')
      .bind(lot.id)
      .first(),
  ).toEqual({ n: '400000' });
  const successful = results[0] ? sell : other;
  const successfulDoc = results[0]
    ? document
    : { ...document, signature: bs58.encode(new Uint8Array(64).fill(5)) };
  expect(
    await saveWarmupSellReceipt(
      mocks.db,
      'one',
      successful,
      lot,
      successfulDoc,
    ),
  ).toBeNull();
  expect(
    await saveWarmupSellReceipt(mocks.db, 'two', sell, lot, document),
  ).toBeNull();
  const remainder = {
    ...sell,
    id: crypto.randomUUID(),
    document: { ...sell.document, inAmountRaw: '400000' },
  };
  await mocks.db
    .prepare('INSERT INTO warmup_swap_preparations VALUES (?,?,?,?,?,?,?,?,?)')
    .bind(
      remainder.id,
      'one',
      remainder.planId,
      remainder.planRevision,
      remainder.cycle,
      solWallet,
      remainder.walletRevision,
      JSON.stringify(remainder.document),
      remainder.createdAt,
    )
    .run();
  expect(
    await saveWarmupSellReceipt(
      mocks.db,
      'one',
      remainder,
      { ...lot, remainingRaw: '400000' },
      {
        ...document,
        signature: bs58.encode(new Uint8Array(64).fill(8)),
        consumedRaw: '400000',
      },
    ),
  ).toBeNull();
  expect(
    await mocks.db
      .prepare('SELECT remaining_raw AS n FROM warmup_buy_receipts WHERE id=?')
      .bind(lot.id)
      .first(),
  ).toEqual({ n: '400000' });
  expect(() =>
    warmupBuyLink({ ...lot, remainingRaw: '400000' }, context, {
      wallet: solWallet,
      mint: lot.document.mint,
      tokenProgram: lot.document.tokenProgram,
      decimals: 6,
      minSlot: 100,
      requestedRaw: '400001',
    } as sellInventory.WarmupSellInventory),
  ).toThrow();
  await expect(
    saveWarmupSellReceipt(
      mocks.db,
      'one',
      sell,
      { ...lot, remainingRaw: '400000' },
      document,
    ),
  ).rejects.toThrow('exceeds');
});

it('registers the exact cryptographic signature before submission, isolates owners and recovers a finalized failure without a send', async () => {
  const pair = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7)),
    wallet = bs58.encode(pair.publicKey),
    destination = bs58.encode(new Uint8Array(32).fill(2));
  const message = Uint8Array.from([
      128,
      ...solanaTransferMessage(
        wallet,
        destination,
        '11111111111111111111111111111111',
        1n,
      ),
      0,
    ]),
    bytes = Uint8Array.from([1, ...new Uint8Array(64), ...message]);
  const review: WarmupSigningReview = {
    id: crypto.randomUUID(),
    preparationId: crypto.randomUUID(),
    wallet,
    sha256: Array.from(
      new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.buffer)),
      (b) => b.toString(16).padStart(2, '0'),
    ).join(''),
    transaction: btoa(String.fromCharCode(...bytes)),
    network: 'mainnet',
    expiresAt: new Date(Date.now() + 30000).toISOString(),
    maximumFeeLamports: '5000',
    inputRaw: '1',
    minimumOutputRaw: '1',
    inputMint: destination,
    outputMint: destination,
    lastValidBlockHeight: '999999999',
    settlement: {
      accountKeysSha256: await warmupAccountKeysHash([
        wallet,
        destination,
        '11111111111111111111111111111111',
      ]),
      version: 1,
      wrappedFromNativeRaw: '0',
      maximumRentLamports: '0',
      maximumNativeDebitLamports: '5000',
      preexistingWrappedRefundRaw: '0',
      closesWrappedAccount: false,
      accounts: [],
      lookupTables: [],
    },
  };
  // Stored approval fixture tests lifecycle and exact-packet registration; it does not claim this transfer is a swap eligible for review.
  await mocks.db
    .prepare(
      "INSERT INTO warmup_signing_intents(id,owner_id,preparation_id,wallet_address,document,state,signature,created_at,updated_at) VALUES (?,?,?,?,?,'awaiting_signature',NULL,?,?)",
    )
    .bind(
      review.id,
      'one',
      review.preparationId,
      wallet,
      JSON.stringify(review),
      new Date().toISOString(),
      new Date().toISOString(),
    )
    .run();
  const session = {
    payload: {
      wallets: [{ family: 'solana', address: wallet, seed: '07'.repeat(32) }],
    },
  } as VaultSession;
  const signed = await signApprovedWarmupPacket(session, review, () => {});
  const request = (action: string, packet = signed.transaction, headers = {}) =>
    signingAction(
      new Request('http://localhost/api/wallet-workspace/warmup/signing', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify({ action, id: review.id, transaction: packet }),
      }),
    );
  const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}');
    return Response.json({
      jsonrpc: '2.0',
      id: 1,
      result:
        body.method === 'getGenesisHash'
          ? SOLANA_MAINNET_GENESIS
          : {
              version: '0',
              slot: '100',
              blockTime: null,
              meta: {
                err: { InstructionError: [0, { Custom: 42 }] },
                fee: '5000',
                preBalances: ['10000000', '0', '1'],
                postBalances: ['9995000', '0', '1'],
                loadedAddresses: { writable: [], readonly: [] },
              },
              transaction: [signed.transaction, 'base64'],
            },
    });
  });
  vi.stubGlobal('fetch', fetcher);
  try {
    expect((await request('submit')).status).toBe(409);
    expect(fetcher).not.toHaveBeenCalled();
    expect((await request('register', review.transaction)).status).toBe(400);
    expect(
      (
        await request('register', signed.transaction, {
          origin: 'http://other',
        })
      ).status,
    ).toBe(403);
    expect(await (await request('register')).json()).toMatchObject({
      signature: signed.signature,
      state: 'signed',
    });
    expect((await request('register')).status).toBe(200);
    expect(fetcher).not.toHaveBeenCalled();
    expect((await request('cancel')).status).toBe(409);
    await saveSolWarmup();
    const planRow = await mocks.db
      .prepare(
        "SELECT document FROM wallet_warmup_plans WHERE owner_id='one' AND id='qa'",
      )
      .first<{ document: string }>();
    const planDoc = JSON.parse(planRow!.document);
    planDoc.addresses = [wallet];
    planDoc.walletRevisions = [{ address: wallet, revision: 1 }];
    await mocks.db
      .prepare(
        "UPDATE wallet_warmup_plans SET document=? WHERE owner_id='one' AND id='qa'",
      )
      .bind(JSON.stringify(planDoc))
      .run();
    await mocks.db
      .prepare(
        "UPDATE workspace_wallets SET address=? WHERE owner_id='one' AND chain='Solana'",
      )
      .bind(wallet)
      .run();
    const doc = {
      ...preparationHistoryFixture(),
      side: 'Buy' as const,
      inputMint: review.inputMint,
      outputMint: review.outputMint,
      inAmountRaw: review.inputRaw,
      minimumOutRaw: review.minimumOutputRaw,
      wallet,
      expiresAt: review.expiresAt,
      transaction: {
        ...preparationHistoryFixture().transaction,
        sha256: review.sha256,
        bytes: bytes.length,
        lastValidBlockHeight: review.lastValidBlockHeight,
      },
      inventory: null,
    };
    await mocks.db
      .prepare(
        'INSERT INTO warmup_swap_preparations VALUES (?,?,?,?,?,?,?,?,?)',
      )
      .bind(
        review.preparationId,
        'one',
        'qa',
        1,
        3,
        wallet,
        1,
        JSON.stringify(doc),
        new Date().toISOString(),
      )
      .run();
    vi.spyOn(simulations, 'simulateImportedSwap').mockResolvedValue({
      ...preparedFixture().simulation,
      wallet,
      sha256: review.sha256,
    });
    // Eligibility itself is exercised in warmup-signing.test.ts. This lifecycle fixture isolates the durable-before-send behavior.
    vi.spyOn(
      warmupSigningHelpers,
      'requireWarmupSigningReview',
    ).mockResolvedValue(review.settlement!);
    fetcher.mockImplementation(async (_url, init) => {
      const body = JSON.parse(
        typeof init?.body === 'string' ? init.body : '{}',
      );
      if (body.method === 'sendTransaction') throw new Error('mock timeout');
      return Response.json({
        jsonrpc: '2.0',
        id: 1,
        result: SOLANA_MAINNET_GENESIS,
      });
    });
    expect((await request('submit')).status).toBe(502);
    expect(
      await mocks.db
        .prepare('SELECT state FROM warmup_signing_intents WHERE id=?')
        .bind(review.id)
        .first(),
    ).toEqual({ state: 'submitted' });
    expect((await request('submit')).status).toBe(409);
    expect(
      fetcher.mock.calls.map(
        (call) =>
          JSON.parse(typeof call[1]?.body === 'string' ? call[1].body : '{}')
            .method,
      ),
    ).toEqual(['getGenesisHash', 'sendTransaction']);
    fetcher.mockClear();
    fetcher.mockImplementation(async (_url, init) => {
      const body = JSON.parse(
        typeof init?.body === 'string' ? init.body : '{}',
      );
      return Response.json({
        jsonrpc: '2.0',
        id: 1,
        result:
          body.method === 'getGenesisHash'
            ? SOLANA_MAINNET_GENESIS
            : {
                version: '0',
                slot: '100',
                blockTime: null,
                meta: {
                  err: { InstructionError: [0, { Custom: 42 }] },
                  fee: '5000',
                  preBalances: ['10000000', '0', '1'],
                  postBalances: ['9995000', '0', '1'],
                  loadedAddresses: { writable: [], readonly: [] },
                },
                transaction: [signed.transaction, 'base64'],
              },
      });
    });

    mocks.user = { userId: 'two' };
    expect((await request('recover')).status).toBe(404);
    expect(
      await (
        await signingStatus(
          new Request(
            `http://localhost/api/wallet-workspace/warmup/signing?preparationId=${review.preparationId}`,
          ),
        )
      ).json(),
    ).toEqual({ intent: null });
    mocks.user = { userId: 'one' };
    expect(await (await request('recover')).json()).toMatchObject({
      state: 'failed',
      signature: signed.signature,
    });
    expect(
      fetcher.mock.calls.map(
        (call) =>
          JSON.parse(typeof call[1]?.body === 'string' ? call[1].body : '{}')
            .method,
      ),
    ).toEqual(['getGenesisHash', 'getTransaction']);
    expect(
      await mocks.db
        .prepare('SELECT state FROM warmup_signing_intents WHERE id=?')
        .bind(review.id)
        .first(),
    ).toEqual({ state: 'failed' });
    expect(
      await mocks.db
        .prepare(
          "SELECT type,state,signature FROM warmup_signing_events WHERE intent_id=? AND type='approval.failed'",
        )
        .bind(review.id)
        .first(),
    ).toEqual({
      type: 'approval.failed',
      state: 'failed',
      signature: signed.signature,
    });
  } finally {
    vi.unstubAllGlobals();
  }
});

it('finishes a registered buy receipt after plan archival and releases its pending wallet approval', async () => {
  await saveSolWarmup();
  const buy = await storedBuy();
  vi.spyOn(buyReceiptReader, 'observeWarmupBuyReceipt').mockResolvedValue(
    receiptDocument(),
  );
  const id = crypto.randomUUID(),
    now = new Date().toISOString();
  await mocks.db
    .prepare(
      "INSERT INTO warmup_signing_intents(id,owner_id,preparation_id,wallet_address,document,state,signature,created_at,updated_at) VALUES (?,?,?,?,?,'submitted',?,?,?)",
    )
    .bind(id, 'one', buy.id, solWallet, '{}', buySignature, now, now)
    .run();
  await mocks.db.exec(
    "UPDATE wallet_warmup_plans SET archived=1,revision=2 WHERE id='qa'",
  );
  expect((await verifyReceipt(buy.id)).status).toBe(200);
  expect(
    await mocks.db
      .prepare('SELECT state FROM warmup_signing_intents WHERE id=?')
      .bind(id)
      .first(),
  ).toEqual({ state: 'finalized' });
});

it.each(['vault', 'external', 'vault restored', 'external restored'] as const)(
  'completes automatic native SOL buy, user approval, one submission, finalized lot, linked sell and unwrapped receipt without live RPC using %s signing',
  async (signingMethod) => {
    const buy = await nativeWarmupFixture({
      seed: true,
      lookup: true,
      v2: true,
      fee: 2,
    });
    await mocks.db.exec(
      'DELETE FROM workspace_wallets; CREATE TABLE IF NOT EXISTS wallet_balance_gates(owner_id TEXT PRIMARY KEY,next_allowed_at INTEGER); DELETE FROM wallet_balance_gates',
    );
    await mocks.db
      .prepare('INSERT INTO workspace_wallets VALUES (?,?,?,?,?)')
      .bind('one', 'Solana', buy.wallet, 1, 0)
      .run();
    expect(
      (
        await request({
          id: 'qa',
          expectedRevision: 0,
          action: 'save',
          document: {
            ...document(),
            chain: 'Solana',
            addresses: [buy.wallet],
            walletRevisions: [{ address: buy.wallet, revision: 1 }],
            tokens: [buy.mint],
            cycles: 1,
          },
        })
      ).status,
    ).toBe(200);
    testEnv.JUPITER_API_KEY = 'fixture-only';
    let current = buy;
    let planRevision = 1;
    const historical = signingMethod.endsWith(' restored');
    let sends = 0;
    let changedLookup = false,
      changedReceipt = false;
    const fetcher = vi.fn(async (url: unknown, init?: RequestInit) => {
      if (String(url).startsWith('https://api.jup.ag/swap/v2/order')) {
        const query = new URL(String(url)).searchParams;
        expect(query.get('excludeRouters')).toBe('jupiterz,dflow,okx');
        expect(query.get('amount')).toBe(current.order.inAmount);
        return Response.json({
          ...current.order,
          platformFee: current.order.platformFee
            ? {
                feeBps: current.order.platformFee.bps,
                feeMint: current.order.platformFee.mint,
              }
            : undefined,
          swapMode: 'ExactIn',
          otherAmountThreshold: current.order.minimumOutAmount,
          transaction: current.order.preparation.transaction,
          taker: current.wallet,
          transactionVersion: 0,
          gasless: false,
          lastValidBlockHeight: '999999999',
          signatureFeeLamports: 5000,
          signatureFeePayer: current.wallet,
          prioritizationFeeLamports: 0,
          rentFeeLamports: 0,
        });
      }
      const body = JSON.parse(
        typeof init?.body === 'string' ? init.body : '{}',
      );
      if (body.method === 'sendTransaction') {
        const pending = await mocks.db
          .prepare('SELECT state FROM warmup_signing_intents WHERE signature=?')
          .bind(current.signed.signature)
          .first<{ state: string }>();
        expect(pending?.state).toBe('submitted');
        expect(
          await mocks.db
            .prepare(
              "SELECT type,state FROM warmup_signing_events WHERE signature=? AND type='approval.submission_started'",
            )
            .bind(current.signed.signature)
            .first(),
        ).toEqual({ type: 'approval.submission_started', state: 'submitted' });
        expect(body.params[0]).toBe(current.signed.transaction);
        expect(body.params[1]).toMatchObject({
          skipPreflight: false,
          maxRetries: 0,
        });
        sends++;
        return Response.json({
          jsonrpc: '2.0',
          id: 1,
          result: current.signed.signature,
        });
      }
      if (body.method === 'getTransaction') {
        const receipt = structuredClone(current.receipt);
        if (changedReceipt)
          receipt.meta.loadedAddresses.writable[0] = bs58.encode(
            new Uint8Array(32).fill(11),
          );
        return Response.json({ jsonrpc: '2.0', id: 1, result: receipt });
      }
      const response = await current.fetcher(url, init);
      if (
        changedLookup &&
        body.method === 'getMultipleAccounts' &&
        body.params[0].length === 1
      ) {
        const data = (await response.json()) as {
          result: { value: { data: string[] }[] };
        };
        const bytes = Uint8Array.from(atob(data.result.value[0].data[0]), (c) =>
          c.charCodeAt(0),
        );
        bytes[12] ^= 1;
        data.result.value[0].data[0] = btoa(String.fromCharCode(...bytes));
        return Response.json(data);
      }
      return response;
    });
    vi.stubGlobal('fetch', fetcher);
    const api = (action: string, body: Record<string, unknown>) =>
      signingAction(
        new Request('http://localhost/api/wallet-workspace/warmup/signing', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action, ...body }),
        }),
      );
    const prepare = async (side: 'Buy' | 'Sell', lot?: string) => {
      await mocks.db.exec('DELETE FROM wallet_balance_gates');
      const response = await prepareBuy(
        new Request('http://localhost/api/wallet-workspace/warmup/prepare', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            id: 'qa',
            revision: planRevision,
            cycle: 1,
            wallet: current.wallet,
            side,
            ...(lot
              ? {
                  amount: '0.001',
                  buyReceiptId: lot,
                  ...(historical ? { useHistoricalBuy: true } : {}),
                }
              : {}),
          }),
        }),
      );
      const data = (await response.json()) as {
        error?: string;
        history: SavedWarmupPreparation;
      };
      expect(response.status, JSON.stringify(data)).toBe(200);
      return data.history;
    };
    const approve = async (prep: SavedWarmupPreparation) => {
      if (current.order.side === 'Buy') {
        const waiting = await api('review', {
          preparationId: prep.id,
          transaction: current.order.preparation.transaction,
        });
        expect(waiting.status).toBe(429);
        const gate = (await waiting.json()) as { reviewWaitMs: number };
        expect(gate.reviewWaitMs).toBeGreaterThan(0);
        expect(gate.reviewWaitMs).toBeLessThanOrEqual(15000);
      }
      await mocks.db.exec('DELETE FROM wallet_balance_gates');
      if (current.order.side === 'Buy') {
        const expiredSimulation = vi
          .spyOn(simulations, 'simulateImportedSwap')
          .mockRejectedValueOnce(new simulations.SwapBlockhashExpiredError());
        const stale = await api('review', {
          preparationId: prep.id,
          transaction: current.order.preparation.transaction,
        });
        expect(stale.status).toBe(409);
        expect(await stale.text()).toContain('Prepare a fresh order');
        expect(
          await mocks.db
            .prepare(
              'SELECT COUNT(*) AS n FROM warmup_signing_intents WHERE preparation_id=?',
            )
            .bind(prep.id)
            .first(),
        ).toEqual({ n: 0 });
        expiredSimulation.mockRestore();
        await mocks.db.exec('DELETE FROM wallet_balance_gates');
      }
      const response = await api('review', {
        preparationId: prep.id,
        transaction: current.order.preparation.transaction,
      });
      const data = (await response.json()) as {
        error?: string;
        review: WarmupSigningReview;
      };
      expect(response.status, JSON.stringify(data)).toBe(200);
      expect(data.review.settlement?.wrappedFromNativeRaw).toBe(
        current.order.side === 'Buy' ? '1000000' : '0',
      );
      const session = {
        payload: {
          wallets: [
            {
              family: 'solana',
              address: current.wallet,
              seed: '07'.repeat(32),
            },
          ],
        },
      } as VaultSession;
      let packet = signingMethod.startsWith('vault')
        ? await signApprovedWarmupPacket(session, data.review, () => {})
        : await signApprovedExternalWarmupPacket(
            {
              version: '1.0.0',
              name: 'Fixture external wallet',
              icon: 'data:image/png;base64,',
              chains: ['solana:mainnet'],
              accounts: [
                {
                  address: current.wallet,
                  publicKey: bs58.decode(current.wallet),
                  chains: ['solana:mainnet'],
                  features: ['solana:signTransaction'],
                },
              ],
              features: {
                'standard:connect': {
                  version: '1.0.0',
                  connect: async () => ({}),
                },
                'standard:events': { version: '1.0.0', on: () => () => {} },
                'solana:signTransaction': {
                  version: '1.0.0',
                  supportedTransactionVersions: [0],
                  signTransaction: async (input: {
                    chain: string;
                    transaction: Uint8Array;
                  }) => {
                    expect(input.chain).toBe('solana:mainnet');
                    expect(
                      btoa(String.fromCharCode(...input.transaction)),
                    ).toBe(current.order.preparation.transaction);
                    expect(sends).toBe(current.order.side === 'Buy' ? 0 : 1);
                    return [
                      {
                        signedTransaction: Uint8Array.from(
                          atob(current.signed.transaction),
                          (c) => c.charCodeAt(0),
                        ),
                      },
                    ];
                  },
                },
              },
            },
            data.review,
            () => {},
          );
      expect(packet).toEqual(current.signed);
      expect(
        (
          await api('register', {
            id: data.review.id,
            transaction: packet.transaction,
          })
        ).status,
      ).toBe(200);
      const recoveredPage = await signingStatus(
        new Request(
          'http://localhost/api/wallet-workspace/warmup/signing?planId=qa',
        ),
      );
      expect(recoveredPage.status).toBe(200);
      const recovered = (
        (await recoveredPage.json()) as {
          intents: Array<{
            id: string;
            state: string;
            signature: string;
            document: WarmupSigningReview;
          }>;
        }
      ).intents.find((row) => row.id === data.review.id)!;
      expect(recovered.state).toBe('signed');
      packet = await restoreRegisteredWarmupPacket(
        recovered.document,
        recovered.signature,
      );
      expect(packet).toEqual(current.signed);
      if (current.order.side === 'Buy') {
        const expiredSimulation = vi
          .spyOn(simulations, 'simulateImportedSwap')
          .mockRejectedValueOnce(new simulations.SwapBlockhashExpiredError());
        const stale = await api('submit', {
          id: data.review.id,
          transaction: packet.transaction,
        });
        expect(stale.status).toBe(409);
        expect(await stale.text()).toContain('Keep the registered signature');
        expect(sends).toBe(0);
        expect(
          await mocks.db
            .prepare(
              'SELECT state,signature FROM warmup_signing_intents WHERE id=?',
            )
            .bind(data.review.id)
            .first(),
        ).toEqual({ state: 'signed', signature: packet.signature });
        expiredSimulation.mockRestore();
        changedLookup = true;
        const refused = await api('submit', {
          id: data.review.id,
          transaction: packet.transaction,
        });
        expect(refused.status).toBe(409);
        expect(await refused.text()).toContain('lookup tables changed');
        expect(sends).toBe(0);
        changedLookup = false;
        await mocks.db
          .prepare(
            "CREATE TRIGGER test_reject_execution_event BEFORE INSERT ON warmup_signing_events WHEN NEW.type='approval.submission_started' BEGIN SELECT RAISE(ABORT,'test event storage unavailable'); END;",
          )
          .run();
        try {
          expect(
            (
              await api('submit', {
                id: data.review.id,
                transaction: packet.transaction,
              })
            ).status,
          ).toBe(502);
          expect(sends).toBe(0);
          expect(
            await mocks.db
              .prepare('SELECT state FROM warmup_signing_intents WHERE id=?')
              .bind(data.review.id)
              .first(),
          ).toEqual({ state: 'signed' });
          expect(
            await mocks.db
              .prepare(
                "SELECT COUNT(*) AS n FROM warmup_signing_events WHERE intent_id=? AND type='approval.submission_started'",
              )
              .bind(data.review.id)
              .first(),
          ).toEqual({ n: 0 });
        } finally {
          await mocks.db
            .prepare('DROP TRIGGER test_reject_execution_event')
            .run();
        }
      }
      expect(
        (
          await api('submit', {
            id: data.review.id,
            transaction: packet.transaction,
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await api('submit', {
            id: data.review.id,
            transaction: packet.transaction,
          })
        ).status,
      ).toBe(409);
      return data.review;
    };
    try {
      const buyPrep = await prepare('Buy');
      const capturedPlan = await mocks.db
        .prepare(
          "SELECT document FROM wallet_warmup_plans WHERE owner_id='one' AND id='qa'",
        )
        .first<{ document: string }>();
      await mocks.db
        .prepare(
          "UPDATE wallet_warmup_plans SET document=json_set(document,'$.feeReserve','0.000001') WHERE owner_id='one' AND id='qa'",
        )
        .run();
      await mocks.db.exec('DELETE FROM wallet_balance_gates');
      const budgetRefusal = await api('review', {
        preparationId: buyPrep.id,
        transaction: buy.order.preparation.transaction,
      });
      expect(budgetRefusal.status).toBe(409);
      expect(await budgetRefusal.text()).toContain('saved fee reserve');
      expect(sends).toBe(0);
      await mocks.db
        .prepare(
          "UPDATE wallet_warmup_plans SET document=? WHERE owner_id='one' AND id='qa'",
        )
        .bind(capturedPlan!.document)
        .run();
      const buyReview = await approve(buyPrep);
      await mocks.db.exec('DELETE FROM wallet_balance_gates');
      changedReceipt = true;
      expect(
        (
          await verifyBuyReceipt(
            new Request(
              'http://localhost/api/wallet-workspace/warmup/buy-receipts',
              {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                  preparationId: buyPrep.id,
                  signature: buy.signed.signature,
                }),
              },
            ),
          )
        ).status,
      ).toBe(502);
      expect(
        await mocks.db
          .prepare('SELECT state FROM warmup_signing_intents WHERE id=?')
          .bind(buyReview.id)
          .first(),
      ).toEqual({ state: 'submitted' });
      changedReceipt = false;
      await mocks.db.exec('DELETE FROM wallet_balance_gates');
      const recorded = await verifyBuyReceipt(
        new Request(
          'http://localhost/api/wallet-workspace/warmup/buy-receipts',
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              preparationId: buyPrep.id,
              signature: buy.signed.signature,
            }),
          },
        ),
      );
      const buyResult = (await recorded.json()) as {
        receipt: buyReceiptReader.SavedWarmupBuyReceipt;
      };
      expect(recorded.status, JSON.stringify(buyResult)).toBe(200);
      expect(buyResult.receipt.document.acquiredRaw).toBe('1000');
      expect(
        await mocks.db
          .prepare('SELECT state FROM warmup_signing_intents WHERE id=?')
          .bind(buyReview.id)
          .first(),
      ).toEqual({ state: 'finalized' });
      if (historical) {
        expect(
          (await request({ id: 'qa', expectedRevision: 1, action: 'archive' }))
            .status,
        ).toBe(200);
        expect(
          (await request({ id: 'qa', expectedRevision: 2, action: 'restore' }))
            .status,
        ).toBe(200);
        planRevision = 3;
        const refused = await prepareBuy(
          new Request('http://localhost/api/wallet-workspace/warmup/prepare', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              id: 'qa',
              revision: 3,
              cycle: 1,
              wallet: buy.wallet,
              side: 'Sell',
              amount: '0.001',
              buyReceiptId: buyResult.receipt.id,
            }),
          }),
        );
        expect(refused.status).toBe(409);
        expect(await refused.text()).toContain('does not match');
      }
      current = await nativeWarmupFixture({
        side: 'Sell',
        seed: true,
        lookup: true,
        v2: true,
        fee: 2,
        slot: 400,
      });
      vi.spyOn(sellInventory, 'inspectWarmupSellInventory').mockResolvedValue({
        executionAllowed: false,
        wallet: current.wallet,
        mint: current.mint,
        tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
        decimals: 6,
        preparationSupported: true,
        amountCovered: true,
        requestedRaw: '1000',
        unfrozenRaw: '1000',
        minSlot: 400,
        maxSlot: 400,
        observedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60000).toISOString(),
        source: 'fixture',
        limitations: 'Controlled inventory fixture.',
      } as sellInventory.WarmupSellInventory);
      const sellPrep = await prepare('Sell', buyResult.receipt.id);
      if (historical)
        expect(sellPrep.document.buyReceipt?.historicalBuy).toEqual({
          planRevision: 1,
          walletRevision: 1,
        });
      expect(sellPrep.document.buyReceipt?.remainingRaw).toBe('1000');
      const sellReview = await approve(sellPrep);
      if (historical)
        expect(sellReview.buyReceipt?.historicalBuy).toEqual({
          planRevision: 1,
          walletRevision: 1,
        });
      await mocks.db.exec('DELETE FROM wallet_balance_gates');
      const sellRequest = () =>
        verifySellReceipt(
          new Request(
            'http://localhost/api/wallet-workspace/warmup/sell-receipts',
            {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                preparationId: sellPrep.id,
                signature: current.signed.signature,
              }),
            },
          ),
        );
      const finished = await sellRequest(),
        sellResult = (await finished.json()) as {
          receipt: { id: string; document: WarmupSellReceipt };
        };
      expect(finished.status, JSON.stringify(sellResult)).toBe(200);
      expect(sellResult.receipt.document).toMatchObject({
        consumedRaw: '1000',
        nativeSettlementRaw: '1000000',
        rentChangeRaw: '0',
      });
      expect(
        await mocks.db
          .prepare(
            'SELECT remaining_raw AS remaining FROM warmup_buy_receipts WHERE id=?',
          )
          .bind(buyResult.receipt.id)
          .first(),
      ).toEqual({ remaining: '0' });
      expect(
        await mocks.db
          .prepare('SELECT state FROM warmup_signing_intents WHERE id=?')
          .bind(sellReview.id)
          .first(),
      ).toEqual({ state: 'finalized' });
      expect((await sellRequest()).status).toBe(200);
      expect(sends).toBe(2);
      const execution = await signingActivity(
        new Request(
          'http://localhost/api/wallet-workspace/warmup/signing-activity?planId=qa',
        ),
      );
      expect(execution.status).toBe(200);
      const executionEvents = (
        (await execution.json()) as {
          events: Array<{
            intentId: string;
            type: string;
            state: string;
            document: { side: string };
          }>;
        }
      ).events;
      for (const review of [buyReview, sellReview]) {
        expect(
          executionEvents
            .filter((event) => event.intentId === review.id)
            .map((event) => event.type)
            .sort(),
        ).toEqual([
          'approval.finalized',
          'approval.reviewed',
          'approval.signed',
          'approval.submission_started',
        ]);
      }
      expect(
        executionEvents
          .filter((event) => event.type === 'approval.finalized')
          .map((event) => event.document.side)
          .sort(),
      ).toEqual(['Buy', 'Sell']);
      await mocks.db.exec('DELETE FROM wallet_balance_gates');
      const exhausted = await prepareBuy(
        new Request('http://localhost/api/wallet-workspace/warmup/prepare', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            id: 'qa',
            revision: planRevision,
            cycle: 1,
            wallet: current.wallet,
            side: 'Sell',
            amount: '0.001',
            buyReceiptId: buyResult.receipt.id,
            ...(historical ? { useHistoricalBuy: true } : {}),
          }),
        }),
      );
      expect(exhausted.status).toBe(409);
      expect(sends).toBe(2);
    } finally {
      vi.unstubAllGlobals();
    }
  },
);
