import { afterEach, expect, it, vi } from 'vitest';
import { createEvmDiscoveryBatch } from './evm-discovery-batch';
import type { EvmDiscovery, DiscoveryPage } from './evm-transaction-discovery';
afterEach(() => vi.useRealTimers());
const scan = (pages = 1): EvmDiscovery => ({
  chain: 'Base',
  address: '0x' + '1'.repeat(40),
  currency: 'ETH',
  source: 'fixture.test',
  fromBlock: String(210 - pages * 10),
  toBlock: '209',
  blockHash: '0x' + 'a'.repeat(64),
  fromBlockHash: '0x' + 'b'.repeat(64),
  fromParentHash: '0x' + 'c'.repeat(64),
  observedAt: new Date(Date.UTC(2026, 9, 11, 0, 0, pages)).toISOString(),
  blocksScanned: pages * 10,
  transactionsScanned: 0,
  candidates: [],
  includesTokenEvents: true,
  matchingEventCount: 0,
  coverage: 'Controller fixture only.',
  pages: Array.from(
    { length: pages },
    (_, i): DiscoveryPage => ({
      fromBlock: String(200 - i * 10),
      toBlock: String(209 - i * 10),
      blockHash: '0x' + 'd'.repeat(64),
      observedAt: new Date(Date.UTC(2026, 9, 11, 0, 0, i + 1)).toISOString(),
      blocksScanned: 10,
      transactionsScanned: 0,
    }),
  ),
});
const setup = () => {
  vi.useFakeTimers();
  let saved = scan();
  const read = vi.fn(async () => saved),
    advance = vi.fn(async () => {
      saved = scan(saved.pages!.length + 1);
      return saved;
    });
  const onScan = vi.fn(),
    onState = vi.fn();
  const driver = createEvmDiscoveryBatch({
    unavailable: () => null,
    read,
    advance,
    onScan,
    onState,
  });
  return {
    driver,
    read,
    advance,
    onScan,
    onState,
    replace: (value: EvmDiscovery) => {
      saved = value;
    },
  };
};
it('requires explicit start, reads before each advance, spaces saved pages and stops at 200 blocks', async () => {
  const t = setup();
  await vi.advanceTimersByTimeAsync(60000);
  expect(t.read).not.toHaveBeenCalled();
  t.driver.start();
  t.driver.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(t.advance).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(14999);
  expect(t.read).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1 + 18 * 15000);
  expect(t.advance).toHaveBeenCalledTimes(19);
  expect(t.onState).toHaveBeenLastCalledWith(
    expect.objectContaining({ status: 'complete', pages: 20 }),
  );
  await vi.advanceTimersByTimeAsync(60000);
  expect(t.advance).toHaveBeenCalledTimes(19);
  t.driver.destroy();
});
it('waits after rate limiting, stops on concurrent saved-window changes and retains observations', async () => {
  const t = setup();
  t.advance.mockResolvedValueOnce(null as unknown as EvmDiscovery);
  t.driver.start();
  await vi.advanceTimersByTimeAsync(15000);
  expect(t.read).toHaveBeenCalledTimes(2);
  expect(t.advance).toHaveBeenCalledTimes(2);
  t.replace({ ...scan(2), includesTokenEvents: false });
  await vi.advanceTimersByTimeAsync(15000);
  expect(t.advance).toHaveBeenCalledTimes(2);
  expect(t.onState).toHaveBeenLastCalledWith(
    expect.objectContaining({
      status: 'error',
      reason: expect.stringContaining('changed'),
    }),
  );
  t.driver.destroy();
});
it('aborts hidden/in-flight work, ignores late completion and requires an explicit restart', async () => {
  vi.useFakeTimers();
  let reason: string | null = null,
    finish!: (value: EvmDiscovery) => void;
  const read = vi.fn(async () => scan()),
    advance = vi.fn(
      (_scan: EvmDiscovery, _signal: AbortSignal) =>
        new Promise<EvmDiscovery>((resolve) => {
          finish = resolve;
        }),
    );
  const onScan = vi.fn(),
    onState = vi.fn();
  const driver = createEvmDiscoveryBatch({
    unavailable: () => reason,
    read,
    advance,
    onScan,
    onState,
  });
  driver.start();
  await vi.advanceTimersByTimeAsync(0);
  reason = 'Tab hidden';
  driver.availabilityChanged();
  expect(advance.mock.calls[0][1].aborted).toBe(true);
  finish(scan(2));
  reason = null;
  driver.availabilityChanged();
  await vi.advanceTimersByTimeAsync(60000);
  expect(onScan).toHaveBeenCalledTimes(1);
  expect(read).toHaveBeenCalledTimes(1);
  read.mockResolvedValue(scan(2));
  driver.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(read).toHaveBeenCalledTimes(2);
  driver.destroy();
  finish(scan(3));
  await vi.advanceTimersByTimeAsync(0);
  expect(onScan).toHaveBeenCalledTimes(2);
});
it('stops on provider failure, ambiguous advancement, missing anchors and malformed windows', async () => {
  const t = setup();
  t.advance.mockRejectedValueOnce(new Error('Provider unavailable'));
  t.driver.start();
  await vi.advanceTimersByTimeAsync(60000);
  expect(t.advance).toHaveBeenCalledTimes(1);
  expect(t.onState).toHaveBeenLastCalledWith(
    expect.objectContaining({ status: 'error' }),
  );
  t.advance.mockResolvedValueOnce(scan());
  t.driver.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(t.onState).toHaveBeenLastCalledWith(
    expect.objectContaining({
      status: 'error',
      reason: expect.stringContaining('did not extend'),
    }),
  );
  t.replace({ ...scan(), fromParentHash: '' });
  t.driver.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(t.advance).toHaveBeenCalledTimes(2);
  t.replace({ ...scan(), fromBlock: '-1' });
  t.driver.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(t.onState).toHaveBeenLastCalledWith(
    expect.objectContaining({
      status: 'error',
      reason: expect.stringContaining('Invalid'),
    }),
  );
  t.driver.destroy();
});
it('stops at genesis or the match cap without reading more provider pages', async () => {
  const t = setup();
  t.replace({ ...scan(), fromBlock: '0', toBlock: '9' });
  t.driver.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(t.advance).not.toHaveBeenCalled();
  expect(t.onState).toHaveBeenLastCalledWith(
    expect.objectContaining({ status: 'complete' }),
  );
  t.replace({
    ...scan(),
    candidates: Array.from({ length: 100 }, (_, i) => ({
      hash: '0x' + i.toString(16).padStart(64, '0'),
      blockNumber: '200',
      blockHash: '0x' + 'b'.repeat(64),
      transactionIndex: String(i),
      blockTime: '2026-10-11T00:00:00.000Z',
      direction: 'Incoming' as const,
      from: '0x' + '2'.repeat(40),
      to: scan().address,
      valueRaw: '1',
      value: '0.000000000000000001',
      transferEvents: [],
    })),
  });
  t.driver.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(t.advance).not.toHaveBeenCalled();
  expect(t.onState).toHaveBeenLastCalledWith(
    expect.objectContaining({ status: 'complete' }),
  );
  t.driver.destroy();
});
