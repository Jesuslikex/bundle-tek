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
import {
  autoBuyBudgetClaim,
  AUTO_BUY_BUDGET_AUTHORITY,
} from './auto-buy-budget';
import {
  counterAutoBuyCandidateIdentity,
  bindCounterAutoBuyAccountingCandidate,
  type CounterAutoBuyCandidateInput,
} from './auto-buy-counter-candidate';
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const abort = () => new AbortController().signal;
afterEach(() => vi.useRealTimers());
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
    run: (value = input, signal = abort()) =>
      bindCounterAutoBuyAccountingCandidate(value, signal),
  };
}
it('binds actual unsigned packet and replayed gross settlement to exact existing budget units without authority', async () => {
  const f = await candidateFixture(),
    result = await f.run();
  expect(autoBuyBudgetClaim(result.claim)).toEqual(result.claim);
  expect(result).toMatchObject({
    scope: 'server-internal-accounting-candidate-only',
    ownerContextVerified: false,
    accountingCapacityReserved: false,
    crossBudgetReplayProtectionVerified: false,
    proposalUseReservationVerified: false,
    sourceVerified: false,
    instructionsVerified: false,
    walletFundsReserved: false,
    executionAllowed: false,
    automaticExecutionAllowed: false,
    signingAllowed: false,
  });
  expect(result.claim).toMatchObject({
    kind: 'ExactOut',
    minimumOutputTokenRaw: '1000',
    maximumInputLamports: '1005000',
    maximumFeeAndRentLamports: '6000000',
    packetSha256: f.input.prepared.preparation.sha256,
    expiresAt: f.input.prepared.expiresAt,
  });
  expect(result.suppliedSourceTradeCount).toBe(1);
  expect(result.suppliedSourceRecheckedAt).toBe(
    f.input.sourceReview.sourceRecheckedAt,
  );
  expect(result).not.toHaveProperty('sourceTradeCount');
  expect(result).not.toHaveProperty('sourceRecheckedAt');
  expect(result).not.toHaveProperty('transaction');
});
it('keeps source/proposal keys stable across evaluation revisions and requote-only fields', async () => {
  const f = await candidateFixture(),
    first = await f.run(),
    next = structuredClone(f.input);
  next.plan.revision++;
  next.plan.updatedAt = new Date(Date.now() + 1).toISOString();
  next.prepared.quote.planRevision++;
  next.prepared.review.planRevision++;
  next.settlement.planRevision++;
  vi.setSystemTime(Date.now() + 1000);
  next.selection.now = Date.now();
  next.prepared.quote.observedAt = new Date(next.selection.now).toISOString();
  next.prepared.observedAt = new Date(next.selection.now).toISOString();
  next.sourceReview.sourceRecheckedAt = new Date(
    next.selection.now,
  ).toISOString();
  const second = await f.run(next);
  expect(second.claim.sourceSha256).toBe(first.claim.sourceSha256);
  expect(second.claim.candidateKey).toBe(first.claim.candidateKey);
});
it('changes identity when the original rules or original contributing decision change', async () => {
  const f = await candidateFixture(),
    identity = f.input.prepared.quote.decisionIdentity;
  const initial = await counterAutoBuyCandidateIdentity(f.input.plan, identity);
  const next = structuredClone(f.input.plan);
  next.createdAt = new Date(Date.now() - 3000).toISOString();
  expect(
    (await counterAutoBuyCandidateIdentity(next, identity)).sourceSha256,
  ).not.toBe(initial.sourceSha256);
  const changed = structuredClone(f.input);
  changed.budget.terms.strategies[0].sourceSha256 = 'a'.repeat(64);
  await expect(f.run(changed)).rejects.toThrow('original Counter');
});
it.each([
  'project',
  'mint',
  'precision',
  'budget',
  'revision',
  'strategy',
  'kind',
  'wallet',
  'walletRevision',
  'paused',
])('refuses changed selected %s context', async (kind) => {
  const f = await candidateFixture(),
    x = structuredClone(f.input);
  if (kind === 'project') x.budget.terms.projectId = id(99);
  if (kind === 'mint')
    x.budget.terms.mint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  if (kind === 'precision') x.budget.terms.tokenDecimals = 9;
  if (kind === 'budget') x.selection.budgetId = id(99);
  if (kind === 'revision') x.selection.budgetRevision++;
  if (kind === 'strategy') x.selection.strategyId = id(99);
  if (kind === 'kind') x.budget.terms.strategies[0].kind = 'DCA';
  if (kind === 'wallet')
    x.selection.wallet = '11111111111111111111111111111111';
  if (kind === 'walletRevision') x.selection.walletRevision++;
  if (kind === 'paused') x.budget.state = 'paused';
  await expect(f.run(x)).rejects.toThrow('original Counter');
});
it.each([
  'target',
  'input',
  'fee',
  'packet',
  'proof',
  'instructions',
  'source',
  'future',
  'expired',
  'authority',
  'unsafe',
])('refuses changed %s proof or capacity', async (kind) => {
  const f = await candidateFixture(),
    x = structuredClone(f.input);
  if (kind === 'target') x.prepared.quote.outputTargetRaw = '999';
  if (kind === 'input')
    x.budget.terms.wallets[0].maximumInputLamports = '1004999';
  if (kind === 'fee')
    x.budget.terms.strategies[0].maximumFeeAndRentLamports = '5999999';
  if (kind === 'packet') x.prepared.preparation.sha256 = 'b'.repeat(64);
  if (kind === 'proof') x.settlement.actualInputRaw = '999';
  if (kind === 'instructions')
    x.simulation.instructionReview.instructions[0].dataHex = '00';
  if (kind === 'source') x.sourceReview.sourceTradeCount = 2;
  if (kind === 'future')
    x.sourceReview.sourceRecheckedAt = new Date(Date.now() + 1).toISOString();
  if (kind === 'expired')
    x.sourceReview.sourceValidUntil = new Date(Date.now()).toISOString();
  if (kind === 'authority') x.budget.executionAllowed = true as never;
  if (kind === 'unsafe')
    x.prepared.quote.maximumSolInputRaw = '9007199254740992';
  await expect(f.run(x)).rejects.toThrow('original Counter');
});
it('uses the earliest original budget/source/packet expiry without renewing any input', async () => {
  const f = await candidateFixture();
  f.input.budget.terms.expiresAt = new Date(Date.now() + 10000).toISOString();
  expect((await f.run()).claim.expiresAt).toBe(f.input.budget.terms.expiresAt);
  f.input.budget.terms.expiresAt = new Date(Date.now() + 60000).toISOString();
  f.input.sourceReview.sourceValidUntil = new Date(
    Date.now() + 5000,
  ).toISOString();
  expect((await f.run()).claim.expiresAt).toBe(
    f.input.sourceReview.sourceValidUntil,
  );
});
it('rejects a packet-hash-only public preview instead of treating it as internal evidence', async () => {
  const f = await candidateFixture();
  await expect(
    f.run({
      ...f.input,
      prepared: { packetSha256: f.input.prepared.preparation.sha256 },
    } as never),
  ).rejects.toThrow('original Counter');
});
it('preserves cancellation and owns mutable inputs before asynchronous digest work', async () => {
  const f = await candidateFixture(),
    c = new AbortController(),
    reason = Error('cancelled');
  c.abort(reason);
  await expect(f.run(f.input, c.signal)).rejects.toBe(reason);
  const pending = f.run();
  f.input.budget.terms.id = id(99);
  f.input.prepared.quote.outputTargetRaw = '999';
  expect((await pending).claim.sessionId).toBe(id(20));
});

it('binds original rule changes and changed contributor evidence into replay identities', async () => {
  const f = await candidateFixture(),
    identity = f.input.prepared.quote.decisionIdentity;
  const first = await counterAutoBuyCandidateIdentity(f.input.plan, identity);
  const rulesChanged = structuredClone(f.input.plan);
  rulesChanged.rules.replicationPercent = '0.2';
  const original = rulesChanged.ledger.decisions[0].source!;
  rulesChanged.ledger = evaluateCounterTrade(
    rulesChanged.rules,
    initialCounterLedger(rulesChanged.rules, rulesChanged.ledger.scope),
    original.movement,
    original.context,
  ).ledger;
  const changedRules = await counterAutoBuyCandidateIdentity(
    rulesChanged,
    identity,
  );
  expect(changedRules.sourceSha256).not.toBe(first.sourceSha256);
  expect(changedRules.candidateKey).not.toBe(first.candidateKey);
  const contributionChanged = structuredClone(f.input.plan),
    source = contributionChanged.ledger.decisions[0].source!;
  source.movement.slot++;
  source.movement.providerBlock++;
  source.context.trade.block++;
  contributionChanged.ledger = evaluateCounterTrade(
    contributionChanged.rules,
    initialCounterLedger(
      contributionChanged.rules,
      contributionChanged.ledger.scope,
    ),
    source.movement,
    source.context,
  ).ledger;
  const changedContribution = await counterAutoBuyCandidateIdentity(
    contributionChanged,
    identity,
  );
  expect(changedContribution.sourceSha256).toBe(first.sourceSha256);
  expect(changedContribution.candidateKey).not.toBe(first.candidateKey);
});
it.each(['input', 'fee', 'inconsistent'] as const)(
  'refuses %s remaining accounting without pretending to reserve capacity',
  async (kind) => {
    const f = await candidateFixture();
    if (kind === 'input') {
      f.input.budget.heldInputLamports = '10050000';
      f.input.budget.remainingInputLamports = '0';
    }
    if (kind === 'fee') {
      f.input.budget.heldFeeAndRentLamports = '60000000';
      f.input.budget.remainingFeeAndRentLamports = '0';
    }
    if (kind === 'inconsistent') f.input.budget.remainingInputLamports = '1';
    await expect(f.run()).rejects.toThrow('original Counter');
  },
);
it('refuses forged extended source validity and altered original settlement assessment', async () => {
  const f = await candidateFixture();
  f.input.sourceReview.sourceValidUntil = new Date(
    Date.now() + 301000,
  ).toISOString();
  await expect(f.run()).rejects.toThrow('original Counter');
  f.input.sourceReview.sourceValidUntil = new Date(
    Date.now() + 10000,
  ).toISOString();
  f.input.prepared.review.assessment.status = 'Mismatch';
  await expect(f.run()).rejects.toThrow('original Counter');
});

it.each(['chain', 'address', 'decimals', 'missing', 'malformed'] as const)(
  'refuses project token %s drift even with a recomputed matching strategy identity',
  async (field) => {
    const f = await candidateFixture();
    const document = JSON.parse(f.input.plan.projectDocument) as {
      token: { chain: string; address: string; decimals: number };
    };
    if (field === 'chain') document.token.chain = 'Ethereum';
    if (field === 'address')
      document.token.address = '11111111111111111111111111111111';
    if (field === 'decimals') document.token.decimals = 9;
    f.input.plan.projectDocument =
      field === 'missing'
        ? '{}'
        : field === 'malformed'
          ? '{'
          : JSON.stringify(document);
    const identity = await counterAutoBuyCandidateIdentity(
      f.input.plan,
      f.input.prepared.quote.decisionIdentity,
    );
    f.input.budget.terms.strategies[0].sourceSha256 = identity.sourceSha256;
    await expect(f.run()).rejects.toThrow('original Counter');
  },
);
