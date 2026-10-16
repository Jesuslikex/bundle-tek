import { afterEach, expect, it, vi } from 'vitest';
import {
  pairWalletFixture,
  pairWalletTokenAccount,
} from '../test/pair-wallet-fixture';
import {
  readPairWalletEvidence,
  readPartitionedPairWalletEvidence,
  assertStablePairWalletEvidence,
  pairAssociatedAddress,
} from './pair-wallet-evidence';
import { PAIR_CLOCK } from './pair-stock-clock';
import { PAIR_RENT } from './pair-rent-evidence';
import {
  pairQuoteClock,
  pairQuoteMint,
} from '../test/imported-pair-quote-fixture';
import { inspectPairMintAccount } from './pair-mint-evidence';
import { SWAP_TOKEN, SWAP_WRAPPED_SOL } from './swap-token-program-evidence';
let fixture: Awaited<ReturnType<typeof pairWalletFixture>> | undefined;
afterEach(() => {
  fixture?.close();
  fixture = undefined;
});
async function setup(quote?: 'SOL' | 'USDC') {
  const f = (fixture = await pairWalletFixture());
  if (quote) {
    const mintAddress =
      quote === 'SOL'
        ? SWAP_WRAPPED_SOL
        : 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    f.mints[0] = pairQuoteMint(quote === 'SOL' ? 9 : 6, SWAP_TOKEN);
    f.mintEvidence.mints[0] = await inspectPairMintAccount(
      f.mints[0],
      mintAddress,
    );
    f.atas[0] = await pairAssociatedAddress(f.mintEvidence.mints[0], f.wallet);
    f.accounts[0] = pairWalletTokenAccount(
      mintAddress,
      f.wallet,
      SWAP_TOKEN,
      '20000000',
    );
  }
  const ordinary = await readPairWalletEvidence(
    f.mintEvidence,
    f.wallet,
    f.rpc,
    f.clock.now,
  );
  const requested = f.rpc.mock.calls[0][1][0] as string[];
  const raw = (await f.rpc.mock.results[0].value) as {
    context: { slot: string };
    value: unknown[];
  };
  const table = new Map(requested.map((key, i) => [key, raw.value[i]]));
  const chainUnix = String(f.clock.now / 1000);
  let contextSlot = Number(raw.context.slot),
    delta = 0;
  const source = vi.fn(async (_method: string, params: unknown[]) => {
    const keys = params[0] as string[];
    expect(keys.length).toBeLessThanOrEqual(5);
    return {
      context: { slot: String(contextSlot) },
      value: keys.map((key) =>
        key === PAIR_CLOCK
          ? pairQuoteClock(contextSlot + delta, chainUnix)
          : structuredClone(table.get(key)),
      ),
    };
  });
  return {
    f,
    ordinary,
    source,
    table,
    setSlot: (slot: number, clockDelta = 0) => {
      contextSlot = slot;
      delta = clockDelta;
    },
    read: () =>
      readPartitionedPairWalletEvidence(
        f.mintEvidence,
        f.wallet,
        source,
        new AbortController().signal,
        () => f.clock.now,
      ),
  };
}
it('produces exactly the ordinary wallet evidence from retained same-context partitions', async () => {
  const f = await setup();
  const result = await f.read();
  expect(result.evidence).toEqual(f.ordinary);
  expect(result.partitions.requestKeys).toEqual(f.f.rpc.mock.calls[0][1][0]);
  expect(result.partitions.partitions).toHaveLength(2);
  expect(result.partitions.providerResponses).toHaveLength(2);
  expect(result.evidence.signingAllowed).toBe(false);
});
it.each(['SOL', 'USDC'] as const)(
  'preserves the complete %s and scaled-stock wallet evidence shape',
  async (quote) => {
    const f = await setup(quote);
    const result = await f.read();
    expect(result.evidence).toEqual(f.ordinary);
    expect(result.evidence.accounts[0].kind).toBe(
      quote === 'SOL' ? 'native-sol' : 'associated-token',
    );
    expect(result.evidence.accounts[1].amount).toBe('5');
    expect(result.partitions.requestKeys).toHaveLength(quote === 'SOL' ? 6 : 7);
    expect(result.partitions.observations).toHaveLength(2);
  },
);
it('uses the later +1 Clock slot and keeps both raw contexts and requested floor', async () => {
  const f = await setup();
  const floor = f.f.mintEvidence.slot;
  f.setSlot(floor, 1);
  const result = await f.read();
  expect(result.evidence.slot).toBe(floor + 1);
  expect(result.evidence.clock).toMatchObject({
    contextSlot: floor,
    clockSlot: floor + 1,
    relation: '+1',
  });
  expect(
    result.partitions.partitions.every(
      (p) => p.response.context.slot === String(floor),
    ),
  ).toBe(true);
  expect(result.partitions.requestedFloor).toBe(floor);
});
it('uses the effective Clock for the exact 32-slot boundary', async () => {
  const f = await setup();
  const floor = f.f.mintEvidence.slot;
  f.setSlot(floor + 31, 1);
  expect((await f.read()).evidence.slot).toBe(floor + 32);
  f.setSlot(floor + 32, 1);
  await expect(f.read()).rejects.toThrow('32-slot');
});
it('keeps a live wall clock while partition reads are pending', async () => {
  const f = await setup(),
    original = f.source.getMockImplementation()!;
  const release: (() => void)[] = [];
  let notifyStarted = () => {};
  const started = new Promise<void>((resolve) => {
    notifyStarted = resolve;
  });
  f.source.mockImplementation(async (method, params) => {
    await new Promise<void>((resolve) => {
      release.push(resolve);
      if (release.length === 2) notifyStarted();
    });
    return original(method, params);
  });
  const pending = f.read();
  // Wait for both actual reads to start, using a controlled signal rather than a real delay.
  await started;
  f.f.clock.now += 31000;
  for (const resolve of release) resolve();
  await expect(pending).rejects.toThrow('stale');
});
it.each(['missing-mint', 'wallet-owner', 'rent'] as const)(
  'keeps the ordinary %s account refusal',
  async (mode) => {
    const f = await setup();
    if (mode === 'missing-mint') f.table.set(f.f.baseMint, null);
    if (mode === 'rent') f.table.set(PAIR_RENT, null);
    if (mode === 'wallet-owner')
      f.table.set(f.f.wallet, {
        ...(f.table.get(f.f.wallet) as object),
        owner: PAIR_CLOCK,
      });
    await expect(f.read()).rejects.toThrow();
  },
);
it('retains a changed custody balance so the existing stability check refuses it', async () => {
  const f = await setup();
  f.table.set(f.f.wallet, {
    ...(f.table.get(f.f.wallet) as object),
    lamports: '999999999',
  });
  const result = await f.read();
  expect(result.evidence.nativeBalanceRaw).toBe('999999999');
  expect(() =>
    assertStablePairWalletEvidence(f.ordinary, result.evidence),
  ).toThrow();
});
