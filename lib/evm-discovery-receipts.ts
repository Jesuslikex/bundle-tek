import type { EvmChain } from './evm-network';
import { getAddress } from 'viem';
import {
  decodeEvmTransferLogs,
  ERC20_TRANSFER_TOPIC,
  type EvmTransferEvent,
} from './evm-transfer-logs';
import { evmTransactionHash } from './tracked-evm-transaction';
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid discovery receipt.');
  return value as Record<string, unknown>;
}
function uint(value: unknown) {
  if (
    typeof value !== 'string' ||
    !/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]{0,63})$/.test(value)
  )
    throw new Error('Invalid discovery receipt quantity.');
  return BigInt(value);
}
function address(value: unknown) {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(value))
    throw new Error('Invalid receipt participant.');
  return getAddress(value);
}
export function discoveryReceiptEvents(
  value: unknown,
  context: {
    chain: EvmChain;
    address: string;
    blockNumber: string;
    blockHash: string;
    transactions: Record<string, unknown>[];
  },
) {
  if (
    !Array.isArray(value) ||
    value.length !== context.transactions.length ||
    value.length > 2000
  )
    throw new Error('Incomplete block receipts.');
  const ordered: Record<string, unknown>[] = [];
  for (const v of value) {
    const r = object(v),
      index = uint(r.transactionIndex);
    if (index >= BigInt(value.length) || ordered[Number(index)])
      throw new Error('Duplicate or misplaced receipt.');
    ordered[Number(index)] = r;
  }
  const eventsByHash = new Map<string, EvmTransferEvent[]>(),
    topic = '0x' + '0'.repeat(24) + context.address.slice(2).toLowerCase();
  let lastLog = -1n,
    matchingEventCount = 0;
  for (let i = 0; i < ordered.length; i++) {
    const r = ordered[i],
      tx = context.transactions[i],
      hash = evmTransactionHash(tx.hash),
      status = uint(r.status);
    if (
      evmTransactionHash(r.transactionHash) !== hash ||
      evmTransactionHash(r.blockHash) !== context.blockHash ||
      uint(r.blockNumber).toString() !== context.blockNumber ||
      address(r.from) !== address(tx.from) ||
      (r.to === null ? null : address(r.to)) !==
        (tx.to === null ? null : address(tx.to)) ||
      (status !== 0n && status !== 1n) ||
      !Array.isArray(r.logs) ||
      r.logs.length > 1000 ||
      (status === 0n && r.logs.length)
    )
      throw new Error('Discovery receipt identity mismatch.');
    const matching: Record<string, unknown>[] = [];
    for (const entry of r.logs) {
      const log = object(entry),
        index = uint(log.logIndex);
      address(log.address);
      if (
        index <= lastLog ||
        evmTransactionHash(log.transactionHash) !== hash ||
        evmTransactionHash(log.blockHash) !== context.blockHash ||
        uint(log.blockNumber).toString() !== context.blockNumber ||
        uint(log.transactionIndex) !== BigInt(i) ||
        log.removed !== false ||
        !Array.isArray(log.topics) ||
        log.topics.length > 4 ||
        log.topics.some(
          (t) => typeof t !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(t),
        ) ||
        typeof log.data !== 'string' ||
        !/^0x(?:[0-9a-fA-F]{2})*$/.test(log.data)
      )
        throw new Error('Invalid canonical discovery log.');
      lastLog = index;
      if (
        log.topics.length === 3 &&
        (log.topics[0] as string).toLowerCase() === ERC20_TRANSFER_TOPIC &&
        log.topics.slice(1).some((t) => (t as string).toLowerCase() === topic)
      )
        matching.push(log);
    }
    const { events } = decodeEvmTransferLogs(matching, {
      ...context,
      hash,
      transactionIndex: String(i),
      failed: status === 0n,
    });
    matchingEventCount += events.length;
    if (matchingEventCount > 1000)
      throw new Error('Too many matched discovery events.');
    if (events.length) eventsByHash.set(hash, events);
  }
  return { eventsByHash, matchingEventCount, receiptsScanned: ordered.length };
}
