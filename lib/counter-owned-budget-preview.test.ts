import { it, expect, vi, afterEach } from 'vitest';
import {
  getCompiledTransactionMessageEncoder,
  getBase64Decoder,
} from '@solana/kit';
import { nativeWarmupFixture } from '../test/warmup-native-fixture';
import { reviewUnsignedSwapEnvelope } from './unsigned-swap-order';
import type { CounterBuyPreparation } from './counter-buy-preparation';
import { assessJupiterExactOutRoute } from './jupiter-exact-out-assessment';
import {
  simulateCounterBuyPreparation,
  type CounterSimulationRpc,
} from './counter-buy-simulation';
import { reviewCounterBuySettlement } from './counter-buy-settlement';
import { SOLANA_MAINNET_GENESIS } from './wallet-balances';
async function syntheticPacketFixture() {
  const f = await nativeWarmupFixture({ side: 'Buy' }),
    message = structuredClone(f.message);
  const route = message.instructions.find(
    (i) =>
      String(message.staticAccounts[i.programAddressIndex]) ===
      'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
  )!;
  const data = Uint8Array.from(route.data!),
    view = new DataView(data.buffer);
  data.set([176, 209, 105, 168, 154, 125, 69, 62]);
  view.setBigUint64(data.length - 19, 1000n, true);
  view.setBigUint64(data.length - 11, 1000000n, true);
  route.data = data;
  const packet = getBase64Decoder().decode(
    Uint8Array.from([
      1,
      ...new Uint8Array(64),
      ...getCompiledTransactionMessageEncoder().encode(message),
    ]),
  );
  const envelope = await reviewUnsignedSwapEnvelope(packet, f.wallet),
    now = new Date().toISOString(),
    expiresAt = new Date(Date.now() + 30000).toISOString();
  const projectId = '00000000-0000-4000-8000-000000000001',
    planId = '00000000-0000-4000-8000-000000000002';
  const assessment = assessJupiterExactOutRoute(envelope.instructionReview, {
    swapMode: 'ExactOut',
    wallet: f.wallet,
    inputMint: f.order.inputMint,
    outputMint: f.mint,
    quotedInputRaw: '1000000',
    outputTargetRaw: '1000',
    maximumInputRaw: '1005000',
    reviewedInputBudgetRaw: '1005000',
    slippageBps: 50,
  });
  const order: CounterBuyPreparation = {
    format: 'counter-buy-preparation-v1',
    executionAllowed: false,
    instructionsVerified: false,
    tokenDecimals: 6,
    quote: {
      format: 'counter-buy-target-quote-v1',
      executionAllowed: false,
      projectId,
      projectRevision: 1,
      planId,
      planRevision: 2,
      decisionIdentity: 'test-signal',
      inputMint: f.order.inputMint,
      outputMint: f.mint,
      outputTargetRaw: '1000',
      requiredSolInputRaw: '1000000',
      maximumSolInputRaw: '1005000',
      reviewedSolBudgetRaw: '1005000',
      swapMode: 'ExactOut',
      slippageBps: 50,
      contextSlot: 100,
      routes: [],
      source: 'api.jup.ag',
      observedAt: now,
      expiresAt,
      limitations: 'Synthetic quote.',
    },
    review: {
      format: 'counter-buy-instruction-review-v1',
      executionAllowed: false,
      projectId,
      projectRevision: 1,
      planId,
      planRevision: 2,
      decisionIdentity: 'test-signal',
      wallet: f.wallet,
      expiresAt,
      assessment,
      limitations: 'Synthetic review.',
    },
    preparation: {
      ...envelope,
      lastValidBlockHeight: '123456',
      estimatedFeesLamports: null,
      lookupAccounts: null,
    },
    observedAt: now,
    expiresAt,
    limitations: 'Synthetic unsigned preparation.',
  };
  const base = (lamports = '0') => ({
    owner: '11111111111111111111111111111111',
    executable: false,
    lamports,
    data: ['', 'base64'],
  });
  const mint = (decimals: number) => {
    const b = new Uint8Array(82);
    b[44] = decimals;
    b[45] = 1;
    return {
      owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
      executable: false,
      lamports: '1461600',
      data: [btoa(String.fromCharCode(...b)), 'base64'],
    };
  };
  const keys = message.staticAccounts.map(String),
    before: unknown[] = keys.map(() => base()),
    post: unknown[] = keys.map(() => base()),
    e = f.simulation.settlementEvidence!;
  before[0] = base(e.before[0]);
  post[0] = base(e.after[0]);
  const source = keys.indexOf(f.simulation.accountBindings.accounts[0].address),
    destination = keys.indexOf(
      f.simulation.accountBindings.accounts[1].address,
    );
  before[source] = f.first[0];
  before[destination] = f.first[1];
  post[source] = f.last[0];
  post[destination] = f.last[1];
  for (const [key, decimals] of [
    [f.order.inputMint, 9],
    [f.mint, 6],
  ] as const) {
    const i = keys.indexOf(key);
    before[i] = mint(decimals);
    post[i] = mint(decimals);
  }
  const accounts = new Map(keys.map((key, i) => [key, before[i]]));
  let simulated = false;
  const rpc: CounterSimulationRpc = async (method, params) => {
    if (method === 'getGenesisHash') return SOLANA_MAINNET_GENESIS;
    if (method === 'getBlockHeight') return '1000';
    if (method === 'getFeeForMessage')
      return { context: { slot: '100' }, value: '5000' };
    if (method === 'getMinimumBalanceForRentExemption') return '2039280';
    if (method === 'getMultipleAccounts')
      return {
        context: { slot: simulated ? '101' : '100' },
        value: (params[0] as string[]).map((k) => accounts.get(k) ?? null),
      };
    if (method === 'simulateTransaction') {
      simulated = true;
      return {
        context: { slot: '101' },
        value: {
          err: null,
          accounts: post,
          unitsConsumed: '10000',
          fee: '5000',
        },
      };
    }
    throw new Error('Unexpected RPC request.');
  };
  return { order, rpc };
}

import { counterBuyFixture } from '../test/counter-buy-fixture';
import { initialCounterLedger, evaluateCounterTrade } from './counter-trade';
import { AUTO_BUY_BUDGET_AUTHORITY } from './auto-buy-budget';
import {
  counterAutoBuyCandidateIdentity,
  type CounterAutoBuyCandidateInput,
} from './auto-buy-counter-candidate';
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const abort = () => new AbortController().signal;
afterEach(() => {
  vi.useRealTimers();
  for (const db of databases.splice(0)) db.close();
});
async function candidateFixture() {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-23T12:00:00.000Z'));
  const f = await syntheticPacketFixture();
  const seed = counterBuyFixture('11111111111111111111111111111111');
  const plan = JSON.parse(
    JSON.stringify(seed.plan, (_key, value) =>
      value === seed.plan.ledger.scope.mint ? f.order.quote.outputMint : value,
    ),
  ) as typeof seed.plan;
  plan.rules.replicationPercent = '0.1';
  plan.rules.ignoredWallets = [f.order.preparation.wallet];
  plan.projectDocument = JSON.stringify({
    token: { chain: 'Solana', address: f.order.quote.outputMint, decimals: 6 },
  });
  plan.createdAt = new Date(Date.now() - 2000).toISOString();
  plan.updatedAt = new Date().toISOString();
  const source = plan.ledger.decisions[0].source!;
  plan.ledger.scope.decimals = 6;
  source.context.decimals = 6;
  source.movement.tokenChange!.decimals = 6;
  source.movement.blockTime = Math.floor(Date.now() / 1000) - 1;
  source.movement.observedAt = new Date().toISOString();
  source.context.tapeObservedAt = new Date().toISOString();
  source.movement.tapeObservedAt = source.context.tapeObservedAt;
  source.context.trade.timestamp = new Date(Date.now() - 1000).toISOString();
  const evaluated = evaluateCounterTrade(
    plan.rules,
    initialCounterLedger(plan.rules, plan.ledger.scope),
    source.movement,
    source.context,
  );
  plan.ledger = evaluated.ledger;
  expect(evaluated.decision.proposalTokenRaw).toBe('1000');
  f.order.quote.decisionIdentity = evaluated.decision.identity;
  f.order.review.decisionIdentity = evaluated.decision.identity;
  const simulation = await simulateCounterBuyPreparation(
    f.order,
    '6000000',
    abort(),
    f.rpc,
  );
  const settlement = await reviewCounterBuySettlement(
    f.order,
    simulation,
    '6000000',
  );
  const identity = await counterAutoBuyCandidateIdentity(
    plan,
    evaluated.decision.identity,
  );
  const input: CounterAutoBuyCandidateInput = {
    plan,
    prepared: f.order,
    simulation,
    settlement,
    sourceReview: {
      sourceTradeCount: 1,
      sourceRecheckedAt: new Date().toISOString(),
      sourceValidUntil: new Date(Date.now() + 299000).toISOString(),
    },
    budget: {
      terms: {
        id: id(20),
        projectId: plan.projectId,
        projectRevision: 1,
        mint: f.order.quote.outputMint,
        tokenDecimals: 6,
        maximumInputLamports: '10050000',
        maximumFeeAndRentLamports: '60000000',
        expiresAt: new Date(Date.now() + 60000).toISOString(),
        wallets: [
          {
            address: f.order.preparation.wallet,
            revision: 1,
            maximumInputLamports: '10050000',
            maximumFeeAndRentLamports: '60000000',
          },
        ],
        strategies: [
          {
            id: id(21),
            kind: 'Counter',
            sourceSha256: identity.sourceSha256,
            maximumInputLamports: '10050000',
            maximumFeeAndRentLamports: '60000000',
          },
        ],
      },
      inputMint: f.order.quote.inputMint,
      state: 'open',
      revision: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      heldInputLamports: '0',
      heldFeeAndRentLamports: '0',
      remainingInputLamports: '10050000',
      remainingFeeAndRentLamports: '60000000',
      uncertainClaims: 0,
      ...AUTO_BUY_BUDGET_AUTHORITY,
    },
    selection: {
      claimId: id(22),
      budgetId: id(20),
      budgetRevision: 0,
      strategyId: id(21),
      wallet: f.order.preparation.wallet,
      walletRevision: 1,
      now: Date.now(),
    },
  };
  expect({
    scope: plan.ledger.scope,
    project: plan.projectId,
    ignored: plan.rules.ignoredWallets,
  }).toMatchObject({
    scope: {
      projectId: plan.projectId,
      revision: 1,
      mint: input.budget.terms.mint,
      decimals: 6,
    },
    ignored: [input.selection.wallet],
  });
  return {
    input,
  };
}

import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import {
  previewOwnedCounterBuyBudget,
  counterBudgetPreviewRequest,
} from './counter-owned-preview';
const databases: DatabaseSync[] = [];
async function ownedFixture() {
  const { input: e } = await candidateFixture(),
    sqlite = new DatabaseSync(':memory:');
  databases.push(sqlite);
  // Read projections only. Full migration/trigger admission belongs to budget-store tests.
  sqlite.exec(`CREATE TABLE counter_trade_plans(owner_id TEXT,project_id TEXT,id TEXT,revision INTEGER,state TEXT,document TEXT);
    CREATE TABLE imported_token_projects(owner_id TEXT,id TEXT,chain TEXT,address TEXT,revision INTEGER,archived INTEGER,document TEXT);
    CREATE TABLE workspace_wallets(owner_id TEXT,chain TEXT,address TEXT,revision INTEGER,archived INTEGER,role TEXT,updated_at TEXT);
    CREATE TABLE wallet_ownership_proofs(owner_id TEXT,chain TEXT,address TEXT);
    CREATE TABLE auto_buy_budgets(owner_id TEXT,id TEXT,project_id TEXT,project_revision INTEGER,document TEXT,document_sha256 TEXT,maximum_input_lamports INTEGER,maximum_fee_and_rent_lamports INTEGER,state TEXT,revision INTEGER,expires_at TEXT,created_at TEXT,updated_at TEXT);
    CREATE TABLE auto_buy_budget_claims(owner_id TEXT,session_id TEXT,state TEXT,maximum_input_lamports INTEGER,maximum_fee_and_rent_lamports INTEGER);`);
  const p = e.plan,
    t = e.budget.terms;
  sqlite
    .prepare('INSERT INTO counter_trade_plans VALUES(?,?,?,?,?,?)')
    .run('alice', p.projectId, p.id, p.revision, p.state, JSON.stringify(p));
  sqlite
    .prepare('INSERT INTO imported_token_projects VALUES(?,?,?,?,?,?,?)')
    .run(
      'alice',
      p.projectId,
      'Solana',
      t.mint,
      p.ledger.scope.revision,
      0,
      p.projectDocument,
    );
  sqlite
    .prepare('INSERT INTO workspace_wallets VALUES(?,?,?,?,?,?,?)')
    .run(
      'alice',
      'Solana',
      e.selection.wallet,
      1,
      0,
      'Recipient',
      new Date().toISOString(),
    );
  sqlite
    .prepare('INSERT INTO wallet_ownership_proofs VALUES(?,?,?)')
    .run('alice', 'Solana', e.selection.wallet);
  function saveBudget() {
    const document = JSON.stringify({
      format: 'auto-buy-budget-v1',
      inputMint: e.budget.inputMint,
      terms: t,
      projectDocument: p.projectDocument,
      ...AUTO_BUY_BUDGET_AUTHORITY,
    });
    sqlite.prepare('DELETE FROM auto_buy_budgets').run();
    sqlite
      .prepare('INSERT INTO auto_buy_budgets VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(
        'alice',
        t.id,
        t.projectId,
        t.projectRevision,
        document,
        createHash('sha256').update(document).digest('hex'),
        Number(t.maximumInputLamports),
        Number(t.maximumFeeAndRentLamports),
        e.budget.state,
        e.budget.revision,
        t.expiresAt,
        e.budget.createdAt,
        e.budget.updatedAt,
      );
  }
  saveBudget();
  let budgetReads = 0;
  let afterBudgetRead: ((n: number) => void) | undefined;
  const db = {
    prepare(sql: string) {
      return {
        bind(...values: (string | number)[]) {
          return {
            async first() {
              const result = sqlite.prepare(sql).get(...values) ?? null;
              if (sql.includes('FROM auto_buy_budgets b')) {
                budgetReads++;
                afterBudgetRead?.(budgetReads);
              }
              return result;
            },
          };
        },
      };
    },
  } as unknown as D1Database;
  const movement = p.ledger.decisions[0].source!.movement;
  const dependencies = {
    observeSource: vi.fn(async () => ({
      ...structuredClone(movement),
      observedAt: new Date().toISOString(),
    })),
    prepare: vi.fn(async () => structuredClone(e.prepared)),
    simulate: vi.fn(async () => structuredClone(e.simulation)),
    settle: vi.fn(reviewCounterBuySettlement),
  };
  const request = {
    projectId: p.projectId,
    projectRevision: p.ledger.scope.revision,
    planId: p.id,
    planRevision: p.revision,
    decisionIdentity: e.prepared.quote.decisionIdentity,
    wallet: e.selection.wallet,
    walletRevision: 1,
    maximumSolInputRaw: e.prepared.quote.reviewedSolBudgetRaw,
    maximumFeeAndRentRaw: e.settlement.reviewedFeeAndRentLimitRaw,
    budgetId: t.id,
    budgetRevision: 0,
    strategyId: e.selection.strategyId,
  };
  const run = (owner = 'alice', signal = abort()) =>
    previewOwnedCounterBuyBudget(db, owner, request, signal, dependencies);
  return {
    e,
    sqlite,
    request,
    dependencies,
    run,
    saveBudget,
    setAfterBudgetRead: (f: typeof afterBudgetRead) => {
      afterBudgetRead = f;
    },
  };
}
it('mounts original packet, real simulation settlement replay and final source evidence under an independently owned budget without a write', async () => {
  const f = await ownedFixture(),
    result = await f.run();
  expect(result).toEqual({
    format: 'owned-counter-buy-budget-preview-v1',
    scope: 'read-only-nonreservable-preview',
    ...f.request,
    mint: f.e.budget.terms.mint,
    tokenDecimals: 6,
    inputMint: f.e.budget.inputMint,
    packetSha256: f.e.prepared.preparation.sha256,
    outputTargetRaw: '1000',
    requiredSolInputRaw: '1000000',
    maximumQuoteInputRaw: '1005000',
    actualSimulatedInputRaw: f.e.settlement.actualInputRaw,
    networkFeeLamports: '5000',
    heldInputLamports: '0',
    heldFeeAndRentLamports: '0',
    remainingInputLamports: '10050000',
    remainingFeeAndRentLamports: '60000000',
    observedAt: f.e.simulation.observedAt,
    sourceTradeCount: 1,
    sourceRecheckedAt: new Date().toISOString(),
    sourceValidUntil: new Date(Date.now() + 299000).toISOString(),
    expiresAt: f.e.prepared.expiresAt,
    ownerContext: 'rechecked-advisory-only',
    ownershipContextRechecked: true,
    budgetContextRechecked: true,
    sourceRevalidated: true,
    ownerContextVerified: false,
    claimStorageEligibilityVerified: false,
    accountingCapacityReserved: false,
    crossBudgetReplayProtectionVerified: false,
    proposalUseReservationVerified: false,
    programCodeAttested: false,
    reservationCreated: false,
    approvalAllowed: false,
    ...AUTO_BUY_BUDGET_AUTHORITY,
    limitations:
      'Read-only nonreservable preview. Owned context and held totals were rechecked, not locked. No active-claim capacity, cross-budget or global proposal-use reservation, claim-storage eligibility, code admission or execution authority is established. This response cannot be retained as a claim.',
  });
  expect(result).not.toHaveProperty('claim');
  expect(result).not.toHaveProperty('claimId');
  expect(result).not.toHaveProperty('candidateKey');
  expect(f.dependencies.observeSource).toHaveBeenCalledTimes(3);
  expect(f.dependencies.prepare).toHaveBeenCalledOnce();
  expect(f.dependencies.simulate).toHaveBeenCalledOnce();
  expect(
    f.sqlite.prepare('SELECT count(*) AS n FROM auto_buy_budget_claims').get(),
  ).toMatchObject({ n: 0 });
  expect(JSON.stringify(result)).not.toContain(
    f.e.prepared.preparation.transaction,
  );
  expect(JSON.stringify(result)).not.toContain('settlementEvidence');
});
it('requires an existing exact owned budget before any provider reads', async () => {
  const f = await ownedFixture();
  await expect(f.run('bob')).rejects.toMatchObject({ status: 404 });
  f.sqlite.prepare('DELETE FROM auto_buy_budgets').run();
  await expect(f.run()).rejects.toMatchObject({ status: 404 });
  expect(f.dependencies.observeSource).not.toHaveBeenCalled();
});
it.each([
  'paused',
  'revision',
  'expiry',
  'wallet',
  'strategy',
  'capacity',
  'source',
] as const)(
  'rejects %s budget drift before source/provider work',
  async (kind) => {
    const f = await ownedFixture();
    if (kind === 'paused') f.e.budget.state = 'paused';
    if (kind === 'revision') f.e.budget.revision = 1;
    if (kind === 'expiry')
      f.e.budget.terms.expiresAt = new Date(Date.now() - 1).toISOString();
    if (kind === 'wallet') f.e.budget.terms.wallets[0].revision = 2;
    if (kind === 'strategy') f.e.budget.terms.strategies[0].kind = 'DCA';
    if (kind === 'capacity') f.request.maximumSolInputRaw = '10050001';
    if (kind === 'source')
      f.e.budget.terms.strategies[0].sourceSha256 = 'f'.repeat(64);
    f.saveBudget();
    await expect(f.run()).rejects.toMatchObject({ status: 409 });
    expect(f.dependencies.observeSource).not.toHaveBeenCalled();
  },
);
it('rechecks held totals after final proof, even when session revision stays unchanged', async () => {
  const f = await ownedFixture();
  f.dependencies.observeSource.mockImplementation(async () => {
    if (f.dependencies.observeSource.mock.calls.length === 3)
      f.sqlite
        .prepare('INSERT INTO auto_buy_budget_claims VALUES(?,?,?,?,?)')
        .run('alice', f.request.budgetId, 'held', 1, 1);
    return {
      ...structuredClone(f.e.plan.ledger.decisions[0].source!.movement),
      observedAt: new Date().toISOString(),
    };
  });
  await expect(f.run()).rejects.toThrow(/held accounting/);
  expect(f.dependencies.prepare).toHaveBeenCalledOnce();
});
it('checks owned project again after the final budget read', async () => {
  const f = await ownedFixture();
  f.setAfterBudgetRead((n) => {
    if (n === 3)
      f.sqlite.prepare('UPDATE imported_token_projects SET archived=1').run();
  });
  await expect(f.run()).rejects.toThrow(/context changed/);
});
it('does not return a candidate when source expiry elapses during final verification', async () => {
  const f = await ownedFixture();
  f.dependencies.observeSource.mockImplementation(async () => {
    if (f.dependencies.observeSource.mock.calls.length === 3)
      vi.setSystemTime(Date.now() + 31000);
    return {
      ...structuredClone(f.e.plan.ledger.decisions[0].source!.movement),
      observedAt: new Date().toISOString(),
    };
  });
  await expect(f.run()).rejects.toThrow(/expiry changed/);
});
it('rejects original packet or gross settlement mismatch rather than binding a public DTO', async () => {
  const f = await ownedFixture();
  f.dependencies.simulate.mockImplementation(async () => ({
    ...structuredClone(f.e.simulation),
    networkFeeLamports: '4999',
  }));
  await expect(f.run()).rejects.toMatchObject({ status: 502 });
});
it('rejects malformed selectors and preserves explicit cancellation without provider reads', async () => {
  const f = await ownedFixture();
  expect(() =>
    counterBudgetPreviewRequest({ ...f.request, budgetRevision: -1 }),
  ).toThrow();
  expect(() =>
    counterBudgetPreviewRequest({ ...f.request, claimId: id(22) }),
  ).toThrow();
  expect(() =>
    counterBudgetPreviewRequest({ ...f.request, sign: true }),
  ).toThrow();
  const c = new AbortController();
  c.abort(Error('cancelled'));
  await expect(f.run('alice', c.signal)).rejects.toThrow('cancelled');
  expect(f.dependencies.prepare).not.toHaveBeenCalled();
});

it('rejects budget changes while deriving the selected original strategy, before providers', async () => {
  const f = await ownedFixture();
  f.setAfterBudgetRead((n) => {
    if (n === 1)
      f.sqlite.prepare('UPDATE auto_buy_budgets SET revision=1').run();
  });
  await expect(f.run()).rejects.toThrow(/before provider preparation/);
  expect(f.dependencies.observeSource).not.toHaveBeenCalled();
});
it('rejects an altered final source rather than accepting the earlier successful replay', async () => {
  const f = await ownedFixture();
  f.dependencies.observeSource.mockImplementation(async () => {
    const movement = structuredClone(
      f.e.plan.ledger.decisions[0].source!.movement,
    );
    if (f.dependencies.observeSource.mock.calls.length === 3)
      movement.tokenChange!.changeRaw = '999999';
    return { ...movement, observedAt: new Date().toISOString() };
  });
  await expect(f.run()).rejects.toMatchObject({ status: 409 });
  expect(f.dependencies.prepare).toHaveBeenCalledOnce();
  expect(f.dependencies.observeSource).toHaveBeenCalledTimes(3);
});
it('does not retry when cancellation arrives during the final original source read', async () => {
  const f = await ownedFixture(),
    c = new AbortController();
  f.dependencies.observeSource.mockImplementation(async () => {
    if (f.dependencies.observeSource.mock.calls.length === 3)
      c.abort(Error('final source cancelled'));
    return {
      ...structuredClone(f.e.plan.ledger.decisions[0].source!.movement),
      observedAt: new Date().toISOString(),
    };
  });
  await expect(f.run('alice', c.signal)).rejects.toThrow(
    'final source cancelled',
  );
  expect(f.dependencies.prepare).toHaveBeenCalledOnce();
  expect(f.dependencies.observeSource).toHaveBeenCalledTimes(3);
});

it('reports the final original source replay time rather than the pre-binder replay time', async () => {
  const f = await ownedFixture();
  f.dependencies.observeSource.mockImplementation(async () => {
    if (f.dependencies.observeSource.mock.calls.length === 3)
      vi.setSystemTime(Date.now() + 1000);
    return {
      ...structuredClone(f.e.plan.ledger.decisions[0].source!.movement),
      observedAt: new Date().toISOString(),
    };
  });
  const preview = await f.run();
  expect(preview.sourceRecheckedAt).toBe(new Date().toISOString());
  expect(preview.sourceRecheckedAt).not.toBe(f.e.simulation.observedAt);
  expect(preview.sourceTradeCount).toBe(1);
});
