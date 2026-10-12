import { it, expect } from 'vitest';
import {
  decodeEvmTransferLogs,
  ERC20_TRANSFER_TOPIC,
} from './evm-transfer-logs';
const wallet = '0x1111111111111111111111111111111111111111',
  other = '0x2222222222222222222222222222222222222222';
const context = {
  chain: 'Base' as const,
  address: wallet,
  hash: '0x' + 'a'.repeat(64),
  blockHash: '0x' + 'b'.repeat(64),
  blockNumber: '18',
  transactionIndex: '1',
  failed: false,
};
const topic = (address: string) => '0x' + address.slice(2).padStart(64, '0');
const log = (patch = {}) => ({
  address: other,
  transactionHash: context.hash,
  blockHash: context.blockHash,
  blockNumber: '0x12',
  transactionIndex: '0x1',
  logIndex: '0x2',
  removed: false,
  topics: [ERC20_TRANSFER_TOPIC, topic(other), topic(wallet)],
  data: '0x' + (2n ** 256n - 1n).toString(16),
  ...patch,
});
it('retains exact uint256 values and incoming, outgoing, self and mint/burn participants', () => {
  const events = decodeEvmTransferLogs(
    [
      log(),
      log({
        logIndex: '0x3',
        topics: [ERC20_TRANSFER_TOPIC, topic(wallet), topic(other)],
      }),
      log({
        logIndex: '0x4',
        topics: [ERC20_TRANSFER_TOPIC, topic(wallet), topic(wallet)],
        data: '0x' + '0'.repeat(64),
      }),
      log({
        logIndex: '0x5',
        topics: [
          ERC20_TRANSFER_TOPIC,
          topic('0x' + '0'.repeat(40)),
          topic(wallet),
        ],
      }),
      log({
        logIndex: '0x6',
        topics: [
          ERC20_TRANSFER_TOPIC,
          topic(wallet),
          topic('0x' + '0'.repeat(40)),
        ],
      }),
    ],
    context,
  ).events;
  expect(events.map((e) => e.direction)).toEqual([
    'Incoming',
    'Outgoing',
    'Self',
    'Incoming',
    'Outgoing',
  ]);
  expect(events[0].raw).toBe((2n ** 256n - 1n).toString());
  expect(events[2].raw).toBe('0');
});
it('omits unrelated and NFT layouts without claiming a transfer', () => {
  const r = decodeEvmTransferLogs(
    [
      log({ topics: [ERC20_TRANSFER_TOPIC, topic(other), topic(other)] }),
      log({
        logIndex: '0x3',
        topics: [
          ERC20_TRANSFER_TOPIC,
          topic(other),
          topic(wallet),
          topic(other),
        ],
        data: '0x',
      }),
      log({ logIndex: '0x4', topics: [], data: '0x1234' }),
    ],
    context,
  );
  expect(r.events).toEqual([]);
  expect(r.receiptLogCount).toBe(3);
});
it('rejects log context mismatches, removed events, duplicate or out-of-order indices', () => {
  for (const patch of [
    { transactionHash: context.blockHash },
    { blockHash: context.hash },
    { blockNumber: '0x13' },
    { transactionIndex: '0x2' },
    { removed: true },
    { removed: undefined },
    { logIndex: '0x02' },
  ])
    expect(() => decodeEvmTransferLogs([log(patch)], context)).toThrow();
  expect(() => decodeEvmTransferLogs([log(), log()], context)).toThrow();
  expect(() =>
    decodeEvmTransferLogs([log(), log({ logIndex: '0x1' })], context),
  ).toThrow();
});
it('rejects malformed event data, nonzero address padding and failed-receipt logs', () => {
  for (const patch of [
    { data: '0x01' },
    { topics: [ERC20_TRANSFER_TOPIC, topic(other)] },
    { topics: [ERC20_TRANSFER_TOPIC, '0x' + 'f'.repeat(64), topic(wallet)] },
    { topics: ['0x1234'] },
    {
      topics: [ERC20_TRANSFER_TOPIC, topic(other), topic(wallet), topic(other)],
      data: '0x' + '0'.repeat(64),
    },
  ])
    expect(() => decodeEvmTransferLogs([log(patch)], context)).toThrow();
  expect(() =>
    decodeEvmTransferLogs([log()], { ...context, failed: true }),
  ).toThrow();
  expect(
    decodeEvmTransferLogs([], { ...context, failed: true }).events,
  ).toEqual([]);
});
it('bounds receipt and retained transfer counts without silently truncating', () => {
  expect(() =>
    decodeEvmTransferLogs(Array(1001).fill(log()), context),
  ).toThrow();
  expect(() =>
    decodeEvmTransferLogs(
      Array.from({ length: 101 }, (_, i) =>
        log({ logIndex: '0x' + i.toString(16) }),
      ),
      context,
    ),
  ).toThrow('too many');
});
