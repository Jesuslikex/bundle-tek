import { expect, it, vi } from 'vitest';
import bs58 from 'bs58';
import {
  readPairOrderState,
  readPartitionedPairOrderState,
} from './pair-order-state';
import { readPairPartitionObservation } from './pair-partition-observation';
import { PAIR_CLOCK } from './pair-mint-evidence';
import { PAIR_RENT } from './pair-rent-evidence';
import { pairRentAccount } from '../test/pair-rent-fixture';
import {
  pairQuoteClock,
  pairQuoteMint,
} from '../test/imported-pair-quote-fixture';
import { pairWalletTokenAccount } from '../test/pair-wallet-fixture';
import { SWAP_TOKEN, SWAP_TOKEN_2022 } from './swap-token-program-evidence';
const key = (i: number) => bs58.encode(new Uint8Array(32).fill(i));
function fixture() {
  const clock = Math.floor(Date.now() / 1000) * 1000,
    accounts = [key(1), key(2), key(3), key(4)],
    mints: [string, string] = [key(5), key(6)],
    auxiliary = [key(7)];
  const values = new Map<string, unknown>([
    [
      accounts[0],
      {
        owner: '11111111111111111111111111111111',
        executable: false,
        lamports: '10000000',
        data: ['', 'base64'],
      },
    ],
    [
      accounts[1],
      pairWalletTokenAccount(mints[0], accounts[0], SWAP_TOKEN, '100'),
    ],
    [
      accounts[2],
      pairWalletTokenAccount(mints[1], accounts[0], SWAP_TOKEN_2022, '200'),
    ],
    [
      accounts[3],
      pairWalletTokenAccount(auxiliary[0], accounts[0], SWAP_TOKEN, '300'),
    ],
    [mints[0], pairQuoteMint(6, SWAP_TOKEN)],
    [mints[1], pairQuoteMint(8, SWAP_TOKEN_2022)],
    [auxiliary[0], pairQuoteMint(6, SWAP_TOKEN)],
    [PAIR_CLOCK, pairQuoteClock(100, String(clock / 1000))],
    [PAIR_RENT, pairRentAccount()],
  ]);
  const response = {
    context: { slot: '100' as unknown },
    value: [...accounts, ...mints, ...auxiliary, PAIR_RENT, PAIR_CLOCK].map(
      (k) => structuredClone(values.get(k)),
    ),
  };
  const rpc = vi.fn(async (_method: string, _params: unknown[]) => response);
  const run = () =>
    readPairOrderState(accounts, mints, auxiliary, 100, rpc, () => clock);
  return { clock, accounts, mints, auxiliary, values, response, rpc, run };
}
function partitionFixture(mode = 'ok') {
  const f = fixture();
  let calls = 0;
  const rpc = vi.fn(async (_method: string, params: unknown[]) => {
    const keys = params[0] as string[];
    expect(keys.length).toBeLessThanOrEqual(5);
    const index = calls++,
      slot =
        mode === 'mixed' && index === 1
          ? 101
          : mode === 'stale'
            ? 99
            : mode === 'boundary'
              ? 131
              : mode === 'span'
                ? 132
                : 100;
    const delta = ['plus-one', 'boundary', 'span'].includes(mode) ? 1 : 0;
    const value = keys.map((key) =>
      key === PAIR_CLOCK
        ? pairQuoteClock(slot + delta, String(f.clock / 1000))
        : structuredClone(f.values.get(key)),
    );
    if (mode === 'partial' && index === 1) value.pop();
    if (mode === 'missing-mint' && keys.includes(f.mints[0]))
      value[keys.indexOf(f.mints[0])] = null;
    if (mode === 'missing-rent' && keys.includes(PAIR_RENT))
      value[keys.indexOf(PAIR_RENT)] = null;
    return { context: { slot: String(slot) }, value };
  });
  return {
    ...f,
    partitionRpc: rpc,
    partitionRead: () =>
      readPartitionedPairOrderState(
        f.accounts,
        f.mints,
        f.auxiliary,
        100,
        rpc,
        new AbortController().signal,
        () => f.clock,
      ),
  };
}
it('matches every ordinary order-state account, mint, auxiliary, Rent and Clock with explicit partitions', async () => {
  const f = partitionFixture();
  const original = await f.run(),
    result = await f.partitionRead();
  expect(result.state).toEqual(original);
  expect(result.partitions.partitions).toHaveLength(3);
  expect(result.partitions.providerResponses).toHaveLength(3);
  expect(
    f.partitionRpc.mock.calls.every(
      (call) =>
        (call[1][0] as string[]).filter((key) => key === PAIR_CLOCK).length ===
        2,
    ),
  ).toBe(true);
});
it.each(['plus-one', 'boundary'])(
  'retains the effective Clock and raw contexts for %s state evidence',
  async (mode) => {
    const f = partitionFixture(mode),
      result = await f.partitionRead();
    expect(result.state.slot).toBe(mode === 'boundary' ? 132 : 101);
    expect(result.state.clock.relation).toBe('+1');
    expect(
      result.partitions.partitions.every(
        (p) =>
          p.response.context.slot === String(mode === 'boundary' ? 131 : 100),
      ),
    ).toBe(true);
  },
);
it.each(['mixed', 'stale', 'span', 'partial', 'missing-mint', 'missing-rent'])(
  'refuses %s order-state partitions',
  async (mode) => {
    const f = partitionFixture(mode);
    await expect(f.partitionRead()).rejects.toThrow();
  },
);
it('returns requested values and real Clock receipts for full-state keys that do not include Clock', async () => {
  const f = partitionFixture(),
    keys = [...f.accounts, PAIR_RENT];
  const result = await readPairPartitionObservation(
    keys,
    100,
    f.partitionRpc,
    new AbortController().signal,
    () => f.clock,
  );
  expect(result.values).toEqual(keys.map((key) => f.values.get(key)));
  expect(result.values).toHaveLength(keys.length);
  expect(result.clockResponse.value.at(-1)).toEqual(f.values.get(PAIR_CLOCK));
  expect(result.partitions.requestKeys).toEqual([...keys, PAIR_CLOCK]);
});
it('reads all protected accounts, mint policies and Clock in one exact bounded confirmed response', async () => {
  const f = fixture(),
    r = await f.run();
  expect(f.rpc).toHaveBeenCalledExactlyOnceWith('getMultipleAccounts', [
    [...f.accounts, ...f.mints, ...f.auxiliary, PAIR_RENT, PAIR_CLOCK],
    { encoding: 'base64', commitment: 'confirmed', minContextSlot: 100 },
  ]);
  expect(r.slot).toBe(100);
  expect(r.unixTimestamp).toBe(String(f.clock / 1000));
  expect(r.accounts.map((a) => a.address)).toEqual(f.accounts);
  expect(r.mints.mints.map((m) => m.address)).toEqual(f.mints);
  expect(r.auxiliaryMints?.mints[0].address).toBe(f.auxiliary[0]);
});
it('preserves missing setup accounts without treating them as missing mint policies', async () => {
  const f = fixture();
  f.response.value[3] = null;
  expect((await f.run()).accounts[3].raw).toBeNull();
});
it.each([
  'numeric-slot',
  'backwards',
  'too-old',
  'short',
  'long',
  'hole',
  'missing-mint',
  'wrong-mint-owner',
  'wrong-clock-bank',
  'stale-clock',
  'missing-rent',
] as const)('rejects a coalesced response with %s', async (mode) => {
  const f = fixture();
  if (mode === 'numeric-slot') f.response.context.slot = 100;
  if (mode === 'backwards') f.response.context.slot = '99';
  if (mode === 'too-old') f.response.context.slot = '133';
  if (mode === 'short') f.response.value.pop();
  if (mode === 'long') f.response.value.push(null);
  if (mode === 'hole') f.response.value[2] = undefined;
  if (mode === 'missing-mint') f.response.value[4] = null;
  if (mode === 'missing-rent') f.response.value[7] = null;
  if (mode === 'wrong-mint-owner')
    f.response.value[4] = pairQuoteMint(6, '11111111111111111111111111111111');
  if (mode === 'wrong-clock-bank')
    f.response.value[8] = pairQuoteClock(101, String(f.clock / 1000));
  if (mode === 'stale-clock')
    f.response.value[8] = pairQuoteClock(100, String(f.clock / 1000 - 31));
  await expect(f.run()).rejects.toThrow();
});
it('admits exactly 32 slots only when the response Clock names the same bank', async () => {
  const f = fixture();
  f.response.context.slot = '132';
  f.response.value[8] = pairQuoteClock(132, String(f.clock / 1000));
  expect((await f.run()).slot).toBe(132);
});
it.each([
  'overlap',
  'duplicate-mint',
  'clock-key',
  'rent-key',
  'too-many',
  'too-few',
  'invalid-floor',
] as const)('refuses %s before invoking RPC', async (mode) => {
  const f = fixture();
  let floor = 100;
  if (mode === 'overlap') f.accounts[1] = f.mints[0];
  if (mode === 'duplicate-mint') f.auxiliary[0] = f.mints[0];
  if (mode === 'clock-key') f.accounts[1] = PAIR_CLOCK;
  if (mode === 'rent-key') f.accounts[1] = PAIR_RENT;
  if (mode === 'too-many')
    f.accounts.push(...Array.from({ length: 8 }, (_, i) => key(i + 20)));
  if (mode === 'too-few') f.accounts.splice(0, 2);
  if (mode === 'invalid-floor') floor = Number.MAX_SAFE_INTEGER;
  await expect(
    readPairOrderState(
      f.accounts,
      f.mints,
      f.auxiliary,
      floor,
      f.rpc,
      () => f.clock,
    ),
  ).rejects.toThrow();
  expect(f.rpc).not.toHaveBeenCalled();
});
it('freezes the requested mapping while an asynchronous provider read is pending', async () => {
  const f = fixture(),
    expected = [...f.accounts];
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.rpc.mockImplementation(async () => {
    await gate;
    return f.response;
  });
  const pending = f.run();
  f.accounts.push(key(90));
  f.mints[0] = key(91);
  f.auxiliary.splice(0);
  release();
  const r = await pending;
  expect(r.accounts.map((a) => a.address)).toEqual(expected);
  expect(r.mints.mints[0].address).toBe(key(5));
  expect(r.auxiliaryMints?.mints[0].address).toBe(key(7));
});
