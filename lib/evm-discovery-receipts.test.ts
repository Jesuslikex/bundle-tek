import { it, expect } from 'vitest';
import { discoveryReceiptEvents } from './evm-discovery-receipts';
import { ERC20_TRANSFER_TOPIC } from './evm-transfer-logs';
const a = '0x' + '1'.repeat(40),
  b = '0x' + '2'.repeat(40),
  c = '0x' + '3'.repeat(40),
  h = '0x' + 'a'.repeat(64),
  block = '0x' + 'b'.repeat(64),
  word = (s: string) => '0x' + s.slice(2).padStart(64, '0');
const tx = { hash: h, from: b, to: c },
  context = {
    chain: 'Base' as const,
    address: a,
    blockNumber: '12',
    blockHash: block,
    transactions: [tx],
  };
const log = {
  address: c,
  transactionHash: h,
  blockHash: block,
  blockNumber: '0xc',
  transactionIndex: '0x0',
  logIndex: '0x1',
  removed: false,
  topics: [ERC20_TRANSFER_TOPIC, word(b), word(a)],
  data: '0x' + 'f'.repeat(64),
};
const receipt = {
  transactionHash: h,
  blockHash: block,
  blockNumber: '0xc',
  transactionIndex: '0x0',
  from: b,
  to: c,
  status: '0x1',
  logs: [log],
};
it('discovers indirect receipt events with exact uint256 units and omits NFT and nonstandard layouts', () => {
  const r = discoveryReceiptEvents([receipt], context);
  expect(r.matchingEventCount).toBe(1);
  expect(r.eventsByHash.get(h)![0]).toMatchObject({
    direction: 'Incoming',
    raw: ((1n << 256n) - 1n).toString(),
    contract: c,
  });
  expect(
    discoveryReceiptEvents(
      [
        {
          ...receipt,
          logs: [{ ...log, topics: [...log.topics, word('0x1')], data: '0x' }],
        },
      ],
      context,
    ).matchingEventCount,
  ).toBe(0);
  expect(
    discoveryReceiptEvents(
      [
        {
          ...receipt,
          logs: [{ ...log, topics: [ERC20_TRANSFER_TOPIC], data: '0x' }],
        },
      ],
      context,
    ).matchingEventCount,
  ).toBe(0);
});
it('rejects incomplete, duplicate, forged, removed, failed, malformed and unordered receipt evidence', () => {
  for (const value of [
    [],
    null,
    [receipt, receipt],
    [{ ...receipt, from: a }],
    [{ ...receipt, status: '0x0' }],
    [{ ...receipt, transactionIndex: '0x1' }],
    [{ ...receipt, logs: [{ ...log, removed: true }] }],
    [{ ...receipt, logs: [{ ...log, blockHash: h }] }],
    [{ ...receipt, logs: [{ ...log, data: '0x1' }] }],
    [{ ...receipt, logs: [log, log] }],
    [
      {
        ...receipt,
        logs: [
          {
            ...log,
            topics: [
              ERC20_TRANSFER_TOPIC,
              '0x' + 'f'.repeat(24) + b.slice(2),
              word(a),
            ],
          },
        ],
      },
    ],
  ]) {
    expect(() => discoveryReceiptEvents(value, context)).toThrow();
  }
  const second = {
    ...receipt,
    transactionHash: block,
    transactionIndex: '0x1',
    logs: [
      {
        ...log,
        transactionHash: block,
        transactionIndex: '0x1',
        logIndex: '0x2',
      },
    ],
  };
  const ctx = { ...context, transactions: [tx, { ...tx, hash: block }] };
  expect(
    discoveryReceiptEvents([second, receipt], ctx).matchingEventCount,
  ).toBe(2);
  expect(() =>
    discoveryReceiptEvents(
      [receipt, { ...second, logs: [{ ...second.logs[0], logIndex: '0x1' }] }],
      ctx,
    ),
  ).toThrow();
});
