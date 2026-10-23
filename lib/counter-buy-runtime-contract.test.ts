import { beforeEach, expect, it, vi } from 'vitest';
import { counterBuyRuntimeFixture } from '../test/counter-buy-runtime-fixture';
import type { CounterSimulationRpc } from './counter-buy-simulation';

const drift = vi.hoisted(() => ({ mode: 'baseline' }));
vi.mock('./counter-buy-simulation', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('./counter-buy-simulation')>();
  return {
    ...actual,
    simulateCounterBuyPreparation: async (
      ...args: Parameters<typeof actual.simulateCounterBuyPreparation>
    ) => {
      const [order, fee, signal, rpc, fetcher] = args;
      if (!rpc)
        throw Error('Contract fixture requires the actual runtime RPC wrapper');
      const intercepted: CounterSimulationRpc = async (method, params, s) => {
        if (method === 'getMinimumBalanceForRentExemption') {
          if (drift.mode === 'missing-rent') return '2039280';
          const result = await rpc(method, params, s);
          if (drift.mode === 'duplicate-rent') await rpc(method, params, s);
          return result;
        }
        if (method === 'simulateTransaction' && drift.mode !== 'baseline') {
          const changed = structuredClone(params),
            settings = changed[1] as Record<string, unknown>,
            accounts = settings.accounts as {
              encoding: string;
              addresses: string[];
              [key: string]: unknown;
            };
          if (drift.mode === 'length') changed.push('unexpected');
          if (drift.mode === 'packet') changed[0] = 'AAAA';
          if (drift.mode === 'encoding') settings.encoding = 'base58';
          if (drift.mode === 'commitment') settings.commitment = 'processed';
          if (drift.mode === 'sig-verify') settings.sigVerify = true;
          if (drift.mode === 'replace-blockhash')
            settings.replaceRecentBlockhash = true;
          if (drift.mode === 'inner-instructions')
            settings.innerInstructions = true;
          if (drift.mode === 'extra-setting') settings.unreviewedOption = true;
          if (drift.mode === 'floor-negative') settings.minContextSlot = -1;
          if (drift.mode === 'floor-fractional')
            settings.minContextSlot = 100.5;
          if (drift.mode === 'floor-below-quote') settings.minContextSlot = 99;
          if (drift.mode === 'accounts-order') accounts.addresses.reverse();
          if (drift.mode === 'accounts-address')
            accounts.addresses[0] =
              'So11111111111111111111111111111111111111112';
          if (drift.mode === 'accounts-duplicate')
            accounts.addresses[1] = accounts.addresses[0];
          if (drift.mode === 'accounts-sparse') {
            // Setting length creates holes, not explicit undefined entries.
            const sparse: string[] = [];
            sparse.length = accounts.addresses.length;
            accounts.addresses = sparse;
          }
          if (drift.mode === 'accounts-encoding') accounts.encoding = 'base58';
          if (drift.mode === 'accounts-extra') accounts.unreviewedOption = true;
          if (drift.mode === 'key-order')
            changed[1] = Object.fromEntries(
              Object.entries({
                ...settings,
                accounts: {
                  addresses: accounts.addresses,
                  encoding: accounts.encoding,
                },
              }).reverse(),
            );
          return rpc(method, changed, s);
        }
        return rpc(method, params, s);
      };
      const simulation = await actual.simulateCounterBuyPreparation(
        order,
        fee,
        signal,
        intercepted,
        fetcher,
      );
      if (drift.mode === 'late-rent')
        await rpc(
          'getMinimumBalanceForRentExemption',
          [165, { commitment: 'confirmed' }],
          signal,
        );
      return simulation;
    },
  };
});
import { collectCounterBuyRuntimeEvidence } from './counter-buy-runtime';

beforeEach(() => {
  drift.mode = 'baseline';
});
type Fixture = Awaited<ReturnType<typeof counterBuyRuntimeFixture>>;
const run = (f: Fixture) =>
  collectCounterBuyRuntimeEvidence(
    f.order,
    '6000000',
    new AbortController().signal,
    f.rpc,
    () => f.clock.now,
  );
const codeCalls = (f: Fixture) =>
  vi
    .mocked(f.rpc)
    .mock.calls.filter(
      ([method, params]) =>
        method === 'getMultipleAccounts' &&
        !!(params[1] as { dataSlice?: unknown })?.dataSlice,
    );
const rentCalls = (f: Fixture) =>
  vi
    .mocked(f.rpc)
    .mock.calls.filter(
      ([method]) => method === 'getMinimumBalanceForRentExemption',
    );

it('composes the unchanged real collector with exactly one original rent quote and one original-packet simulation', async () => {
  const f = await counterBuyRuntimeFixture(),
    result = await run(f);
  expect(result.simulation.sha256).toBe(f.order.preparation.sha256);
  expect(result.runtime.codeScanCount).toBe(2);
  expect(f.state.simulations).toBe(1);
  expect(rentCalls(f)).toHaveLength(1);
  const call = vi
    .mocked(f.rpc)
    .mock.calls.find(([method]) => method === 'simulateTransaction')!;
  expect(call[1]).toHaveLength(2);
  expect(call[1][0]).toBe(f.order.preparation.transaction);
  expect(call[1][1]).toMatchObject({
    encoding: 'base64',
    commitment: 'confirmed',
    sigVerify: false,
    replaceRecentBlockhash: false,
    innerInstructions: true,
    accounts: { encoding: 'base64', addresses: f.keys },
  });
  expect(result.runtime.signingAllowed).toBe(false);
  expect(result.runtime.executionAllowed).toBe(false);
});

it('accepts structurally identical simulation settings with a different JSON property order', async () => {
  drift.mode = 'key-order';
  const f = await counterBuyRuntimeFixture(),
    result = await run(f);
  expect(result.runtime.codeScanCount).toBe(2);
  expect(f.state.simulations).toBe(1);
  expect(rentCalls(f)).toHaveLength(1);
});

it.each([
  'length',
  'packet',
  'encoding',
  'commitment',
  'sig-verify',
  'replace-blockhash',
  'inner-instructions',
  'extra-setting',
  'floor-negative',
  'floor-fractional',
  'floor-below-quote',
  'accounts-order',
  'accounts-address',
  'accounts-duplicate',
  'accounts-sparse',
  'accounts-encoding',
  'accounts-extra',
])(
  'refuses real collector simulation contract drift: %s before code reads or actual simulation',
  async (mode) => {
    drift.mode = mode;
    const f = await counterBuyRuntimeFixture();
    await expect(run(f)).rejects.toThrow();
    expect(f.state.simulations).toBe(0);
    expect(codeCalls(f)).toHaveLength(0);
    expect(
      vi
        .mocked(f.rpc)
        .mock.calls.filter(([method]) => method === 'simulateTransaction'),
    ).toHaveLength(0);
  },
);

it.each(['missing-rent', 'duplicate-rent'])(
  'refuses %s from the real collector before code reads and actual simulation',
  async (mode) => {
    drift.mode = mode;
    const f = await counterBuyRuntimeFixture();
    await expect(run(f)).rejects.toThrow();
    expect(f.state.simulations).toBe(0);
    expect(codeCalls(f)).toHaveLength(0);
    expect(rentCalls(f)).toHaveLength(mode === 'missing-rent' ? 0 : 2);
  },
);
it('rejects a new rent quote after the real collector returns rather than publishing otherwise valid evidence', async () => {
  drift.mode = 'late-rent';
  const f = await counterBuyRuntimeFixture();
  await expect(run(f)).rejects.toThrow();
  expect(f.state.simulations).toBe(1);
  expect(codeCalls(f).length).toBeGreaterThan(0);
  expect(rentCalls(f)).toHaveLength(2);
});
