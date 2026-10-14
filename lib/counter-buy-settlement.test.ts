import { it, expect } from 'vitest';
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
async function fixture() {
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
it('joins an actual ExactOut packet, collected snapshots and gross wrapping/rent checks without signing', async () => {
  const f = await fixture(),
    simulation = await simulateCounterBuyPreparation(
      f.order,
      '6000000',
      new AbortController().signal,
      f.rpc,
    );
  expect(simulation.balanceAssessment.status).toBe('Matched balances');
  expect(
    await reviewCounterBuySettlement(f.order, simulation, '6000000'),
  ).toMatchObject({
    executionAllowed: false,
    instructionsVerified: false,
    sha256: f.order.preparation.sha256,
    actualInputRaw: '1000000',
    decisionIdentity: 'test-signal',
    settlement: {
      wrappedFromNativeRaw: '1000000',
      maximumRentLamports: '4078560',
      maximumNativeDebitLamports: '5083560',
      closesWrappedAccount: true,
    },
  });
});
it('rejects tampered instruction evidence even if packet hashes and balance claims still match', async () => {
  const f = await fixture(),
    simulation = await simulateCounterBuyPreparation(
      f.order,
      '6000000',
      new AbortController().signal,
      f.rpc,
    );
  simulation.instructionReview.instructions[0].dataHex = '00';
  await expect(
    reviewCounterBuySettlement(f.order, simulation, '6000000'),
  ).rejects.toThrow('do not belong');
});
it('rejects changed budgets, packet identity, expiry and failed comparisons', async () => {
  const f = await fixture(),
    simulation = await simulateCounterBuyPreparation(
      f.order,
      '6000000',
      new AbortController().signal,
      f.rpc,
    );
  await expect(
    reviewCounterBuySettlement(f.order, simulation, '5999999'),
  ).rejects.toThrow();
  await expect(
    reviewCounterBuySettlement(
      { ...f.order, expiresAt: new Date(0).toISOString() },
      simulation,
      '6000000',
    ),
  ).rejects.toThrow();
  await expect(
    reviewCounterBuySettlement(
      f.order,
      { ...simulation, sha256: '0'.repeat(64) },
      '6000000',
    ),
  ).rejects.toThrow();
  await expect(
    reviewCounterBuySettlement(
      f.order,
      {
        ...simulation,
        balanceAssessment: {
          ...simulation.balanceAssessment,
          status: 'Mismatch',
        },
      },
      '6000000',
    ),
  ).rejects.toThrow();
});
