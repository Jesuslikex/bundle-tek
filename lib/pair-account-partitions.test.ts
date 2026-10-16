import { expect, it, vi } from 'vitest';
import { collectPairAccountPartitions } from './pair-account-partitions';
import { PAIR_CLOCK } from './pair-stock-clock';
import { pairQuoteClock } from '../test/imported-pair-quote-fixture';

const now = 1792161668000;
const keys = Array.from(
  { length: 6 },
  (_, i) => '1'.repeat(31) + String(i + 1),
);
const config = {
  encoding: 'base64',
  commitment: 'confirmed',
  minContextSlot: 100,
} as const;
function fixture(mode = 'ok') {
  let count = 0;
  const source = vi.fn(async (_method: string, params: unknown[]) => {
    const index = count++;
    const slot =
      mode === 'mixed-slot' && index ? 101 : mode === 'stale' ? 99 : 100;
    let clocks = 0;
    const value = (params[0] as string[]).map((key) =>
      key === PAIR_CLOCK
        ? pairQuoteClock(
            slot +
              (mode === 'plus-one'
                ? 1
                : mode === 'plus-two'
                  ? 2
                  : mode === 'disagree' && clocks++
                    ? 1
                    : 0),
            String(now / 1000 - (mode === 'cross-clock' && index ? 1 : 0)),
          )
        : {
            key,
            data: [mode === 'oversized' ? 'A'.repeat(140000) : '', 'base64'],
          },
    );
    if (mode === 'partial') value.pop();
    if (mode === 'provider-error' && index) throw Error('provider refused');
    return { context: { slot: String(slot) }, value };
  });
  return {
    source,
    run: (signal = new AbortController().signal) =>
      collectPairAccountPartitions(
        [...keys, PAIR_CLOCK],
        config,
        source,
        signal,
        () => now,
      ),
  };
}
it('retains actual responses, duplicate Clocks and positional scope in five-account calls', async () => {
  const f = fixture();
  const result = await f.run();
  expect(f.source).toHaveBeenCalledTimes(2);
  expect(f.source.mock.calls.map((call) => call[1][0])).toEqual([
    [...keys.slice(0, 3), PAIR_CLOCK, PAIR_CLOCK],
    [...keys.slice(3), PAIR_CLOCK, PAIR_CLOCK],
  ]);
  expect(result.partitions.map((p) => p.originalPositions)).toEqual([
    [0, 1, 2],
    [3, 4, 5],
  ]);
  expect(
    result.partitions.map((p) =>
      p.response.value.slice(0, -1).map((v) => (v as { key: string }).key),
    ),
  ).toEqual([keys.slice(0, 3), keys.slice(3)]);
  expect(result.observations).toHaveLength(2);
  expect(
    result.providerResponses.map(
      (r) => (r.params[0] as string[]).filter((k) => k === PAIR_CLOCK).length,
    ),
  ).toEqual([2, 2]);
  expect(
    result.providerResponses.every(
      (r) => (r.response as { value: unknown[] }).value.length === 5,
    ),
  ).toBe(true);
  expect(result).toMatchObject({
    requestKeys: [...keys, PAIR_CLOCK],
    signingAllowed: false,
    executionAllowed: false,
  });
});
it('records +1 effective slots without relabeling raw response contexts', async () => {
  const result = await fixture('plus-one').run();
  expect(
    result.partitions.every((p) => p.response.context.slot === '100'),
  ).toBe(true);
  expect(
    result.observations.every((o) => o.slot === 101 && o.relation === '+1'),
  ).toBe(true);
});
it.each([
  'mixed-slot',
  'cross-clock',
  'stale',
  'partial',
  'disagree',
  'plus-two',
  'provider-error',
  'oversized',
])('refuses %s without retry or partial publication', async (mode) => {
  const f = fixture(mode);
  await expect(f.run()).rejects.toThrow();
  expect(f.source).toHaveBeenCalledTimes(2);
});
it('refuses pre-cancellation without provider IO', async () => {
  const f = fixture();
  await expect(f.run(AbortSignal.abort())).rejects.toThrow();
  expect(f.source).not.toHaveBeenCalled();
});
it('preserves duplicate payload positions and copies the caller input', async () => {
  const f = fixture();
  const input = [keys[0], keys[0], keys[1], keys[2], PAIR_CLOCK];
  const result = await collectPairAccountPartitions(
    input,
    config,
    f.source,
    new AbortController().signal,
    () => now,
  );
  expect(result.partitions[0].accountKeys).toEqual([
    keys[0],
    keys[0],
    keys[1],
    PAIR_CLOCK,
  ]);
  input[0] = keys[5];
  expect(result.requestKeys[0]).toBe(keys[0]);
});
