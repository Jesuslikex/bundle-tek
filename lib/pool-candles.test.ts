import { expect, it, vi } from 'vitest';
import {
  decodePoolCandles,
  observePoolCandles,
  candleSelection,
  appendOlderCandles,
  refreshSavedCandles,
  SOL_CANDLE_QUOTE,
} from './pool-candles';
import { acquisitionMint } from '../test/imported-sell-acquisition-fixture';
const source = {
    chain: 'Solana' as const,
    address: 'So11111111111111111111111111111111111111112',
  },
  pool = '11111111111111111111111111111111';
const time = Math.floor(Date.now() / 1000 / 3600) * 3600;
const data = (
  rows: unknown = [
    [time, 1, 2, 0.5, 1.5, 100],
    [time - 3600, 0.8, 1.2, 0.6, 1, 90],
  ],
) => ({
  data: { type: 'ohlcv_request_response', attributes: { ohlcv_list: rows } },
  meta: { base: { address: source.address } },
});
it('requests actual one-minute candles, preserves missing minutes and enforces minute boundaries', async () => {
  const identity = {
    data: {
      id: 'solana_' + pool,
      type: 'pool',
      relationships: {
        base_token: { data: { type: 'token', id: 'solana_' + source.address } },
      },
    },
  };
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(Response.json(identity))
    .mockResolvedValueOnce(
      Response.json(
        data([
          [time, 1, 2, 0.5, 1.5, 100],
          [time - 120, 1, 2, 0.5, 1, 50],
        ]),
      ),
    );
  const result = await observePoolCandles(
    source,
    pool,
    '1m',
    AbortSignal.timeout(1000),
    fetcher,
  );
  expect(result.interval).toBe('1m');
  expect(result.candles.map((c) => c.time)).toEqual([time - 120, time]);
  expect(fetcher.mock.calls[1][0]).toContain('/ohlcv/minute?aggregate=1&');
  expect(() =>
    decodePoolCandles(data([[time - 1, 1, 2, 0.5, 1, 10]]), source, pool, '1m'),
  ).toThrow();
});
it('binds SOL prices to the actual pool quote and returned quote metadata, and refuses mixed-currency pages', async () => {
  const token = { chain: 'Solana' as const, address: acquisitionMint };
  const identity = {
    data: {
      id: 'solana_' + pool,
      type: 'pool',
      relationships: {
        base_token: { data: { type: 'token', id: 'solana_' + token.address } },
        quote_token: {
          data: { type: 'token', id: 'solana_' + SOL_CANDLE_QUOTE },
        },
      },
    },
  };
  const quoteData = {
    ...data(),
    meta: {
      base: { address: token.address },
      quote: { address: SOL_CANDLE_QUOTE },
    },
  };
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(Response.json(identity))
    .mockResolvedValueOnce(Response.json(quoteData));
  const sol = await observePoolCandles(
    token,
    pool,
    '1h',
    AbortSignal.timeout(1000),
    fetcher,
    undefined,
    'sol',
  );
  expect(sol.currency).toBe('sol');
  expect(sol.quoteMint).toBe(SOL_CANDLE_QUOTE);
  expect(fetcher.mock.calls[1][0]).toContain('currency=token&token=base');
  expect(() =>
    decodePoolCandles(
      { ...quoteData, meta: { ...quoteData.meta, quote: { address: pool } } },
      token,
      pool,
      '1h',
      'sol',
    ),
  ).toThrow('quote context');
  const wrong = vi.fn().mockResolvedValue(
    Response.json({
      ...identity,
      data: {
        ...identity.data,
        relationships: {
          ...identity.data.relationships,
          quote_token: { data: { type: 'token', id: 'solana_' + pool } },
        },
      },
    }),
  );
  await expect(
    observePoolCandles(
      token,
      pool,
      '1h',
      AbortSignal.timeout(1000),
      wrong,
      undefined,
      'sol',
    ),
  ).rejects.toThrow('SOL-quoted');
  expect(wrong).toHaveBeenCalledTimes(1);
  const usd = decodePoolCandles(quoteData, token, pool, '1h');
  expect(usd.currency).toBeUndefined();
  expect(() =>
    refreshSavedCandles(usd, {
      ...sol,
      observedAt: '2099-01-01T00:00:00.000Z',
    }),
  ).toThrow();
  expect(() => appendOlderCandles(usd, { ...sol, candles: [] })).toThrow();
});
it('refreshes recent prices while retaining older actual candles and replacing the entire fresh range', () => {
  const previous = {
    ...decodePoolCandles(data(), source, pool, '1h'),
    observedAt: '2026-10-11T10:00:00Z',
    olderExhausted: true,
  };
  const page = {
    ...previous,
    observedAt: '2026-10-11T10:01:00Z',
    candles: [{ ...previous.candles.at(-1)!, close: 1.7 }],
  };
  const merged = refreshSavedCandles(previous, page);
  expect(merged.candles[0]).toEqual(previous.candles[0]);
  expect(merged.candles.at(-1)?.close).toBe(1.7);
  expect(merged.latestObservedAt).toBe(page.observedAt);
  expect(merged.olderExhausted).toBe(true);
  const gap = {
    ...previous,
    candles: [
      previous.candles[0],
      { ...previous.candles[0], time: time - 1800 },
      previous.candles[1],
    ],
  };
  expect(
    refreshSavedCandles(gap, { ...page, candles: previous.candles }).candles,
  ).toEqual(previous.candles);
});
it('bounds followed candles and rejects empty, regressed and foreign latest pages', () => {
  const base = {
    ...decodePoolCandles(data(), source, pool, '1h'),
    observedAt: '2026-10-11T10:00:00Z',
    olderExhausted: true,
  };
  const many = {
    ...base,
    candles: Array.from({ length: 500 }, (_, i) => ({
      ...base.candles[0],
      time: time - (500 - i) * 3600,
    })),
  };
  const page = {
    ...base,
    observedAt: '2026-10-11T10:01:00Z',
    candles: [base.candles.at(-1)!],
  };
  const bounded = refreshSavedCandles(many, page);
  expect(bounded.candles).toHaveLength(500);
  expect(bounded.olderExhausted).toBe(false);
  for (const bad of [
    { ...page, candles: [] },
    { ...page, observedAt: base.observedAt },
    { ...page, pool: source.address },
    { ...page, interval: '5m' as const },
    { ...page, candles: [{ ...page.candles[0], time: time - 7200 }] },
  ])
    expect(() => refreshSavedCandles(base, bad)).toThrow();
});
it('appends older intervals without replacing recent prices, bounds retained history and records empty provider pages honestly', () => {
  const previous = decodePoolCandles(data(), source, pool, '1h');
  const page = decodePoolCandles(
    data([[time - 10800, 1, 2, 0.5, 1, 20]]),
    source,
    pool,
    '1h',
  );
  const merged = appendOlderCandles(previous, page);
  expect(merged.candles.map((c) => c.time)).toEqual([
    time - 10800,
    time - 3600,
    time,
  ]);
  expect(merged.latestObservedAt).toBe(previous.observedAt);
  expect(merged.candles.at(-1)).toEqual(previous.candles.at(-1));
  expect(() => appendOlderCandles(previous, previous)).toThrow();
  expect(() =>
    appendOlderCandles(previous, { ...page, pool: source.address }),
  ).toThrow();
  const exhausted = appendOlderCandles(previous, { ...page, candles: [] });
  expect(exhausted.olderExhausted).toBe(true);
  expect(exhausted.candles).toEqual(previous.candles);
  expect(() => appendOlderCandles(exhausted, page)).toThrow();
  const many = {
    ...previous,
    candles: Array.from({ length: 450 }, (_, i) => ({
      ...previous.candles[0],
      time: time - (450 - i) * 3600,
    })),
  };
  const older = {
    ...page,
    candles: Array.from({ length: 100 }, (_, i) => ({
      ...page.candles[0],
      time: time - (550 - i) * 3600,
    })),
  };
  expect(appendOlderCandles(many, older).candles).toHaveLength(500);
  expect(() =>
    appendOlderCandles(appendOlderCandles(many, older), older),
  ).toThrow();
});
it('retains actual OHLCV, reverses chronological provider order and preserves missing intervals', () => {
  const result = decodePoolCandles(data(), source, pool, '1h');
  expect(result.candles[0]).toEqual({
    time: time - 3600,
    open: 0.8,
    high: 1.2,
    low: 0.6,
    close: 1,
    volume: 90,
  });
  expect(result.executionAllowed).toBe(false);
  expect(
    decodePoolCandles(
      data([
        [time, 1, 2, 0.5, 1.5, 100],
        [time - 7200, 1, 2, 0.5, 1.5, 0],
      ]),
      source,
      pool,
      '1h',
    ).candles,
  ).toHaveLength(2);
});
it('rejects duplicate/unaligned/future candles, invalid ranges, wrong tokens, oversized lists and unsupported selections', () => {
  for (const rows of [
    [[time, 1, 0.9, 0.5, 1, 1]],
    [[time, 1, 2, 1.1, 1, 1]],
    [[time, 0, 2, 0, 1, 1]],
    [[time, 1, 2, 0.5, 1, -1]],
    [[time + 3600, 1, 2, 0.5, 1, 1]],
    [[time + 1, 1, 2, 0.5, 1, 1]],
    [
      [time, 1, 2, 0.5, 1, 1],
      [time, 1, 2, 0.5, 1, 1],
    ],
    Array(101).fill([time, 1, 2, 0.5, 1, 1]),
  ])
    expect(() => decodePoolCandles(data(rows), source, pool, '1h')).toThrow();
  expect(() =>
    decodePoolCandles(
      { ...data(), meta: { base: { address: pool } } },
      source,
      pool,
      '1h',
    ),
  ).toThrow();
  expect(() => candleSelection('Arc', pool, '1h')).toThrow();
  expect(() => candleSelection('Solana', pool, 'second')).toThrow();
});
it('uses fixed provider paths without redirects or credentials and refuses unrelated pool identity before candle reads', async () => {
  const identity = {
    data: {
      id: 'solana_' + pool,
      type: 'pool',
      relationships: {
        base_token: { data: { type: 'token', id: 'solana_' + source.address } },
      },
    },
  };
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(Response.json(identity))
    .mockResolvedValueOnce(Response.json(data()));
  const signal = AbortSignal.timeout(1000);
  expect(
    (await observePoolCandles(source, pool, '1h', signal, fetcher)).candles,
  ).toHaveLength(2);
  expect(fetcher.mock.calls[1][0]).toContain(
    '/ohlcv/hour?aggregate=1&limit=100&currency=usd&token=base&include_empty_intervals=false',
  );
  expect(fetcher.mock.calls[0][1]).toMatchObject({
    redirect: 'manual',
    credentials: 'omit',
    signal,
  });
  const paged = vi
    .fn()
    .mockResolvedValueOnce(Response.json(identity))
    .mockResolvedValueOnce(
      Response.json(data([[time - 7200, 1, 2, 0.5, 1, 10]])),
    );
  await observePoolCandles(source, pool, '1h', signal, paged, time - 3600);
  expect(paged.mock.calls[1][0]).toContain(`before_timestamp=${time - 3601}`);
  const ignored = vi
    .fn()
    .mockResolvedValueOnce(Response.json(identity))
    .mockResolvedValueOnce(Response.json(data()));
  await expect(
    observePoolCandles(source, pool, '1h', signal, ignored, time - 3600),
  ).rejects.toThrow('ignored cursor');
  const wrong = vi.fn().mockResolvedValue(
    Response.json({
      ...identity,
      data: { ...identity.data, id: 'other_' + pool },
    }),
  );
  await expect(
    observePoolCandles(source, pool, '1h', signal, wrong),
  ).rejects.toThrow();
  expect(wrong).toHaveBeenCalledTimes(1);
  const large = vi.fn().mockResolvedValue(new Response(' '.repeat(262145)));
  await expect(
    observePoolCandles(source, pool, '1h', signal, large),
  ).rejects.toThrow('too large');
});

it.each(['usd', 'sol'] as const)(
  'translates exclusive %s history boundaries for an inclusive provider and merges without duplicates',
  async (currency) => {
    const token = { chain: 'Solana' as const, address: acquisitionMint };
    const identity = {
      data: {
        type: 'pool',
        id: 'solana_' + pool,
        relationships: {
          base_token: {
            data: { type: 'token', id: 'solana_' + token.address },
          },
          quote_token: {
            data: { type: 'token', id: 'solana_' + SOL_CANDLE_QUOTE },
          },
        },
      },
    };
    const rows = [time, time - 60, time - 120, time - 180].map((t) => [
      t,
      1,
      2,
      0.5,
      1,
      10,
    ]);
    const response = (selected: number[][]) => ({
      data: {
        type: 'ohlcv_request_response',
        attributes: { ohlcv_list: selected },
      },
      meta: {
        base: { address: token.address },
        quote: { address: SOL_CANDLE_QUOTE },
      },
    });
    const requestUrl = (url: string | URL | Request) =>
      typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      const parsed = new URL(requestUrl(url));
      if (!parsed.pathname.includes('/ohlcv/')) return Response.json(identity);
      const cursor = Number(parsed.searchParams.get('before_timestamp'));
      return Response.json(response(rows.filter((row) => row[0] <= cursor)));
    });
    const boundary = time - 60;
    const prior = decodePoolCandles(
      response(rows.slice(0, 2)),
      token,
      pool,
      '1m',
      currency,
    );
    const older = await observePoolCandles(
      token,
      pool,
      '1m',
      AbortSignal.timeout(1000),
      fetcher,
      boundary,
      currency,
    );
    expect(
      new URL(requestUrl(fetcher.mock.calls[1][0])).searchParams.get(
        'before_timestamp',
      ),
    ).toBe(String(boundary - 1));
    expect(older.candles.map((c) => c.time)).toEqual([time - 180, time - 120]);
    const merged = appendOlderCandles(prior, older);
    expect(merged.candles.map((c) => c.time)).toEqual([
      time - 180,
      time - 120,
      time - 60,
      time,
    ]);
    expect(new Set(merged.candles.map((c) => c.time)).size).toBe(4);
    for (const invalidTime of [boundary, time]) {
      const ignored = vi
        .fn()
        .mockResolvedValueOnce(Response.json(identity))
        .mockResolvedValueOnce(
          Response.json(response([[invalidTime, 1, 2, 0.5, 1, 10]])),
        );
      await expect(
        observePoolCandles(
          token,
          pool,
          '1m',
          AbortSignal.timeout(1000),
          ignored,
          boundary,
          currency,
        ),
      ).rejects.toThrow('ignored cursor');
    }
  },
);
