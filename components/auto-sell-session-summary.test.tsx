import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import {
  initialAutoSellState,
  newAutoSellStrategy,
  type AutoSellObservedTrade,
} from '@/lib/auto-sell';
import { AutoSellRunner, type AutoSellSnapshot } from '@/lib/auto-sell-runner';
import { AutoSellSessionSummary } from './auto-sell-session-summary';
vi.stubGlobal('React', React);
const view = (snapshot: AutoSellSnapshot, decimals = 6) =>
  renderToStaticMarkup(
    <AutoSellSessionSummary snapshot={snapshot} decimals={decimals} />,
  );
const snapshot = (patch: Partial<AutoSellSnapshot> = {}): AutoSellSnapshot => ({
  running: true,
  paused: false,
  settling: false,
  configurationRevision: 1,
  accountedRaw: 9007199254740993n,
  marketCapUsd: null,
  selling: false,
  log: [],
  states: {
    a: {
      ...initialAutoSellState(0),
      inRange: true,
      bufferedRaw: 2000000n,
      inFlightRaw: 3000000n,
      soldRaw: 4000000n,
    },
  },
  ...patch,
});
it('uses the original accounted total instead of reconstructing active states, and separates queue from in-flight', () => {
  const html = view(snapshot());
  expect(html).toContain('9007199254.740993');
  expect(html).toContain('<dt>Queued tokens</dt><dd>2</dd>');
  expect(html).toContain('<dt>In-progress tokens</dt><dd>3</dd>');
  expect(html).toContain('submitted or unknown transactions');
  expect(html).toContain('not finalized sales');
  expect(html).not.toContain('<button');
  expect(html).not.toContain('Sold ');
});
it.each([
  [true, false, 'Running in this tab'],
  [true, true, 'Paused'],
  [false, false, 'Not running'],
] as const)(
  'keeps session status independent of pending transaction outcomes (%s/%s)',
  (running, paused, label) => {
    const html = view(snapshot({ running, paused }));
    expect(html).toContain(label + ' · transaction in progress');
    expect(html).toContain('cannot reverse an already submitted transaction');
  },
);
it('keeps empty and ended counts separate from sales or successful completion', () => {
  expect(view(snapshot({ states: {}, accountedRaw: 0n }))).toContain(
    '<dt>Strategies ended (this run)</dt><dd>0 / 0</dd>',
  );
  const state = {
    ...initialAutoSellState(0),
    status: 'ended' as const,
    inRange: false,
  };
  const html = view(
    snapshot({ states: { a: state }, accountedRaw: 0n, running: false }),
  );
  expect(html).toContain('<dt>Strategies ended (this run)</dt><dd>1 / 1</dd>');
  expect(html).not.toContain('transaction in progress');
  expect(html).not.toContain('completed successfully');
});
it.each([
  'negative-accounted',
  'negative-queue',
  'negative-flight',
  'decimals',
  'capacity',
] as const)('withholds malformed counter display: %s', (kind) => {
  const s = snapshot();
  if (kind === 'negative-accounted') s.accountedRaw = -1n;
  if (kind === 'negative-queue') s.states.a.bufferedRaw = -1n;
  if (kind === 'negative-flight') s.states.a.inFlightRaw = -1n;
  if (kind === 'capacity')
    for (let i = 0; i < 5; i++) s.states['extra' + i] = { ...s.states.a };
  const html = view(s, kind === 'decimals' ? 19 : 6);
  expect(html).toContain('role="alert"');
  expect(html).not.toContain('<dl');
});
const flush = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};
it('renders an actual runner uncertain outcome as accounted instead of finalized sales', async () => {
  let trades: AutoSellObservedTrade[] = [];
  const runner = new AutoSellRunner({
    strategies: [
      { ...newAutoSellStrategy(0), id: 'a', replicationPercent: '50' },
    ],
    decimals: 6,
    totalSupplyRaw: 1000000000000n,
    ownWallets: new Set(),
    readTrades: async () => trades,
    sell: async () => {
      throw Object.assign(Error('synthetic outcome unknown'), {
        uncertain: true,
      });
    },
    now: () => 0,
    random: () => 0,
    setTimer: () => null,
    clearTimer: () => {},
    onUpdate: () => {},
  });
  try {
    runner.start();
    await flush();
    trades = [
      {
        id: 'synthetic-buy',
        sender: 'OUTSIDE',
        side: 'Buy',
        tokenAmount: '10',
        quoteAmount: '1',
        priceUsd: '1',
        timestamp: new Date(0).toISOString(),
      },
    ];
    await runner.tick();
    await flush();
    const result = runner.snapshot();
    expect(result.states.a.soldRaw).toBe(5000000n);
    expect(result.log.some((entry) => entry.kind === 'error')).toBe(true);
    const html = view(result);
    expect(html).toContain('<dt>Accounted tokens</dt><dd>5</dd>');
    expect(html).toContain('<dt>In-progress tokens</dt><dd>0</dd>');
    expect(html).toContain('unknown transactions');
    expect(html).not.toContain('Sold ');
    expect(runner.pause()).toBe(true);
    const configuration = runner.configuration();
    configuration.strategies = [
      { ...configuration.strategies[0], id: 'replacement' },
    ];
    runner.applyEdit(runner.reviewEdit(configuration).reviewKey, true);
    const retired = runner.snapshot();
    expect(retired.states.a).toBeUndefined();
    expect(retired.states.replacement.soldRaw).toBe(0n);
    expect(retired.accountedRaw).toBe(5000000n);
    expect(view(retired)).toContain('<dt>Accounted tokens</dt><dd>5</dd>');
  } finally {
    runner.stop();
  }
});

it('keeps actual in-flight work visible after Stop until its injected outcome settles', async () => {
  let trades: AutoSellObservedTrade[] = [];
  let settle!: (v: {
    soldRaw: bigint;
    signature: string;
    wallet: string;
  }) => void;
  const runner = new AutoSellRunner({
    strategies: [
      { ...newAutoSellStrategy(0), id: 'a', replicationPercent: '50' },
    ],
    decimals: 6,
    totalSupplyRaw: 1000000000000n,
    ownWallets: new Set(),
    readTrades: async () => trades,
    sell: () =>
      new Promise((resolve) => {
        settle = resolve;
      }),
    now: () => 0,
    random: () => 0,
    setTimer: () => null,
    clearTimer: () => {},
    onUpdate: () => {},
  });
  try {
    runner.start();
    await flush();
    trades = [
      {
        id: 'synthetic-buy',
        sender: 'OUTSIDE',
        side: 'Buy',
        tokenAmount: '10',
        quoteAmount: '1',
        priceUsd: '1',
        timestamp: new Date(0).toISOString(),
      },
    ];
    await runner.tick();
    await flush();
    expect(view(runner.snapshot())).toContain(
      '<dt>In-progress tokens</dt><dd>5</dd>',
    );
    runner.stop();
    const stopped = view(runner.snapshot());
    expect(stopped).toContain('Not running · transaction in progress');
    expect(stopped).toContain(
      'cannot reverse an already submitted transaction',
    );
    settle({ soldRaw: 5000000n, signature: 'synthetic', wallet: 'synthetic' });
    await flush();
    const result = view(runner.snapshot());
    expect(result).toContain('<dt>Accounted tokens</dt><dd>5</dd>');
    expect(result).toContain('<dt>In-progress tokens</dt><dd>0</dd>');
  } finally {
    runner.stop();
  }
});

it('clears actual aborted-before-send work after Stop without claiming it sold', async () => {
  let trades: AutoSellObservedTrade[] = [];
  let refuse!: (reason: Error) => void;
  const runner = new AutoSellRunner({
    strategies: [
      { ...newAutoSellStrategy(0), id: 'a', replicationPercent: '50' },
    ],
    decimals: 6,
    totalSupplyRaw: 1000000000000n,
    ownWallets: new Set(),
    readTrades: async () => trades,
    sell: () =>
      new Promise((_resolve, reject) => {
        refuse = reject;
      }),
    now: () => 0,
    random: () => 0,
    setTimer: () => null,
    clearTimer: () => {},
    onUpdate: () => {},
  });
  try {
    runner.start();
    await flush();
    trades = [
      {
        id: 'synthetic-buy',
        sender: 'OUTSIDE',
        side: 'Buy',
        tokenAmount: '10',
        quoteAmount: '1',
        priceUsd: '1',
        timestamp: new Date(0).toISOString(),
      },
    ];
    await runner.tick();
    await flush();
    runner.stop();
    refuse(Error('Synthetic stopped before send'));
    await flush();
    const result = view(runner.snapshot());
    expect(result).toContain('Not running');
    expect(result).toContain('<dt>Unsent tokens</dt><dd>0</dd>');
    expect(result).toContain('<dt>Accounted tokens</dt><dd>0</dd>');
    expect(result).toContain('<dt>In-progress tokens</dt><dd>0</dd>');
    expect(result).not.toContain('transaction in progress');
  } finally {
    runner.stop();
  }
});

it('announces stopped pending outcomes without duplicating running status announcements', () => {
  expect(view(snapshot())).not.toContain('<output');
  expect(view(snapshot({ running: false }))).toContain(
    'aria-label="Stopped Auto Sell pending outcome"',
  );
  expect(view(snapshot({ running: false }))).toContain(
    'a transaction is still in progress',
  );
});
