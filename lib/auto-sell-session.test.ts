import { expect, it, vi } from 'vitest';
import { newAutoSellStrategy } from './auto-sell';
import { AutoSellRunner, type AutoSellRunnerDeps } from './auto-sell-runner';
import {
  autoSellSessionCap,
  autoSellSessionError,
  type AutoSellSessionRules,
} from './auto-sell-session';
import { AutoSellUncertainError } from './auto-sell-execute';

const defaults = {
  startDelaySeconds: 0,
  endDurationSeconds: 0,
  endMaxSupplyPercent: '',
};
function fixture(
  session: Partial<AutoSellSessionRules> = {},
  sell = vi.fn(async (amount: bigint, _signal: AbortSignal) => ({
    soldRaw: amount,
    signature: 'FIXTURE',
    wallet: 'FIXTURE',
  })),
  readTrades: AutoSellRunnerDeps['readTrades'] = async () => [],
) {
  let time = 0;
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const strategy = (id: string) => ({
    ...newAutoSellStrategy(0),
    id,
    mode: 'dca' as const,
    dcaAmount: '60',
    dcaIntervalSeconds: 10,
  });
  const runner = new AutoSellRunner({
    strategies: [strategy('a'), strategy('b')],
    decimals: 0,
    totalSupplyRaw: 1000n,
    ownWallets: new Set(),
    session: { ...defaults, ...session },
    readTrades,
    sell,
    onUpdate: () => {},
    now: () => time,
    setTimer: (fn, ms) => {
      const t = { fn, ms };
      timers.push(t);
      return t;
    },
    clearTimer: () => {},
  });
  return {
    runner,
    sell,
    timers,
    time: (value: number) => {
      time = value;
    },
  };
}
const flush = async () => {
  for (let n = 0; n < 12; n++) await Promise.resolve();
};

it('validates optional session bounds without coercing invalid edits', () => {
  expect(autoSellSessionError(defaults)).toBe('');
  for (const rules of [
    { startDelaySeconds: -1 },
    { startDelaySeconds: 0.5 },
    { endDurationSeconds: 86401 },
    { endMaxSupplyPercent: '0' },
    { endMaxSupplyPercent: '100.1' },
    { endMaxSupplyPercent: 'NaN' },
  ])
    expect(autoSellSessionError({ ...defaults, ...rules })).not.toBe('');
  expect(
    autoSellSessionCap({ ...defaults, endMaxSupplyPercent: '10' }, 1000n),
  ).toBe(100n);
  expect(() =>
    autoSellSessionCap({ ...defaults, endMaxSupplyPercent: '0.000001' }, 1n),
  ).toThrow('smaller than one');
});
it('delays every strategy until the approved start, then starts DCA', async () => {
  const t = fixture({ startDelaySeconds: 10 });
  t.runner.start();
  await flush();
  expect(t.sell).not.toHaveBeenCalled();
  t.time(9999);
  await t.runner.tick();
  await flush();
  expect(t.sell).not.toHaveBeenCalled();
  t.time(10000);
  await t.runner.tick();
  await flush();
  expect(t.sell).toHaveBeenCalled();
  t.runner.stop();
});
it('shares one exact maximum across strategies instead of granting each a full cap', async () => {
  const t = fixture({ endMaxSupplyPercent: '100' });
  t.runner.start();
  await flush();
  expect(t.sell.mock.calls.map((call) => call[0])).toEqual([600n, 400n]);
  expect(t.runner.isRunning()).toBe(false);
  expect(
    Object.values(t.runner.snapshot().states).reduce(
      (sum, s) => sum + s.soldRaw,
      0n,
    ),
  ).toBe(1000n);
});
it('reserves an in-flight tail without aborting it or scheduling a second sell', async () => {
  let resolve!: (value: {
    soldRaw: bigint;
    signature: string;
    wallet: string;
  }) => void;
  const sell = vi.fn(
    (_amount: bigint, _signal: AbortSignal) =>
      new Promise<{ soldRaw: bigint; signature: string; wallet: string }>(
        (r) => {
          resolve = r;
        },
      ),
  );
  const t = fixture({ endMaxSupplyPercent: '50' }, sell);
  t.runner.start();
  await flush();
  expect(sell).toHaveBeenCalledWith(500n, expect.any(AbortSignal));
  await t.runner.tick();
  expect(t.runner.isRunning()).toBe(true);
  expect(sell).toHaveBeenCalledTimes(1);
  expect(sell.mock.calls[0][1].aborted).toBe(false);
  resolve({ soldRaw: 500n, signature: 'FIXTURE', wallet: 'FIXTURE' });
  await flush();
  expect(t.runner.isRunning()).toBe(false);
});
it('counts an uncertain send against the shared cap and never resells it', async () => {
  const sell = vi.fn(async (_amount: bigint, _signal: AbortSignal) => {
    throw new AutoSellUncertainError('Unknown outcome.', 'FIXTURE', 'FIXTURE');
  });
  const t = fixture({ endMaxSupplyPercent: '50' }, sell);
  t.runner.start();
  await flush();
  expect(t.runner.isRunning()).toBe(false);
  expect(sell).toHaveBeenCalledTimes(1);
});
it('stops the entire session at its own deadline, even with a pending feed', async () => {
  const t = fixture(
    { startDelaySeconds: 5, endDurationSeconds: 10 },
    undefined,
    async () => new Promise(() => {}),
  );
  t.runner.start();
  await flush();
  const deadline = t.timers.find((timer) => timer.ms === 15000)!;
  expect(deadline).toBeTruthy();
  t.time(15000);
  deadline.fn();
  await t.runner.tick();
  expect(t.runner.isRunning()).toBe(false);
  expect(t.sell).not.toHaveBeenCalled();
});
