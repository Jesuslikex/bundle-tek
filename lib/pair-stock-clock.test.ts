import { expect, it, vi } from 'vitest';
import {
  pairQuoteClock,
  pairQuoteMint,
} from '../test/imported-pair-quote-fixture';
import {
  createStockPairEvidenceRpc,
  PAIR_CLOCK,
  pairClockUnixTimestamp,
} from './pair-stock-clock';
import { readPairMintEvidence } from './pair-mint-evidence';
import { SWAP_TOKEN } from './swap-token-program-evidence';

const now = 1792161668000;
const pair = {
  inputMint: 'So11111111111111111111111111111111111111112',
  outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
};
function setup(
  context = 100,
  delta = 0,
  disagree = false,
  unix = String(now / 1000),
) {
  const calls: { method: string; params: unknown[] }[] = [];
  const source = vi.fn(
    async (method: string, params: unknown[]): Promise<unknown> => {
      calls.push({ method, params });
      if (method !== 'getMultipleAccounts') return '100';
      let clocks = 0;
      const floor = (params[1] as { minContextSlot?: number })?.minContextSlot;
      return {
        context: {
          slot: String(
            (params[0] as string[]).includes(PAIR_CLOCK)
              ? context
              : (floor ?? context),
          ),
        },
        value: (params[0] as string[]).map((key) =>
          key === PAIR_CLOCK
            ? pairQuoteClock(
                context + delta + (disagree && clocks++ > 0 ? 1 : 0),
                unix,
              )
            : pairQuoteMint(key === pair.inputMint ? 9 : 6, SWAP_TOKEN),
        ),
      };
    },
  );
  const scope = createStockPairEvidenceRpc(source, source, () => now);
  return {
    scope,
    calls,
    source,
    read: () => readPairMintEvidence(pair, 100, scope.rpc, now),
  };
}
it.each([0, 1])(
  'accepts stock Clock delta %s, retains raw context, and records the effective slot',
  async (delta) => {
    const { scope, read, calls } = setup(100, delta);
    const evidence = await read();
    expect(evidence.slot).toBe(100 + delta);
    expect(evidence.clock).toEqual({
      contextSlot: 100,
      clockSlot: 100 + delta,
      slot: 100 + delta,
      relation: delta ? '+1' : 'equal',
      unixTimestamp: String(now / 1000),
    });
    expect(scope.observations).toEqual([evidence.clock]);
    expect(
      (calls[0].params[0] as string[]).filter((k) => k === PAIR_CLOCK),
    ).toHaveLength(2);
    await scope.rpc('getBlockHeight', [
      { commitment: 'confirmed', minContextSlot: 100 },
    ]);
    await scope.programRpc('getMultipleAccounts', [
      [pair.inputMint],
      {
        minContextSlot: 100,
        encoding: 'base64',
        dataSlice: { offset: 0, length: 45 },
      },
    ]);
    expect(calls[1].params[0]).toMatchObject({ minContextSlot: 100 + delta });
    expect(calls[2].params[1]).toMatchObject({ minContextSlot: 100 + delta });
  },
);
it('uses the later Clock slot for the exact 32-slot boundary', async () => {
  expect((await setup(131, 1).read()).slot).toBe(132);
  await expect(setup(132, 1).read()).rejects.toThrow('32-slot');
});
it.each([-1, 2])('refuses stock Clock delta %s', async (delta) => {
  await expect(setup(100, delta).read()).rejects.toThrow('clock');
});
it('refuses duplicate Clock disagreement even when each slot is individually allowed', async () => {
  await expect(setup(100, 0, true).read()).rejects.toThrow(
    'Duplicate stock Clock',
  );
});
it('retains the wall-time bound and keeps the unscoped reader exactly equal', async () => {
  await expect(
    setup(100, 1, false, String(now / 1000 - 31)).read(),
  ).rejects.toThrow('stale');
  const { source } = setup(100, 1);
  await expect(readPairMintEvidence(pair, 100, source, now)).rejects.toThrow(
    'clock',
  );
  expect(() =>
    pairClockUnixTimestamp(pairQuoteClock(101, String(now / 1000)), 100, now),
  ).toThrow('clock');
});
it('rejects a later non-Clock read below the promoted floor', async () => {
  const { scope, read, source } = setup(100, 1);
  await read();
  source.mockResolvedValueOnce({ context: { slot: '100' }, value: [] });
  await expect(
    scope.programRpc('getMultipleAccounts', [
      [pair.inputMint],
      { minContextSlot: 100 },
    ]),
  ).rejects.toThrow('requested floor');
});
