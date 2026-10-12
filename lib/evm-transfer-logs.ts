import type { EvmChain } from './evm-network';
import { walletAddress } from './wallet-workspace';
import { getAddress } from 'viem';

export const ERC20_TRANSFER_TOPIC =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
export type EvmTransferEvent = {
  contract: string;
  from: string;
  to: string;
  raw: string;
  logIndex: string;
  direction: 'Incoming' | 'Outgoing' | 'Self';
};
function quantity(value: unknown) {
  if (
    typeof value !== 'string' ||
    !/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]{0,63})$/.test(value)
  )
    throw new Error('Invalid receipt log quantity.');
  return BigInt(value).toString();
}
function word(value: unknown) {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(value))
    throw new Error('Invalid receipt log word.');
  return value.toLowerCase();
}
function topicAddress(value: unknown) {
  const encoded = word(value);
  if (!/^0x0{24}[0-9a-f]{40}$/.test(encoded))
    throw new Error('Invalid padded transfer address.');
  // The zero address is valid in emitted mint/burn event participants.
  return getAddress('0x' + encoded.slice(-40));
}
export function decodeEvmTransferLogs(
  value: unknown,
  context: {
    chain: EvmChain;
    address: string;
    hash: string;
    blockHash: string;
    blockNumber: string;
    transactionIndex: string;
    failed: boolean;
  },
) {
  if (
    !Array.isArray(value) ||
    value.length > 1000 ||
    (context.failed && value.length)
  )
    throw new Error('Incomplete or inconsistent receipt logs.');
  const events: EvmTransferEvent[] = [];
  let previous = -1n;
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item))
      throw new Error('Invalid receipt log.');
    const log = item as Record<string, unknown>;
    const index = quantity(log.logIndex),
      emitter = walletAddress(log.address, context.chain);
    if (
      word(log.transactionHash) !== context.hash ||
      word(log.blockHash) !== context.blockHash ||
      quantity(log.blockNumber) !== context.blockNumber ||
      quantity(log.transactionIndex) !== context.transactionIndex ||
      log.removed !== false ||
      BigInt(index) <= previous
    )
      throw new Error('Receipt log identity, order or canonicality mismatch.');
    previous = BigInt(index);
    if (
      !Array.isArray(log.topics) ||
      log.topics.length > 4 ||
      typeof log.data !== 'string' ||
      !/^0x(?:[0-9a-fA-F]{2})*$/.test(log.data)
    )
      throw new Error('Invalid receipt event encoding.');
    const topics = log.topics.map(word);
    if (topics[0] !== ERC20_TRANSFER_TOPIC) continue;
    // ERC-721 uses the same event signature with four topics and no data.
    if (topics.length === 4 && log.data === '0x') continue;
    if (topics.length !== 3)
      throw new Error('Unsupported Transfer event layout.');
    const from = topicAddress(topics[1]),
      to = topicAddress(topics[2]);
    const raw = BigInt(word(log.data)).toString();
    if (from !== context.address && to !== context.address) continue;
    events.push({
      contract: emitter,
      from,
      to,
      raw,
      logIndex: index,
      direction:
        from === context.address
          ? to === context.address
            ? 'Self'
            : 'Outgoing'
          : 'Incoming',
    });
    if (events.length > 100)
      throw new Error('Receipt has too many tracked transfer events.');
  }
  return { events, receiptLogCount: value.length };
}
