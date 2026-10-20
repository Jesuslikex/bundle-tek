import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { createClient, type Client } from '@libsql/client';
import { createTursoDatabase } from '@/db/turso';
import { warmupSessionSettlementFixture } from '@/test/warmup-session-settlement-fixture';
import { SOLANA_MAINNET_GENESIS } from './wallet-balances';
import {
  replayWarmupSessionSettlement,
  type WarmupSessionSettlementSelection,
} from './wallet-warmup-session-settlement';
import {
  WalletWarmupSessionSequence,
  WARMUP_SESSION_REVIEW_GAP_MS,
} from './wallet-warmup-session-sequence';
import { buildWarmupPlan } from './wallet-warmup';
import { warmupCycleProgress } from './warmup-cycle-progress';
import { warmupLotPerformance } from './warmup-lot-performance';
import { reviewWalletWarmupSession } from './wallet-warmup-session-review';
import type { SavedWarmup } from './wallet-warmup-storage';
vi.mock('@/lib/wallet-rpc-pacing', () => ({ paceWalletRpc: async () => {} }));
let client: Client,
  db: D1Database,
  f: Awaited<ReturnType<typeof warmupSessionSettlementFixture>>,
  methods: string[],
  queries: string[];
let hook: (() => Promise<void>) | undefined;
let fetcher: typeof fetch;
beforeEach(async () => {
  client = createClient({ url: 'file::memory:', intMode: 'number' });
  db = createTursoDatabase(client);
  f = await warmupSessionSettlementFixture();
  for (const sql of [
    'CREATE TABLE wallet_warmup_plans(id TEXT,owner_id TEXT,revision INTEGER,archived INTEGER)',
    'CREATE TABLE warmup_swap_preparations(id TEXT,owner_id TEXT,plan_id TEXT,plan_revision INTEGER,cycle INTEGER,wallet_revision INTEGER,created_at TEXT,document TEXT)',
    'CREATE TABLE warmup_signing_intents(id TEXT,owner_id TEXT,preparation_id TEXT,wallet_address TEXT,signature TEXT,state TEXT,document TEXT)',
    'CREATE TABLE warmup_buy_receipts(id TEXT,owner_id TEXT,preparation_id TEXT,plan_id TEXT,plan_revision INTEGER,wallet_revision INTEGER,cycle INTEGER,signature TEXT,document TEXT,wallet_address TEXT,remaining_raw TEXT)',
    'CREATE TABLE warmup_sell_receipts(id TEXT,owner_id TEXT,preparation_id TEXT,plan_id TEXT,buy_receipt_id TEXT,consumed_raw TEXT,signature TEXT,document TEXT)',
  ])
    await db.prepare(sql).run();
  await db
    .prepare('INSERT INTO wallet_warmup_plans VALUES(?,?,?,?)')
    .bind('synthetic-settlement', 'owner', 1, 0)
    .run();
  for (const part of [f.buy, f.sell]) {
    const p = part.preparation;
    await db
      .prepare('INSERT INTO warmup_swap_preparations VALUES(?,?,?,?,?,?,?,?)')
      .bind(
        p.id,
        'owner',
        p.planId,
        p.planRevision,
        p.cycle,
        p.walletRevision,
        p.createdAt,
        JSON.stringify(p.document),
      )
      .run();
    await db
      .prepare('INSERT INTO warmup_signing_intents VALUES(?,?,?,?,?,?,?)')
      .bind(
        part.approval.id,
        'owner',
        p.id,
        f.wallet,
        part.signature,
        'finalized',
        JSON.stringify(part.approval),
      )
      .run();
  }
  await db
    .prepare('INSERT INTO warmup_buy_receipts VALUES(?,?,?,?,?,?,?,?,?,?,?)')
    .bind(
      f.buy.receiptId,
      'owner',
      f.buy.preparation.id,
      'synthetic-settlement',
      1,
      1,
      1,
      f.buy.signature,
      JSON.stringify(f.buyDocument),
      f.wallet,
      '0',
    )
    .run();
  await db
    .prepare('INSERT INTO warmup_sell_receipts VALUES(?,?,?,?,?,?,?,?)')
    .bind(
      f.sell.receiptId,
      'owner',
      f.sell.preparation.id,
      'synthetic-settlement',
      f.buy.receiptId,
      '101',
      f.sell.signature,
      JSON.stringify(f.sellDocument),
    )
    .run();
  methods = [];
  queries = [];
  hook = undefined;
  const prepare = db.prepare.bind(db);
  vi.spyOn(db, 'prepare').mockImplementation((sql) => {
    queries.push(sql);
    return prepare(sql);
  });
  fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(init!.body as string);
    methods.push(body.method);
    let result: unknown;
    if (body.method === 'getGenesisHash') result = SOLANA_MAINNET_GENESIS;
    else if (body.method === 'getTransaction') {
      expect(body.params[1]).toMatchObject({
        encoding: 'base64',
        commitment: 'finalized',
        maxSupportedTransactionVersion: 0,
      });
      result =
        body.params[0] === f.buy.signature
          ? structuredClone(f.buy.raw)
          : structuredClone(f.sell.raw);
      await hook?.();
    } else throw Error('Unexpected provider method');
    return Response.json({ jsonrpc: '2.0', id: body.id, result });
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  client.close();
});
function input(side: 'Buy' | 'Sell' = 'Buy'): WarmupSessionSettlementSelection {
  const base = {
    id: `${side}:1:${f.wallet}`,
    wallet: f.wallet,
    walletRevision: 1,
    mint: f.mint,
    cycle: 1,
    scheduledAt: new Date().toISOString(),
  };
  return {
    planId: 'synthetic-settlement',
    planRevision: 1,
    receiptId: side === 'Buy' ? f.buy.receiptId : f.sell.receiptId,
    candidate: {
      action:
        side === 'Buy'
          ? { ...base, side, inputLamports: '1000000' }
          : {
              ...base,
              side,
              source: { kind: 'session-buy', actionId: `Buy:1:${f.wallet}` },
            },
      sellSource:
        side === 'Buy'
          ? null
          : { buyReceiptId: f.buy.receiptId, remainingRaw: '101', decimals: 6 },
      executionAllowed: false,
      signingAllowed: false,
    },
  };
}
const signal = () => new AbortController().signal;
it('reobserves and cryptographically decodes an owned finalized buy through SELECT-only storage reads', async () => {
  const result = await replayWarmupSessionSettlement(
    db,
    'owner',
    input(),
    signal(),
    fetcher,
  );
  expect(result).toMatchObject({
    settlement: {
      side: 'Buy',
      verified: true,
      inputLamports: '1000000',
      acquiredRaw: '101',
      networkFeeLamports: '5000',
      rentChangeLamports: '0',
    },
    executionAllowed: false,
    signingAllowed: false,
    automaticExecutionAllowed: false,
  });
  expect(result.sourceSha256).toMatch(/^[a-f0-9]{64}$/);
  expect(methods).toEqual(['getGenesisHash', 'getTransaction']);
  expect(queries).toHaveLength(2);
  expect(queries.every((q) => q.startsWith('SELECT'))).toBe(true);
});
it('replays both the exact linked buy and finalized sell before returning a sell settlement', async () => {
  const result = await replayWarmupSessionSettlement(
    db,
    'owner',
    input('Sell'),
    signal(),
    fetcher,
  );
  expect(result.settlement).toMatchObject({
    side: 'Sell',
    buyReceiptId: f.buy.receiptId,
    consumedRaw: '101',
  });
  expect(methods).toEqual([
    'getGenesisHash',
    'getTransaction',
    'getGenesisHash',
    'getTransaction',
  ]);
  expect(queries).toHaveLength(4);
  expect(queries.every((q) => q.startsWith('SELECT'))).toBe(true);
});
it('preserves finalized recovery after archival or a newer current plan revision without granting execution', async () => {
  await db
    .prepare('UPDATE wallet_warmup_plans SET archived=1,revision=9')
    .run();
  queries = [];
  expect(
    (
      await replayWarmupSessionSettlement(
        db,
        'owner',
        input(),
        signal(),
        fetcher,
      )
    ).signingAllowed,
  ).toBe(false);
});
it.each([
  'owner',
  'receipt-owner',
  'preparation-owner',
  'intent-owner',
  'missing-intent',
  'unfinalized-intent',
] as const)('refuses %s without a provider read', async (kind) => {
  if (kind === 'receipt-owner')
    await db.prepare("UPDATE warmup_buy_receipts SET owner_id='other'").run();
  if (kind === 'preparation-owner')
    await db
      .prepare("UPDATE warmup_swap_preparations SET owner_id='other'")
      .run();
  if (kind === 'intent-owner')
    await db
      .prepare("UPDATE warmup_signing_intents SET owner_id='other'")
      .run();
  if (kind === 'missing-intent')
    await db.prepare('DELETE FROM warmup_signing_intents').run();
  if (kind === 'unfinalized-intent')
    await db
      .prepare("UPDATE warmup_signing_intents SET state='submitted'")
      .run();
  await expect(
    replayWarmupSessionSettlement(
      db,
      kind === 'owner' ? 'other' : 'owner',
      input(),
      signal(),
      fetcher,
    ),
  ).rejects.toThrow();
  expect(methods).toHaveLength(0);
});
it.each([
  'revision',
  'cycle',
  'wallet',
  'input',
  'approval',
  'packet',
  'receipt',
] as const)('refuses inconsistent %s parents or action', async (kind) => {
  const selected = input();
  if (kind === 'revision') selected.planRevision = 2;
  if (kind === 'cycle') selected.candidate.action.cycle = 2;
  if (kind === 'wallet')
    selected.candidate.action.wallet = '11111111111111111111111111111111';
  if (kind === 'input' && selected.candidate.action.side === 'Buy')
    selected.candidate.action.inputLamports = '999';
  if (kind === 'approval')
    await db
      .prepare('UPDATE warmup_signing_intents SET document=?')
      .bind(JSON.stringify({ ...f.buy.approval, inputRaw: '999' }))
      .run();
  if (kind === 'packet')
    await db
      .prepare('UPDATE warmup_signing_intents SET document=?')
      .bind(JSON.stringify({ ...f.buy.approval, transaction: 'AAAA' }))
      .run();
  if (kind === 'receipt')
    await db
      .prepare('UPDATE warmup_buy_receipts SET document=?')
      .bind(JSON.stringify({ ...f.buyDocument, acquiredRaw: '102' }))
      .run();
  await expect(
    replayWarmupSessionSettlement(db, 'owner', selected, signal(), fetcher),
  ).rejects.toThrow();
});
it('rejects wrong-chain, failed or altered signed transaction evidence from the provider', async () => {
  const ordinary = fetcher;
  for (const mode of ['network', 'failed', 'signature']) {
    const corrupt: typeof fetch = async (url, init) => {
      const response = await ordinary(url, init),
        body = (await response.json()) as {
          result:
            | string
            | { meta: { err: unknown }; transaction: [string, string] };
        };
      const method = JSON.parse(init!.body as string).method;
      if (mode === 'network' && method === 'getGenesisHash')
        body.result = 'wrong-network';
      if (
        mode === 'failed' &&
        method === 'getTransaction' &&
        typeof body.result !== 'string'
      )
        body.result.meta.err = { InstructionError: [0, 'Custom'] };
      if (
        mode === 'signature' &&
        method === 'getTransaction' &&
        typeof body.result !== 'string'
      ) {
        const raw = Uint8Array.from(atob(body.result.transaction[0]), (c) =>
          c.charCodeAt(0),
        );
        raw[1] ^= 1;
        body.result.transaction[0] = btoa(String.fromCharCode(...raw));
      }
      return Response.json(body);
    };
    await expect(
      replayWarmupSessionSettlement(db, 'owner', input(), signal(), corrupt),
    ).rejects.toThrow();
  }
});
it('rejects source changes during provider reads and never writes or retries', async () => {
  hook = async () => {
    await db
      .prepare('UPDATE warmup_signing_intents SET document=?')
      .bind(
        JSON.stringify({
          ...f.buy.approval,
          expiresAt: '2020-01-01T00:00:00.000Z',
        }),
      )
      .run();
  };
  await expect(
    replayWarmupSessionSettlement(db, 'owner', input(), signal(), fetcher),
  ).rejects.toThrow();
  expect(methods).toEqual(['getGenesisHash', 'getTransaction']);
});
it('rejects cancellation before SQL and after the provider response', async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(
    replayWarmupSessionSettlement(
      db,
      'owner',
      input(),
      controller.signal,
      fetcher,
    ),
  ).rejects.toThrow();
  expect(queries).toHaveLength(0);
  const live = new AbortController();
  hook = async () => {
    live.abort();
  };
  await expect(
    replayWarmupSessionSettlement(db, 'owner', input(), live.signal, fetcher),
  ).rejects.toThrow();
});
it('feeds real parser output into the exact unsigned sequence without accepting caller-supplied verification labels', async () => {
  const now = Date.now();
  const document = {
    chain: 'Solana',
    name: 'Synthetic composition',
    addresses: [f.wallet],
    walletRevisions: [{ address: f.wallet, revision: 1 }],
    tokens: [f.mint],
    cycles: 1,
    amount: '0.001',
    feeReserve: '0.01',
    intervalSeconds: 10,
    startAt: new Date(now).toISOString(),
  };
  const plan: SavedWarmup = {
    id: 'synthetic-settlement',
    revision: 1,
    archived: false,
    updatedAt: new Date(now).toISOString(),
    document: {
      ...document,
      totalBudget: buildWarmupPlan(document, now).totalBudget,
    },
  };
  const review = reviewWalletWarmupSession(
    plan,
    warmupCycleProgress(plan, [], [], [], false),
    warmupLotPerformance([], [], []),
    now,
  );
  const sequence = new WalletWarmupSessionSequence(
    { review, reviewExpiresAt: new Date(now + 60000).toISOString() },
    plan,
    now,
  );
  const buy = sequence.beginReview(now);
  sequence.recordSubmission(buy.action.id, now);
  const first = await replayWarmupSessionSettlement(
    db,
    'owner',
    { ...input(), candidate: buy },
    signal(),
    fetcher,
  );
  sequence.recordFinalized(first.settlement, now);
  const at = now + WARMUP_SESSION_REVIEW_GAP_MS,
    sell = sequence.beginReview(at);
  expect(sell.sellSource?.remainingRaw).toBe('101');
  sequence.recordSubmission(sell.action.id, at);
  const second = await replayWarmupSessionSettlement(
    db,
    'owner',
    { ...input('Sell'), candidate: sell },
    signal(),
    fetcher,
  );
  expect(sequence.recordFinalized(second.settlement, at)).toMatchObject({
    phase: 'complete',
    completedActions: 2,
    signingAllowed: false,
    executionAllowed: false,
  });
});
it('supports a captured saved-buy sell without relabelling it as a new session buy', async () => {
  const selected = input('Sell'),
    a = selected.candidate.action;
  if (a.side !== 'Sell') throw Error('Expected sell fixture');
  a.id += `:${f.buy.receiptId}`;
  a.source = {
    kind: 'saved-buy',
    buyReceiptId: f.buy.receiptId,
    remainingRaw: '101',
    decimals: 6,
  };
  expect(
    (
      await replayWarmupSessionSettlement(
        db,
        'owner',
        selected,
        signal(),
        fetcher,
      )
    ).settlement,
  ).toMatchObject({
    actionId: a.id,
    buyReceiptId: f.buy.receiptId,
    consumedRaw: '101',
  });
});
it('refuses a changed current remaining-unit counter during the historical replay', async () => {
  hook = async () => {
    await db.prepare("UPDATE warmup_buy_receipts SET remaining_raw='1'").run();
  };
  await expect(
    replayWarmupSessionSettlement(db, 'owner', input(), signal(), fetcher),
  ).rejects.toThrow();
});
it('stops on provider throttling without retry or partial output', async () => {
  const limited = vi.fn(async () => new Response('limited', { status: 429 }));
  await expect(
    replayWarmupSessionSettlement(db, 'owner', input(), signal(), limited),
  ).rejects.toThrow();
  expect(limited).toHaveBeenCalledTimes(1);
});
async function historicalInput() {
  const selected = input('Sell');
  selected.planRevision = 2;
  const a = selected.candidate.action;
  if (a.side !== 'Sell') throw Error('Sell fixture required');
  a.walletRevision = 2;
  a.id += `:${f.buy.receiptId}`;
  a.source = {
    kind: 'saved-buy',
    buyReceiptId: f.buy.receiptId,
    remainingRaw: '101',
    decimals: 6,
  };
  const link = f.sell.preparation.document.buyReceipt!;
  link.historicalBuy = { planRevision: 1, walletRevision: 1 };
  f.sell.approval.buyReceipt = structuredClone(link);
  await db.prepare('UPDATE wallet_warmup_plans SET revision=2').run();
  await db
    .prepare(
      'UPDATE warmup_swap_preparations SET plan_revision=2,wallet_revision=2,document=? WHERE id=?',
    )
    .bind(JSON.stringify(f.sell.preparation.document), f.sell.preparation.id)
    .run();
  await db
    .prepare(
      'UPDATE warmup_signing_intents SET document=? WHERE preparation_id=?',
    )
    .bind(JSON.stringify(f.sell.approval), f.sell.preparation.id)
    .run();
  return selected;
}
it('recovers a finalized saved-buy sell using the exact lower revisions retained in both preparation and approval', async () => {
  const selected = await historicalInput();
  const replayed = await replayWarmupSessionSettlement(
    db,
    'owner',
    selected,
    signal(),
    fetcher,
  );
  expect(replayed.settlement).toMatchObject({
    side: 'Sell',
    planRevision: 2,
    walletRevision: 2,
    buyReceiptId: f.buy.receiptId,
    consumedRaw: '101',
  });
  expect(replayed.signingAllowed).toBe(false);
  expect(methods).toHaveLength(4);
});
it.each([
  'future-plan',
  'future-wallet',
  'wrong-plan',
  'wrong-wallet',
  'missing',
  'session-buy',
] as const)(
  'refuses historical %s without broadening the current-session capture',
  async (kind) => {
    const selected = await historicalInput(),
      a = selected.candidate.action;
    if (a.side !== 'Sell') throw Error('Sell fixture required');
    const link = f.sell.preparation.document.buyReceipt!;
    if (kind === 'future-plan') link.historicalBuy!.planRevision = 3;
    if (kind === 'future-wallet') link.historicalBuy!.walletRevision = 3;
    if (kind === 'wrong-plan') link.historicalBuy!.planRevision = 2;
    if (kind === 'wrong-wallet') link.historicalBuy!.walletRevision = 2;
    if (kind === 'missing') delete link.historicalBuy;
    if (kind === 'session-buy') {
      a.id = `Sell:1:${f.wallet}`;
      a.source = { kind: 'session-buy', actionId: `Buy:1:${f.wallet}` };
    }
    f.sell.approval.buyReceipt = structuredClone(link);
    await db
      .prepare('UPDATE warmup_swap_preparations SET document=? WHERE id=?')
      .bind(JSON.stringify(f.sell.preparation.document), f.sell.preparation.id)
      .run();
    await db
      .prepare(
        'UPDATE warmup_signing_intents SET document=? WHERE preparation_id=?',
      )
      .bind(JSON.stringify(f.sell.approval), f.sell.preparation.id)
      .run();
    await expect(
      replayWarmupSessionSettlement(db, 'owner', selected, signal(), fetcher),
    ).rejects.toThrow();
    expect(methods).toHaveLength(0);
  },
);
it.each([
  'column-units',
  'column-buy',
  'source-decimals',
  'stored-sell-units',
  'link-units',
] as const)('refuses sell-specific %s drift', async (kind) => {
  const selected = input('Sell');
  if (kind === 'column-units')
    await db
      .prepare("UPDATE warmup_sell_receipts SET consumed_raw='100'")
      .run();
  if (kind === 'column-buy')
    await db
      .prepare('UPDATE warmup_sell_receipts SET buy_receipt_id=?')
      .bind('00000000-0000-4000-8000-000000000099')
      .run();
  if (kind === 'source-decimals') selected.candidate.sellSource!.decimals = 5;
  if (kind === 'stored-sell-units')
    await db
      .prepare('UPDATE warmup_sell_receipts SET document=?')
      .bind(JSON.stringify({ ...f.sellDocument, consumedRaw: '100' }))
      .run();
  if (kind === 'link-units') {
    f.sell.preparation.document.buyReceipt!.remainingRaw = '100';
    f.sell.approval.buyReceipt = structuredClone(
      f.sell.preparation.document.buyReceipt,
    );
    await db
      .prepare('UPDATE warmup_swap_preparations SET document=? WHERE id=?')
      .bind(JSON.stringify(f.sell.preparation.document), f.sell.preparation.id)
      .run();
    await db
      .prepare(
        'UPDATE warmup_signing_intents SET document=? WHERE preparation_id=?',
      )
      .bind(JSON.stringify(f.sell.approval), f.sell.preparation.id)
      .run();
  }
  await expect(
    replayWarmupSessionSettlement(db, 'owner', selected, signal(), fetcher),
  ).rejects.toThrow();
});
it('refuses a buy-lot link that differs from the retained exact signing approval before any provider work', async () => {
  f.sell.approval.buyReceipt!.receiptId =
    '00000000-0000-4000-8000-000000000099';
  await db
    .prepare(
      'UPDATE warmup_signing_intents SET document=? WHERE preparation_id=?',
    )
    .bind(JSON.stringify(f.sell.approval), f.sell.preparation.id)
    .run();
  await expect(
    replayWarmupSessionSettlement(
      db,
      'owner',
      input('Sell'),
      signal(),
      fetcher,
    ),
  ).rejects.toThrow();
  expect(methods).toHaveLength(0);
});
