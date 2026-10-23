import { expect, it, vi } from 'vitest';
import { counterBuyRuntimeFixture } from '../test/counter-buy-runtime-fixture';
import { collectCounterBuyRuntimeEvidence } from './counter-buy-runtime';
import { reviewCounterBuySettlement } from './counter-buy-settlement';
import { PAIR_CLOCK } from './pair-mint-evidence';
import { pairQuoteClock } from '../test/imported-pair-quote-fixture';
import { pairRentAccount } from '../test/pair-rent-fixture';
import { PAIR_RENT } from './pair-rent-evidence';
import { budgetMint } from '../test/auto-buy-budget-fixture';

const signal = () => new AbortController().signal;
const run = (
  f: Awaited<ReturnType<typeof counterBuyRuntimeFixture>>,
  s = signal(),
) =>
  collectCounterBuyRuntimeEvidence(
    f.order,
    '6000000',
    s,
    f.rpc,
    () => f.clock.now,
  );
it('runs real ExactOut decoding and gross settlement with one original-packet simulation between both serial code scans', async () => {
  const f = await counterBuyRuntimeFixture(),
    original = structuredClone(f.order);
  const result = await run(f);
  expect(f.state.simulations).toBe(1);
  expect(f.order).toEqual(original);
  expect(result.codeScans[0]).toEqual(result.codeScans[1]);
  expect(result.runtime.codeScanCount).toBe(2);
  expect(result.runtime.programCodeAttested).toBe(false);
  expect(result.runtime.innerInstructionPolicyVerified).toBe(false);
  expect(result.simulation.sha256).toBe(f.order.preparation.sha256);
  const settlement = await reviewCounterBuySettlement(
    f.order,
    result.simulation,
    '6000000',
  );
  expect(settlement.actualInputRaw).toBe('1000000');
  const calls = vi.mocked(f.rpc).mock.calls;
  const index = calls.findIndex((c) => c[0] === 'simulateTransaction');
  expect(index).toBeGreaterThan(0);
  expect(calls[index][1][0]).toBe(original.preparation.transaction);
  expect(calls[index][1][1]).toMatchObject({
    sigVerify: false,
    replaceRecentBlockhash: false,
    innerInstructions: true,
  });
  expect(
    calls
      .slice(0, index)
      .some(
        (c) =>
          c[0] === 'getMultipleAccounts' &&
          !!(c[1][1] as { dataSlice?: unknown }).dataSlice,
      ),
  ).toBe(true);
  expect(
    calls
      .slice(index + 1)
      .some(
        (c) =>
          c[0] === 'getMultipleAccounts' &&
          !!(c[1][1] as { dataSlice?: unknown }).dataSlice,
      ),
  ).toBe(true);
  expect(
    calls.every(
      (c) =>
        !['sendTransaction', 'sendRawTransaction', 'requestAirdrop'].includes(
          c[0],
        ),
    ),
  ).toBe(true);
});

it('keeps full-byte code payloads serial even when the synthetic transport yields', async () => {
  const f = await counterBuyRuntimeFixture();
  let active = 0,
    maximum = 0,
    reads = 0;
  const result = await collectCounterBuyRuntimeEvidence(
    f.order,
    '6000000',
    signal(),
    async (method, params, s) => {
      const config = params[1] as
        | { dataSlice?: { length: number } }
        | undefined;
      const code =
        method === 'getMultipleAccounts' &&
        (config?.dataSlice?.length ?? 0) > 45;
      if (code) {
        active++;
        reads++;
        maximum = Math.max(maximum, active);
        await new Promise<void>((resolve) => setTimeout(resolve, 1));
      }
      try {
        return await f.rpc(method, params, s);
      } finally {
        if (code) active--;
      }
    },
    () => f.clock.now,
  );
  expect(reads).toBeGreaterThanOrEqual(2);
  expect(maximum).toBe(1);
  expect(result.runtime.codeScanCount).toBe(2);
  expect(f.state.simulations).toBe(1);
});
it('binds a separately selected mint and nondefault ExactOut target through real packet decoding and gross settlement', async () => {
  const f = await counterBuyRuntimeFixture({
    mint: budgetMint,
    tokenRaw: 3500n,
  });
  const result = await run(f);
  expect(f.order.quote.outputMint).toBe(budgetMint);
  expect(f.order.quote.outputTargetRaw).toBe('3500');
  const settlement = await reviewCounterBuySettlement(
    f.order,
    result.simulation,
    '6000000',
  );
  expect(settlement.actualInputRaw).toBe('1000000');
  expect(f.state.simulations).toBe(1);
  expect(result.runtime.signingAllowed).toBe(false);
});

it.each([99, 100] as const)(
  'preserves a genuine %i-account lookup scope through bounded identical-bank partitions',
  async (payloadCount) => {
    const f = await counterBuyRuntimeFixture({ lookup: true, payloadCount });
    expect(f.keys.length).toBe(payloadCount);
    const result = await run(f);
    expect(f.state.simulations).toBe(1);
    expect(result.simulation.originalBlockhashRetained).toBe(true);
    const simulationCall = vi
      .mocked(f.rpc)
      .mock.calls.find((c) => c[0] === 'simulateTransaction')!;
    expect(
      (simulationCall[1][1] as { accounts: { addresses: string[] } }).accounts
        .addresses,
    ).toEqual(f.keys);
    const calls = vi
      .mocked(f.rpc)
      .mock.calls.filter((c) => c[0] === 'getMultipleAccounts');
    expect(calls.every((c) => (c[1][0] as string[]).length <= 100)).toBe(true);
    expect(calls.some((c) => (c[1][0] as string[]).length === 100)).toBe(true);
    expect(
      calls.some((c) => (c[1][0] as string[]).includes(f.keys.at(-1)!)),
    ).toBe(true);
  },
);
it.each(['context', 'clock', 'rent'] as const)(
  'refuses mismatched %s between real 100-account partition pieces without retries',
  async (kind) => {
    const f = await counterBuyRuntimeFixture({
      lookup: true,
      payloadCount: 100,
    });
    let mutated = 0;
    f.state.onResult = (method, result, params) => {
      const keys = params[0] as string[];
      if (
        method === 'getMultipleAccounts' &&
        keys.includes(f.keys.at(-1)!) &&
        keys.length < 100
      ) {
        mutated++;
        const response = result as {
          context: { slot: string };
          value: unknown[];
        };
        if (kind === 'context') response.context.slot = '101';
        else if (kind === 'clock')
          keys.forEach((key, i) => {
            if (key === PAIR_CLOCK)
              response.value[i] = pairQuoteClock(
                100,
                String(Math.floor(f.clock.now / 1000) - 1),
              );
          });
        else
          response.value[keys.indexOf(PAIR_RENT)] = pairRentAccount(3481n, 2);
      }
      return result;
    };
    await expect(run(f)).rejects.toThrow();
    expect(mutated).toBe(1);
    expect(f.state.simulations).toBe(0);
  },
);
it('includes upgrade authority in both actual full scans and refuses a changed final authority', async () => {
  const stable = await counterBuyRuntimeFixture();
  stable.upgrade(stable.programKeys.find((k) => k.startsWith('JUP'))!);
  await expect(run(stable)).resolves.toBeDefined();
  expect(stable.state.simulations).toBe(1);
  const f = await counterBuyRuntimeFixture();
  const { deployment } = f.upgrade(
    f.programKeys.find((k) => k.startsWith('JUP'))!,
  );
  f.state.onResult = (method, result) => {
    if (method === 'simulateTransaction') {
      const bytes = Buffer.from(deployment.data[0], 'base64');
      bytes[13] ^= 1;
      deployment.data[0] = bytes.toString('base64');
    }
    return result;
  };
  await expect(run(f)).rejects.toThrow();
  expect(f.state.simulations).toBe(1);
});

it.each([1, -1])(
  'refuses ordinary Clock offset %i rather than adopting the stock exception',
  async (delta) => {
    const f = await counterBuyRuntimeFixture();
    f.state.clockDelta = delta;
    await expect(run(f)).rejects.toThrow();
    expect(f.state.simulations).toBe(0);
  },
);
it.each([31, -31])('refuses Clock wall-time skew %is', async (delta) => {
  const f = await counterBuyRuntimeFixture();
  f.state.clockUnixDelta = delta;
  await expect(run(f)).rejects.toThrow();
  expect(f.state.simulations).toBe(0);
});
it('refuses contradictory duplicate Clocks in one actual response', async () => {
  const f = await counterBuyRuntimeFixture();
  f.state.onResult = (method, result, params) => {
    if (method === 'getMultipleAccounts') {
      const keys = params[0] as string[],
        indices = keys.flatMap((k, i) => (k === PAIR_CLOCK ? [i] : []));
      if (indices.length === 2)
        (result as { value: unknown[] }).value[indices[1]] = pairQuoteClock(
          100,
          String(Math.floor(f.clock.now / 1000) - 1),
        );
    }
    return result;
  };
  await expect(run(f)).rejects.toThrow();
  expect(f.state.simulations).toBe(0);
});
it('refuses wrong network before simulation', async () => {
  const f = await counterBuyRuntimeFixture();
  f.state.onResult = (method, result) =>
    method === 'getGenesisHash' ? 'wrong-network' : result;
  await expect(run(f)).rejects.toThrow();
  expect(f.state.simulations).toBe(0);
});
it('refuses a backwards context even with otherwise valid Clock data', async () => {
  const f = await counterBuyRuntimeFixture();
  f.state.onResult = (method, result) => {
    if (method === 'getMultipleAccounts')
      (result as { context: { slot: string } }).context.slot = '99';
    return result;
  };
  await expect(run(f)).rejects.toThrow();
  expect(f.state.simulations).toBe(0);
});
it('refuses 33 slots from the original quote without refreshing the baseline', async () => {
  const f = await counterBuyRuntimeFixture();
  f.state.slot = 133;
  await expect(run(f)).rejects.toThrow();
  expect(f.state.simulations).toBe(0);
});
it('accepts the exact 32-slot and 30-second Clock boundaries without expanding either bound', async () => {
  const f = await counterBuyRuntimeFixture();
  f.state.slot = 132;
  f.state.clockUnixDelta = -30;
  const result = await run(f);
  expect(result.runtime.maximumSlot - result.runtime.minimumSlot).toBe(32);
  expect(f.state.simulations).toBe(1);
  expect(result.runtime.signingAllowed).toBe(false);
  expect(result.runtime.executionAllowed).toBe(false);
  expect(result.runtime.semanticAuditEstablished).toBe(false);
});
it('refuses a missing top-level executable before any simulation', async () => {
  const f = await counterBuyRuntimeFixture();
  f.accounts.delete(f.programKeys.find((k) => k.startsWith('JUP'))!);
  await expect(run(f)).rejects.toThrow();
  expect(f.state.simulations).toBe(0);
});
it.each(['code', 'compute', 'custody', 'missing-program'] as const)(
  'refuses final %s mutation after exactly one simulation',
  async (kind) => {
    const f = await counterBuyRuntimeFixture();
    f.state.onResult = (method, result) => {
      if (method === 'simulateTransaction') {
        if (kind === 'custody') {
          const a = f.accounts.get(f.keys[0]) as { lamports: string };
          a.lamports = String(BigInt(a.lamports) - 1n);
        } else {
          const key =
            kind === 'compute'
              ? 'ComputeBudget111111111111111111111111111111'
              : f.programKeys.find((k) => k.startsWith('JUP'))!;
          if (kind === 'missing-program') f.accounts.delete(key);
          else {
            const a = f.programs.get(key)!;
            const bytes = Buffer.from(a.data[0], 'base64');
            a.data[0] = (
              kind === 'compute'
                ? Buffer.from([2])
                : Buffer.from([
                    ...bytes.subarray(0, 5),
                    99,
                    ...bytes.subarray(6),
                  ])
            ).toString('base64');
            f.accounts.set(key, a);
          }
        }
      }
      return result;
    };
    await expect(run(f)).rejects.toThrow();
    expect(f.state.simulations).toBe(1);
  },
);
it.each(['missing', 'unknown-program'] as const)(
  'refuses %s inner trace coverage',
  async (kind) => {
    const f = await counterBuyRuntimeFixture();
    f.state.onResult = (method, result) => {
      if (method === 'simulateTransaction') {
        const value = (result as { value: { innerInstructions: unknown } })
          .value;
        if (kind === 'missing')
          delete (value as { innerInstructions?: unknown }).innerInstructions;
        else
          value.innerInstructions = [
            {
              index: '0',
              instructions: [
                {
                  programId: PAIR_CLOCK,
                  stackHeight: '2',
                  accounts: [],
                  data: '',
                },
              ],
            },
          ];
      }
      return result;
    };
    await expect(run(f)).rejects.toThrow();
    expect(f.state.simulations).toBe(1);
  },
);
it('uses actual lookup evidence and refuses a changed final table', async () => {
  const f = await counterBuyRuntimeFixture({ lookup: true });
  f.state.onResult = (method, result) => {
    if (method === 'simulateTransaction') {
      const key = String(f.message.addressTableLookups![0].lookupTableAddress),
        a = f.accounts.get(key) as { data: string[] };
      const b = Buffer.from(a.data[0], 'base64');
      b[56] ^= 1;
      a.data[0] = b.toString('base64');
    }
    return result;
  };
  await expect(run(f)).rejects.toThrow();
  expect(f.state.simulations).toBe(1);
});
it('rejects expiry and cancellation without simulation or automatic retry', async () => {
  const f = await counterBuyRuntimeFixture();
  f.order.expiresAt = new Date(Date.now() - 1).toISOString();
  await expect(run(f)).rejects.toThrow();
  expect(f.state.simulations).toBe(0);
  const c = await counterBuyRuntimeFixture(),
    controller = new AbortController();
  c.state.onRequest = () => controller.abort();
  await expect(run(c, controller.signal)).rejects.toThrow();
  expect(c.state.simulations).toBe(0);
});
it('propagates a provider 429 without an automatic read loop', async () => {
  const f = await counterBuyRuntimeFixture();
  let calls = 0;
  f.state.onRequest = () => {
    calls++;
    throw Error('429 rate limited');
  };
  await expect(run(f)).rejects.toThrow();
  expect(calls).toBe(1);
  expect(f.state.simulations).toBe(0);
});
