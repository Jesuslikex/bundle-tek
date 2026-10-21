import { afterEach, expect, it, vi } from 'vitest';
import { layerBalanceRefreshFixture } from '../test/launch-layer-balance-refresh-fixture';
import {
  admitLayerSolRefresh,
  layerSolRefreshGroups,
  refreshLayerSol,
  LayerSolRefreshError,
  readLayerSolJson,
  LAYER_SOL_RESPONSE_BYTES,
} from './launch-layer-balance-refresh';
import { validateBalanceRequest } from './wallet-balances';
afterEach(() => vi.useRealTimers());
it('bounds complete JSON by bytes and rejects HTML and invalid UTF-8 without raw diagnostics', async () => {
  const signal = new AbortController().signal;
  expect(await readLayerSolJson(Response.json({ ok: true }), signal)).toEqual({
    ok: true,
  });
  await expect(
    readLayerSolJson(new Response('<html>private upstream</html>'), signal),
  ).rejects.toMatchObject({ code: 'unconfirmed' });
  await expect(
    readLayerSolJson(
      new Response(new Uint8Array([0xff]), {
        headers: { 'content-type': 'application/json' },
      }),
      signal,
    ),
  ).rejects.toMatchObject({ code: 'unconfirmed' });
  await expect(
    readLayerSolJson(
      new Response(' '.repeat(LAYER_SOL_RESPONSE_BYTES + 1), {
        headers: { 'content-type': 'application/json' },
      }),
      signal,
    ),
  ).rejects.toMatchObject({ code: 'unconfirmed' });
});
it('cancels an unfinished body reader and releases its lock', async () => {
  const cancelled = vi.fn(),
    controller = new AbortController();
  const response = new Response(
    new ReadableStream({
      start(stream) {
        stream.enqueue(new TextEncoder().encode('{'));
      },
      cancel: cancelled,
    }),
    { headers: { 'content-type': 'application/json' } },
  );
  const run = readLayerSolJson(response, controller.signal),
    refused = expect(run).rejects.toMatchObject({ name: 'AbortError' });
  await Promise.resolve();
  controller.abort();
  await refused;
  expect(cancelled).toHaveBeenCalledOnce();
  expect(response.body!.locked).toBe(false);
});

it('matches the existing route cap and partitions the full 500-wallet scope without duplicates', async () => {
  const f = await layerBalanceRefreshFixture(500),
    groups = layerSolRefreshGroups(f.plan.envelope);
  expect(groups.map((group) => group.length)).toEqual([
    100, 100, 100, 100, 100,
  ]);
  expect(new Set(groups.flat()).size).toBe(500);
  for (const addresses of groups)
    expect(
      validateBalanceRequest({ chain: 'Solana', addresses }).addresses,
    ).toEqual(addresses);
  expect(() =>
    validateBalanceRequest({
      chain: 'Solana',
      addresses: groups.flat().slice(0, 101),
    }),
  ).toThrow();
  const oversized = await layerBalanceRefreshFixture(501);
  expect(() => layerSolRefreshGroups(oversized.plan.envelope)).toThrow();
});
it.each([
  'partial',
  'reverse',
  'rounded',
  'total',
  'source',
  'item-snapshot',
  'slot',
  'extra',
] as const)(
  'refuses an invalid %s balance receipt with a fixed safe error',
  async (kind) => {
    const f = await layerBalanceRefreshFixture(),
      addresses = layerSolRefreshGroups(f.plan.envelope)[0],
      receipt = await f.refresh(addresses);
    if (kind === 'partial') receipt.items.pop();
    if (kind === 'reverse') receipt.items.reverse();
    if (kind === 'rounded')
      Object.assign(receipt.items[0], { raw: Number('9007199254740993') });
    if (kind === 'total') receipt.total = '0';
    if (kind === 'source') receipt.source = 'https://example.test/secret';
    if (kind === 'item-snapshot')
      receipt.items[0].snapshotId = '00000000-0000-4000-8000-000000000099';
    if (kind === 'slot') receipt.items[0].blockNumber--;
    if (kind === 'extra') Object.assign(receipt, { signingAllowed: true });
    expect(() => admitLayerSolRefresh(receipt, addresses)).toThrow(
      LayerSolRefreshError,
    );
    try {
      admitLayerSolRefresh(receipt, addresses);
    } catch (error) {
      expect(String(error)).not.toContain('/secret');
    }
  },
);
it('rechecks retained evidence before reporting an exact single-group result', async () => {
  const f = await layerBalanceRefreshFixture(),
    read = vi.fn(f.read),
    refresh = vi.fn(f.refresh),
    progress = vi.fn(),
    comparison = vi.fn();
  const result = await refreshLayerSol({
    plan: f.plan,
    signal: new AbortController().signal,
    current: () => true,
    readEvidence: read,
    refreshGroup: refresh,
    onProgress: progress,
    onComparison: comparison,
  });
  expect(read).toHaveBeenCalledTimes(2);
  expect(refresh).toHaveBeenCalledTimes(1);
  expect(comparison).toHaveBeenCalledTimes(1);
  expect(result.observedTotalRaw).toBe(String(9007199254740993n * 7n));
  expect(result.evidence.signingAllowed).toBe(false);
  expect(progress.mock.lastCall![0]).toMatchObject({
    phase: 'done',
    completed: 7,
    total: 7,
  });
});
it.each([105, 500])(
  'waits the full shared-gate interval for %s wallets and never combines different observations',
  async (count) => {
    const f = await layerBalanceRefreshFixture(count);
    vi.useFakeTimers();
    const read = vi.fn(f.read),
      refresh = vi.fn(f.refresh),
      progress = vi.fn();
    const run = refreshLayerSol({
      plan: f.plan,
      signal: new AbortController().signal,
      current: () => true,
      readEvidence: read,
      refreshGroup: refresh,
      onProgress: progress,
      onComparison: () => {},
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(progress.mock.lastCall![0].phase).toBe('waiting');
    await vi.advanceTimersByTimeAsync(14999);
    expect(refresh).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    if (count === 500) await vi.advanceTimersByTimeAsync(45000);
    const result = await run;
    expect(refresh.mock.calls.map((call) => call[0].length)).toEqual(
      count === 105 ? [100, 5] : [100, 100, 100, 100, 100],
    );
    expect(read).toHaveBeenCalledTimes(Math.ceil(count / 100) * 2);
    expect(result.observedTotalRaw).toBeNull();
    expect(progress.mock.lastCall![0]).toMatchObject({
      phase: 'done',
      completed: count,
    });
    expect(vi.getTimerCount()).toBe(0);
  },
);
it('detaches reviewed terms and group arguments before asynchronous callbacks', async () => {
  const f = await layerBalanceRefreshFixture();
  const result = await refreshLayerSol({
    plan: f.plan,
    signal: new AbortController().signal,
    current: () => true,
    readEvidence: f.read,
    refreshGroup: async (addresses) => {
      const receipt = await f.refresh(addresses);
      addresses.reverse();
      f.plan.envelope.terms.roles.front[0].maximumNetworkFeeLamports = '0';
      f.plan.envelope.terms.totals.maximumNativeBudgetLamports = String(
        BigInt(f.plan.envelope.terms.totals.maximumNativeBudgetLamports) -
          5000n,
      );
      return receipt;
    },
    onProgress: () => {},
    onComparison: () => {},
  });
  expect(result.rows.find((row) => row.role === 'front')!.ceilingRaw).toBe(
    '2106000',
  );
});
it('does not issue a read when cancellation happens in the progress callback', async () => {
  const f = await layerBalanceRefreshFixture(),
    controller = new AbortController(),
    refresh = vi.fn(f.refresh);
  await expect(
    refreshLayerSol({
      plan: f.plan,
      signal: controller.signal,
      current: () => true,
      readEvidence: f.read,
      refreshGroup: refresh,
      onProgress: (p) => {
        if (p.phase === 'reading') controller.abort();
      },
      onComparison: () => {},
    }),
  ).rejects.toMatchObject({ name: 'AbortError' });
  expect(refresh).not.toHaveBeenCalled();
});
it('stops the whole campaign on the first rate refusal without retrying or losing the confirmed count', async () => {
  const f = await layerBalanceRefreshFixture(205);
  vi.useFakeTimers();
  let calls = 0;
  const refresh = vi.fn(async (addresses: string[]) => {
      calls++;
      if (calls === 2) throw new LayerSolRefreshError('limited');
      return f.refresh(addresses);
    }),
    progress = vi.fn();
  const run = refreshLayerSol({
    plan: f.plan,
    signal: new AbortController().signal,
    current: () => true,
    readEvidence: f.read,
    refreshGroup: refresh,
    onProgress: progress,
    onComparison: () => {},
  });
  const refused = expect(run).rejects.toMatchObject({ code: 'limited' });
  await vi.advanceTimersByTimeAsync(15000);
  await refused;
  await vi.advanceTimersByTimeAsync(60000);
  expect(refresh).toHaveBeenCalledTimes(2);
  expect(progress.mock.lastCall![0].completed).toBe(100);
  expect(vi.getTimerCount()).toBe(0);
});
it.each(['pre-read', 'provider', 'wait'] as const)(
  'cancels during %s even when an awaited transport ignores abort',
  async (phase) => {
    const f = await layerBalanceRefreshFixture(105),
      controller = new AbortController();
    vi.useFakeTimers();
    let release!: () => void;
    const read = vi.fn(async () => {
      if (phase === 'pre-read')
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      return f.read();
    });
    const refresh = vi.fn(async (addresses: string[]) => {
      if (phase === 'provider')
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      return f.refresh(addresses);
    });
    const comparison = vi.fn();
    const run = refreshLayerSol({
      plan: f.plan,
      signal: controller.signal,
      current: () => true,
      readEvidence: read,
      refreshGroup: refresh,
      onProgress: () => {},
      onComparison: comparison,
    });
    const refused = expect(run).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    release?.();
    await refused;
    await vi.advanceTimersByTimeAsync(60000);
    expect(refresh).toHaveBeenCalledTimes(phase === 'pre-read' ? 0 : 1);
    expect(comparison).toHaveBeenCalledTimes(phase === 'wait' ? 1 : 0);
    expect(vi.getTimerCount()).toBe(0);
  },
);
it('refuses unretained or replaced observations before advancing', async () => {
  const f = await layerBalanceRefreshFixture(),
    refresh = vi.fn(async (addresses: string[]) => {
      const receipt = await f.refresh(addresses);
      f.evidence.rows[0].observation!.raw = '1';
      return receipt;
    });
  await expect(
    refreshLayerSol({
      plan: f.plan,
      signal: new AbortController().signal,
      current: () => true,
      readEvidence: f.read,
      refreshGroup: refresh,
      onProgress: () => {},
      onComparison: () => {
        throw Error('Must not publish');
      },
    }),
  ).rejects.toMatchObject({ code: 'changed' });
  expect(refresh).toHaveBeenCalledTimes(1);
});
it('refuses a previously saved response ID and keeps stock buys outside SOL totals', async () => {
  const f = await layerBalanceRefreshFixture(7, true),
    addresses = layerSolRefreshGroups(f.plan.envelope)[0],
    prior = await f.refresh(addresses);
  await expect(
    refreshLayerSol({
      plan: f.plan,
      signal: new AbortController().signal,
      current: () => true,
      readEvidence: f.read,
      refreshGroup: async () => prior,
      onProgress: () => {},
      onComparison: () => {},
    }),
  ).rejects.toMatchObject({ code: 'unconfirmed' });
  const result = await refreshLayerSol({
    plan: f.plan,
    signal: new AbortController().signal,
    current: () => true,
    readEvidence: f.read,
    refreshGroup: f.refresh,
    onProgress: () => {},
    onComparison: () => {},
  });
  expect(result.rows.every((row) => row.nativeBuyRaw === '0')).toBe(true);
});
it('refuses replacement of a confirmed earlier group before reading the next group', async () => {
  const f = await layerBalanceRefreshFixture(105);
  vi.useFakeTimers();
  const refresh = vi.fn(f.refresh),
    publish = vi.fn();
  const run = refreshLayerSol({
    plan: f.plan,
    signal: new AbortController().signal,
    current: () => true,
    readEvidence: f.read,
    refreshGroup: refresh,
    onProgress: (p) => {
      if (p.phase === 'waiting') {
        f.evidence.rows[0].observation!.snapshotId =
          '00000000-0000-4000-8000-000000000099';
      }
    },
    onComparison: publish,
  });
  const refused = expect(run).rejects.toMatchObject({ code: 'changed' });
  await vi.advanceTimersByTimeAsync(15000);
  await refused;
  expect(refresh).toHaveBeenCalledTimes(1);
  expect(publish).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});
it('refuses an internally consistent new receipt below a previously retained slot', async () => {
  const f = await layerBalanceRefreshFixture();
  const addresses = layerSolRefreshGroups(f.plan.envelope)[0];
  const previous = await f.refresh(addresses);
  const publish = vi.fn(),
    read = vi.fn(f.read);
  await expect(
    refreshLayerSol({
      plan: f.plan,
      signal: new AbortController().signal,
      current: () => true,
      readEvidence: read,
      refreshGroup: async (group) => {
        const next = await f.refresh(group);
        expect(next.snapshotId).not.toBe(previous.snapshotId);
        next.blockNumber = previous.blockNumber - 1;
        next.items.forEach((item) => {
          item.blockNumber = next.blockNumber;
        });
        expect(() => admitLayerSolRefresh(next, group)).not.toThrow();
        return next;
      },
      onProgress: () => {},
      onComparison: publish,
    }),
  ).rejects.toMatchObject({ code: 'unconfirmed' });
  expect(read).toHaveBeenCalledOnce();
  expect(publish).not.toHaveBeenCalled();
});
