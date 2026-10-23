import { afterEach, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { counterBuyFixture } from '../test/counter-buy-fixture';
import { routeWallet } from '../test/jupiter-route-fixture';
import { initialCounterLedger } from './counter-trade';
import {
  previewOwnedCounterBuy,
  previewOwnedCounterBuyRuntime,
} from './counter-owned-preview';
import type { prepareCounterBuyProposal } from './counter-buy-preparation';
import type { simulateCounterBuyPreparation } from './counter-buy-simulation';
import type { reviewCounterBuySettlement } from './counter-buy-settlement';
import { WRAPPED_SOL } from './warmup-swap-quote';
import { supplyWallet } from '../test/supply-history-fixture';
import { counterBuyRuntimeFixture } from '../test/counter-buy-runtime-fixture';
import { collectCounterBuyRuntimeEvidence } from './counter-buy-runtime';
import { reviewCounterBuySettlement as realSettlement } from './counter-buy-settlement';
import { counterRuntimeView } from './counter-runtime-view';

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
  return { sqlite, db, plan, input, prepared, proof, dependencies, run };
}

function runtimeFixture() {
  const f = fixture();
  const simulation = {
    networkFeeLamports: '5000',
    simulationSlot: 105,
    observedAt: new Date().toISOString(),
  } as Awaited<ReturnType<typeof simulateCounterBuyPreparation>>;
  const runtime = {
    format: 'counter-buy-runtime-evidence-v1' as const,
    packetSha256: f.prepared.preparation.sha256,
    minimumSlot: 100,
    maximumSlot: 106,
    simulationSlot: 105,
    observedAt: simulation.observedAt,
    expiresAt: f.prepared.expiresAt,
    programs: [],
    traceSha256: 'b'.repeat(64),
    codeIdentityObserved: true as const,
    ordinaryClockVerified: true as const,
    codeScanCount: 2 as const,
    programCodeAttested: false as const,
    semanticAuditEstablished: false as const,
    trustedProgramPolicyEstablished: false as const,
    innerInstructionPolicyVerified: false as const,
    signingAllowed: false as const,
    executionAllowed: false as const,
    sha256: 'c'.repeat(64),
  };
  // Stage doubles test the owned composition. Raw RPC/code checks have their
  // own real-packet collector tests; these doubles are not that evidence.
  const collect = vi.fn(async () => ({ simulation, runtime, codeScans: [] }));
  const deps = {
    ...f.dependencies,
    runtime:
      collect as unknown as typeof import('./counter-buy-runtime').collectCounterBuyRuntimeEvidence,
  };
  const run = (owner = 'alice', signal = new AbortController().signal) =>
    previewOwnedCounterBuyRuntime(f.db, owner, f.input, signal, deps);
  return { ...f, simulation, runtime, collect, run };
}
it('uses runtime simulation once with original owned ExactOut and rechecks source and settlement', async () => {
  const f = runtimeFixture(),
    result = await f.run();
  expect(f.collect).toHaveBeenCalledExactlyOnceWith(
    f.prepared,
    '5000',
    expect.any(AbortSignal),
  );
  expect(f.dependencies.simulate).not.toHaveBeenCalled();
  expect(f.dependencies.settle).toHaveBeenCalledExactlyOnceWith(
    f.prepared,
    f.simulation,
    '5000',
  );
  expect(f.dependencies.observeSource).toHaveBeenCalledTimes(2);
  expect(result.preview.packetSha256).toBe(result.runtime.packetSha256);
  expect(result.runtime.programCodeAttested).toBe(false);
  expect(result.preview.approvalAllowed).toBe(false);
  expect(JSON.stringify(result)).not.toContain('PRIVATE-UNSIGNED-PACKET');
  expect(result).not.toHaveProperty('codeScans');
});
it.each(['owner', 'paused', 'archived', 'proof'] as const)(
  'rejects changed %s before the runtime provider',
  async (kind) => {
    const f = runtimeFixture();
    if (kind === 'paused')
      f.sqlite.exec("UPDATE counter_trade_plans SET state='paused'");
    if (kind === 'archived')
      f.sqlite.exec('UPDATE workspace_wallets SET archived=1');
    if (kind === 'proof') f.sqlite.exec('DELETE FROM wallet_ownership_proofs');
    await expect(
      f.run(kind === 'owner' ? 'bob' : 'alice'),
    ).rejects.toMatchObject({ status: 409 });
    expect(f.collect).not.toHaveBeenCalled();
  },
);
it('refuses current wallet drift during actual runtime stage before settlement', async () => {
  const f = runtimeFixture();
  f.collect.mockImplementation(async () => {
    f.sqlite.exec('UPDATE workspace_wallets SET revision=2');
    return { simulation: f.simulation, runtime: f.runtime, codeScans: [] };
  });
  await expect(f.run()).rejects.toMatchObject({ status: 409 });
  expect(f.dependencies.settle).not.toHaveBeenCalled();
});
it.each(['hash', 'slot', 'span', 'expired', 'authority'] as const)(
  'refuses mismatching runtime %s without granting authority',
  async (kind) => {
    const f = runtimeFixture();
    if (kind === 'hash') f.runtime.packetSha256 = 'd'.repeat(64);
    if (kind === 'slot') f.runtime.simulationSlot++;
    if (kind === 'span') f.runtime.maximumSlot = 133;
    if (kind === 'expired')
      f.runtime.expiresAt = new Date(Date.now() - 1).toISOString();
    if (kind === 'authority')
      Object.assign(f.runtime, { signingAllowed: true });
    await expect(f.run()).rejects.toMatchObject({ status: 409 });
  },
);
it('sanitizes provider failures without retrying or falling back to the basic collector', async () => {
  const f = runtimeFixture();
  f.collect.mockRejectedValueOnce(
    Error('https://private-provider.invalid/key'),
  );
  await expect(f.run()).rejects.toMatchObject({ status: 502 });
  expect(f.collect).toHaveBeenCalledOnce();
  expect(f.dependencies.simulate).not.toHaveBeenCalled();
});
it('refuses final source drift and aborted runtime results', async () => {
  const f = runtimeFixture();
  const observe = f.dependencies.observeSource.getMockImplementation()!;
  f.dependencies.observeSource.mockImplementationOnce(observe);
  f.dependencies.observeSource.mockImplementationOnce(async () => {
    const movement = await observe();
    movement.classification.reason += ' changed';
    return movement;
  });
  await expect(f.run()).rejects.toMatchObject({ status: 409 });
  const c = new AbortController(),
    g = runtimeFixture();
  g.collect.mockImplementation(async () => {
    c.abort();
    return { simulation: g.simulation, runtime: g.runtime, codeScans: [] };
  });
  await expect(g.run('alice', c.signal)).rejects.toBeDefined();
});

it('composes owned source admission with actual ExactOut RPC evidence, gross settlement and strict browser admission', async () => {
  const f = fixture(),
    target = f.plan.ledger.decisions.find(
      (d) => d.identity === f.input.decisionIdentity,
    )!.proposalTokenRaw!,
    chain = await counterBuyRuntimeFixture({
      mint: f.plan.ledger.scope.mint,
      tokenRaw: BigInt(target),
    });
  chain.clock.now = Date.now();
  // The owned source fixture uses nine token decimals; return that same
  // protocol-shaped mint metadata throughout the synthetic RPC observations.
  chain.order.tokenDecimals = f.plan.ledger.scope.decimals;
  const rpc: import('./counter-buy-simulation').CounterSimulationRpc = async (
    method,
    params,
    scope,
  ) => {
    const result = await chain.rpc(method, params, scope);
    if (method === 'getMultipleAccounts' || method === 'simulateTransaction') {
      const accounts =
        method === 'getMultipleAccounts'
          ? (result as { value: ({ data: [string, string] } | null)[] }).value
          : (
              result as {
                value: { accounts: ({ data: [string, string] } | null)[] };
              }
            ).value.accounts;
      const keys =
        method === 'getMultipleAccounts'
          ? (params[0] as string[])
          : (params[1] as { accounts: { addresses: string[] } }).accounts
              .addresses;
      for (const [i, key] of keys.entries()) {
        const account = accounts[i];
        if (key === f.plan.ledger.scope.mint && account) {
          const bytes = Buffer.from(account.data[0], 'base64');
          if (bytes.length === 82) {
            bytes[44] = f.plan.ledger.scope.decimals;
            account.data[0] = bytes.toString('base64');
          }
        }
      }
    }
    return result;
  };
  f.input.wallet = chain.order.preparation.wallet;
  f.input.maximumSolInputRaw = chain.order.quote.reviewedSolBudgetRaw;
  f.input.maximumFeeAndRentRaw = '6000000';
  f.sqlite
    .prepare('UPDATE workspace_wallets SET address=?')
    .run(f.input.wallet);
  f.sqlite
    .prepare('UPDATE wallet_ownership_proofs SET address=?')
    .run(f.input.wallet);
  f.plan.rules.ignoredWallets = [f.input.wallet];
  f.plan.ledger.rulesKey = initialCounterLedger(
    f.plan.rules,
    f.plan.ledger.scope,
  ).rulesKey;
  f.sqlite
    .prepare('UPDATE counter_trade_plans SET document=?')
    .run(JSON.stringify(f.plan));
  Object.assign(chain.order.quote, {
    projectId: f.input.projectId,
    projectRevision: f.input.projectRevision,
    planId: f.input.planId,
    planRevision: f.input.planRevision,
    decisionIdentity: f.input.decisionIdentity,
  });
  Object.assign(chain.order.review, {
    projectId: f.input.projectId,
    projectRevision: f.input.projectRevision,
    planId: f.input.planId,
    planRevision: f.input.planRevision,
    decisionIdentity: f.input.decisionIdentity,
  });
  let stageFailure: unknown;
  const runtime = vi.fn(
    async (
      order: Parameters<typeof collectCounterBuyRuntimeEvidence>[0],
      fee: string,
      scope: AbortSignal,
    ) => {
      try {
        return await collectCounterBuyRuntimeEvidence(
          order,
          fee,
          scope,
          rpc,
          () => chain.clock.now,
        );
      } catch (error) {
        stageFailure = error;
        throw error;
      }
    },
  );
  const result = await previewOwnedCounterBuyRuntime(
    f.db,
    'alice',
    f.input,
    new AbortController().signal,
    {
      ...f.dependencies,
      prepare: async () => chain.order,
      settle: async (...args: Parameters<typeof realSettlement>) => {
        try {
          return await realSettlement(...args);
        } catch (error) {
          stageFailure = error;
          throw error;
        }
      },
      runtime,
    },
  ).catch((error) => {
    throw stageFailure ?? error;
  });
  expect(chain.state.simulations).toBe(1);
  expect(f.dependencies.simulate).not.toHaveBeenCalled();
  expect(f.dependencies.observeSource).toHaveBeenCalledTimes(2);
  expect(runtime).toHaveBeenCalledOnce();
  expect(result.preview.outputTargetRaw).toBe(target);
  expect(result.preview.actualSimulatedInputRaw).toBe('1000000');
  expect(result.runtime.programs.length).toBeGreaterThan(1);
  expect(result.runtime.codeScanCount).toBe(2);
  expect(result.preview.signingAllowed).toBe(false);
  expect(await counterRuntimeView(result, f.plan, f.input)).toEqual(result);
  expect(JSON.stringify(result)).not.toContain(
    chain.order.preparation.transaction,
  );
});
