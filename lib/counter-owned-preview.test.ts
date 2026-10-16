import { afterEach, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { counterBuyFixture } from '../test/counter-buy-fixture';
import { routeWallet } from '../test/jupiter-route-fixture';
import { initialCounterLedger } from './counter-trade';
import {
  previewOwnedCounterBuy,
  counterPreviewRequest,
} from './counter-owned-preview';
import type { prepareCounterBuyProposal } from './counter-buy-preparation';
import type { simulateCounterBuyPreparation } from './counter-buy-simulation';
import type { reviewCounterBuySettlement } from './counter-buy-settlement';
import { WRAPPED_SOL } from './warmup-swap-quote';
import { supplyWallet } from '../test/supply-history-fixture';

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  vi.useRealTimers();
});
function fixture() {
  const { plan, identity } = counterBuyFixture(supplyWallet(9)),
    sqlite = new DatabaseSync(':memory:');
  databases.push(sqlite);
  plan.projectDocument = JSON.stringify({
    token: {
      chain: 'Solana',
      address: plan.ledger.scope.mint,
      decimals: plan.ledger.scope.decimals,
    },
  });
  plan.rules.ignoredWallets = [routeWallet];
  plan.ledger.rulesKey = initialCounterLedger(
    plan.rules,
    plan.ledger.scope,
  ).rulesKey;
  plan.createdAt = new Date(Date.now() - 2000).toISOString();
  plan.updatedAt = new Date().toISOString();
  const source = plan.ledger.decisions[0].source!;
  source.movement.blockTime = Math.floor(Date.now() / 1000) - 1;
  source.movement.observedAt = new Date().toISOString();
  sqlite.exec(`CREATE TABLE counter_trade_plans(owner_id TEXT,project_id TEXT,id TEXT,revision INTEGER,state TEXT,document TEXT);
  CREATE TABLE imported_token_projects(owner_id TEXT,id TEXT,chain TEXT,address TEXT,revision INTEGER,archived INTEGER,document TEXT);
  CREATE TABLE workspace_wallets(owner_id TEXT,chain TEXT,address TEXT,revision INTEGER,archived INTEGER,role TEXT,updated_at TEXT);
  CREATE TABLE wallet_ownership_proofs(owner_id TEXT,chain TEXT,address TEXT);`);
  sqlite
    .prepare('INSERT INTO counter_trade_plans VALUES(?,?,?,?,?,?)')
    .run(
      'alice',
      plan.projectId,
      plan.id,
      plan.revision,
      plan.state,
      JSON.stringify(plan),
    );
  sqlite
    .prepare('INSERT INTO imported_token_projects VALUES(?,?,?,?,?,?,?)')
    .run(
      'alice',
      plan.projectId,
      'Solana',
      plan.ledger.scope.mint,
      plan.ledger.scope.revision,
      0,
      plan.projectDocument,
    );
  sqlite
    .prepare('INSERT INTO workspace_wallets VALUES(?,?,?,?,?,?,?)')
    .run(
      'alice',
      'Solana',
      routeWallet,
      1,
      0,
      'Recipient',
      '2026-10-16T00:00:00.000Z',
    );
  sqlite
    .prepare('INSERT INTO wallet_ownership_proofs VALUES(?,?,?)')
    .run('alice', 'Solana', routeWallet);
  const db = {
    prepare(sql: string) {
      return {
        bind(...values: (string | number)[]) {
          return {
            async first() {
              return sqlite.prepare(sql).get(...values) ?? null;
            },
          };
        },
      };
    },
  } as unknown as D1Database;
  const input = {
    projectId: plan.projectId,
    projectRevision: plan.ledger.scope.revision,
    planId: plan.id,
    planRevision: plan.revision,
    decisionIdentity: identity,
    wallet: routeWallet,
    walletRevision: 1,
    maximumSolInputRaw: '1005',
    maximumFeeAndRentRaw: '5000',
  };
  const expiresAt = new Date(Date.now() + 30000).toISOString();
  const prepared = {
    format: 'counter-buy-preparation-v1',
    executionAllowed: false,
    instructionsVerified: false,
    tokenDecimals: plan.ledger.scope.decimals,
    preparation: {
      wallet: routeWallet,
      sha256: 'a'.repeat(64),
      transaction: 'PRIVATE-UNSIGNED-PACKET',
    },
    quote: {
      ...input,
      inputMint: WRAPPED_SOL,
      outputMint: plan.ledger.scope.mint,
      outputTargetRaw: plan.ledger.decisions[0].proposalTokenRaw,
      requiredSolInputRaw: '1000',
      maximumSolInputRaw: '1005',
      reviewedSolBudgetRaw: '1005',
      swapMode: 'ExactOut',
      slippageBps: 50,
      executionAllowed: false,
    },
    expiresAt,
  } as unknown as Awaited<ReturnType<typeof prepareCounterBuyProposal>>;
  const simulation = {
    networkFeeLamports: '5000',
    observedAt: new Date().toISOString(),
  } as Awaited<ReturnType<typeof simulateCounterBuyPreparation>>;
  const proof = {
    swapMode: 'ExactOut',
    ...input,
    sha256: 'a'.repeat(64),
    wallet: routeWallet,
    expiresAt,
    actualInputRaw: '1000',
    reviewedFeeAndRentLimitRaw: '5000',
    executionAllowed: false,
    instructionsVerified: false,
  } as unknown as Awaited<ReturnType<typeof reviewCounterBuySettlement>>;
  // These stage doubles exercise the owned boundary, not the underlying chain verification.
  const dependencies = {
    observeSource: vi.fn(async () => ({
      ...structuredClone(source.movement),
      observedAt: new Date().toISOString(),
    })),
    prepare: vi.fn(async () => structuredClone(prepared)),
    simulate: vi.fn(async () => structuredClone(simulation)),
    settle: vi.fn(async () => structuredClone(proof)),
  };
  const run = (owner = 'alice', signal = new AbortController().signal) =>
    previewOwnedCounterBuy(db, owner, input, signal, dependencies);
  return { sqlite, plan, input, prepared, proof, dependencies, run };
}
it('joins owned preparation, simulation and gross settlement while returning no packet or approval authority', async () => {
  const f = fixture(),
    result = await f.run();
  expect(result).toMatchObject({
    format: 'owned-counter-buy-preview-v1',
    packetSha256: 'a'.repeat(64),
    ownershipContextRechecked: true,
    grossSettlementReviewed: true,
    sourceRevalidated: true,
    sourceTradeCount: 1,
    programCodeAttested: false,
    signingAllowed: false,
    executionAllowed: false,
    approvalAllowed: false,
    reservationCreated: false,
  });
  expect(f.dependencies.prepare).toHaveBeenCalledWith(
    f.plan,
    f.input.decisionIdentity,
    '1005',
    routeWallet,
    expect.any(AbortSignal),
  );
  expect(f.dependencies.simulate).toHaveBeenCalledWith(
    f.prepared,
    '5000',
    expect.any(AbortSignal),
  );
  expect(JSON.stringify(result)).not.toContain('PRIVATE-UNSIGNED-PACKET');
  expect(f.dependencies.observeSource).toHaveBeenCalledTimes(2);
});
it.each([
  'other-owner',
  'watch-only',
  'archived',
  'wallet-revision',
  'excluded-roster',
  'project',
  'paused',
] as const)('rejects %s before any provider stage', async (kind) => {
  const f = fixture();
  if (kind === 'watch-only')
    f.sqlite.exec('DELETE FROM wallet_ownership_proofs');
  if (kind === 'archived')
    f.sqlite.exec('UPDATE workspace_wallets SET archived=1');
  if (kind === 'wallet-revision')
    f.sqlite.exec('UPDATE workspace_wallets SET revision=2');
  if (kind === 'excluded-roster')
    f.sqlite
      .prepare('INSERT INTO wallet_ownership_proofs VALUES(?,?,?)')
      .run('alice', 'Solana', WRAPPED_SOL);
  if (kind === 'project')
    f.sqlite.exec('UPDATE imported_token_projects SET revision=99');
  if (kind === 'paused')
    f.sqlite.exec("UPDATE counter_trade_plans SET state='paused'");
  await expect(
    f.run(kind === 'other-owner' ? 'bob' : 'alice'),
  ).rejects.toMatchObject({ status: 409 });
  expect(f.dependencies.prepare).not.toHaveBeenCalled();
});
it.each(['prepare', 'simulate', 'settle'] as const)(
  'rejects context changed during %s and never publishes a stale preview',
  async (stage) => {
    const f = fixture();
    if (stage === 'prepare')
      f.dependencies.prepare.mockImplementation(async () => {
        f.sqlite.exec('UPDATE workspace_wallets SET revision=2');
        return f.prepared;
      });
    if (stage === 'simulate')
      f.dependencies.simulate.mockImplementation(async () => {
        f.sqlite.exec('DELETE FROM wallet_ownership_proofs');
        return { networkFeeLamports: '5000' } as Awaited<
          ReturnType<typeof simulateCounterBuyPreparation>
        >;
      });
    if (stage === 'settle')
      f.dependencies.settle.mockImplementation(async () => {
        f.sqlite.exec('UPDATE counter_trade_plans SET revision=99');
        return f.proof;
      });
    await expect(f.run()).rejects.toMatchObject({ status: 409 });
    if (stage === 'prepare')
      expect(f.dependencies.simulate).not.toHaveBeenCalled();
    if (stage === 'simulate')
      expect(f.dependencies.settle).not.toHaveBeenCalled();
  },
);
it('rejects mismatched stage identities and sanitizes provider failures', async () => {
  const f = fixture();
  f.prepared.quote.planId = crypto.randomUUID();
  await expect(f.run()).rejects.toMatchObject({ status: 409 });
  expect(f.dependencies.simulate).not.toHaveBeenCalled();
  f.dependencies.prepare.mockRejectedValueOnce(
    Error('https://secret-provider.example/?api-key=private'),
  );
  try {
    await f.run();
    throw Error('accepted');
  } catch (error) {
    expect(error).toMatchObject({ status: 502 });
    expect(JSON.stringify(error)).not.toContain('secret-provider');
  }
});
it('rejects client authority flags, invalid raw amounts and pre-aborted requests', async () => {
  const f = fixture();
  for (const patch of [
    { sign: true },
    { maximumSolInputRaw: '0' },
    { maximumFeeAndRentRaw: '-1' },
    { walletRevision: 0 },
  ])
    expect(() => counterPreviewRequest({ ...f.input, ...patch })).toThrow();
  const stop = new AbortController();
  stop.abort();
  await expect(f.run('alice', stop.signal)).rejects.toThrow();
  expect(f.dependencies.prepare).not.toHaveBeenCalled();
});
it('keeps legacy history readable but refuses its missing source before preparation', async () => {
  const f = fixture();
  delete f.plan.ledger.decisions[0].source;
  f.sqlite
    .prepare('UPDATE counter_trade_plans SET document=?')
    .run(JSON.stringify(f.plan));
  await expect(f.run()).rejects.toMatchObject({ status: 409 });
  expect(f.dependencies.observeSource).not.toHaveBeenCalled();
  expect(f.dependencies.prepare).not.toHaveBeenCalled();
});
it('names the missing owned proof without exposing another owner or running a provider', async () => {
  const f = fixture();
  f.sqlite
    .prepare('INSERT INTO wallet_ownership_proofs VALUES(?,?,?)')
    .run('alice', 'Solana', WRAPPED_SOL);
  await expect(f.run()).rejects.toMatchObject({
    status: 409,
    message: expect.stringContaining(`Proven wallet ${WRAPPED_SOL} is missing`),
  });
  await expect(f.run('bob')).rejects.toMatchObject({
    status: 409,
    message:
      'Owned Counter proposal, exclusions or wallet changed. Reload saved history.',
  });
  expect(f.dependencies.observeSource).not.toHaveBeenCalled();
  expect(f.dependencies.prepare).not.toHaveBeenCalled();
});
it('names a new proof added during preparation and still refuses simulation', async () => {
  const f = fixture();
  f.dependencies.prepare.mockImplementationOnce(async () => {
    f.sqlite
      .prepare('INSERT INTO wallet_ownership_proofs VALUES(?,?,?)')
      .run('alice', 'Solana', WRAPPED_SOL);
    return f.prepared;
  });
  await expect(f.run()).rejects.toMatchObject({
    status: 409,
    message: expect.stringContaining(WRAPPED_SOL),
  });
  expect(f.dependencies.simulate).not.toHaveBeenCalled();
});
it('rechecks sources after settlement and rejects a changed final observation', async () => {
  const f = fixture(),
    observe = f.dependencies.observeSource.getMockImplementation()!;
  f.dependencies.observeSource
    .mockImplementationOnce(observe)
    .mockImplementationOnce(async () => {
      const movement = await observe();
      movement.classification.reason += ' changed';
      return movement;
    });
  await expect(f.run()).rejects.toMatchObject({ status: 409 });
  expect(f.dependencies.settle).toHaveBeenCalledOnce();
  expect(f.dependencies.observeSource).toHaveBeenCalledTimes(2);
});
it('rechecks owned context after source reads before preparing a packet', async () => {
  const f = fixture(),
    observe = f.dependencies.observeSource.getMockImplementation()!;
  f.dependencies.observeSource.mockImplementationOnce(async () => {
    f.sqlite.exec('UPDATE workspace_wallets SET revision=2');
    return observe();
  });
  await expect(f.run()).rejects.toMatchObject({ status: 409 });
  expect(f.dependencies.prepare).not.toHaveBeenCalled();
});
it('does not publish a packet that expires during the final source reads', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  const f = fixture(),
    observe = f.dependencies.observeSource.getMockImplementation()!;
  f.dependencies.observeSource
    .mockImplementationOnce(observe)
    .mockImplementationOnce(async () => {
      vi.setSystemTime(Date.now() + 31000);
      return observe();
    });
  await expect(f.run()).rejects.toMatchObject({
    status: 409,
    message: expect.stringContaining('expired during source'),
  });
});
