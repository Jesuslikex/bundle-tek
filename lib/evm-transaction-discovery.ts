import { EVM_NETWORKS, evmChain } from './evm-network';
import { walletAddress } from './wallet-workspace';
import { balanceRpc } from './wallet-balances';
import { evmTransactionHash } from './tracked-evm-transaction';
import { formatNativeBalance } from './wallet-balance-format';
import { getAddress } from 'viem';
import { discoveryReceiptEvents } from './evm-discovery-receipts';
import type { EvmTransferEvent } from './evm-transfer-logs';

function quantity(value: unknown) {
  if (
    typeof value !== 'string' ||
    !/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]{0,63})$/.test(value)
  )
    throw new Error('Invalid discovery quantity.');
  return BigInt(value);
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid discovery block.');
  return value as Record<string, unknown>;
}
function header(value: unknown) {
  const row = object(value),
    number = quantity(row.number),
    timestamp = quantity(row.timestamp);
  if (
    number > BigInt(Number.MAX_SAFE_INTEGER) ||
    timestamp < 1577836800n ||
    timestamp > BigInt(Math.floor(Date.now() / 1000) + 300)
  )
    throw new Error('Invalid discovery block anchor.');
  return {
    number,
    timestamp,
    hash: evmTransactionHash(row.hash),
    parentHash: evmTransactionHash(row.parentHash),
  };
}
export async function discoverEvmTransactions(
  chainValue: unknown,
  addressValue: unknown,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
  anchor?: {
    number: string;
    hash: string;
    childNumber: string;
    childHash: string;
    originalNumber: string;
    originalHash: string;
  },
  includeTokenEvents = false,
) {
  const chain = evmChain(chainValue),
    address = walletAddress(addressValue, chain),
    network = EVM_NETWORKS[chain];
  const cancellation = new AbortController();
  const readSignal = AbortSignal.any([signal, cancellation.signal]);
  const rpc = (method: string, params: unknown[]) =>
    balanceRpc(
      network.endpoint,
      method,
      params,
      readSignal,
      fetcher,
      (method === 'eth_getBlockByNumber' && params[1] === true) ||
        method === 'eth_getBlockReceipts'
        ? 2097152
        : 524288,
    );
  if (quantity(await rpc('eth_chainId', [])) !== BigInt(network.id))
    throw new Error('Wrong discovery network.');
  const latest = header(await rpc('eth_getBlockByNumber', ['latest', false]));
  if (latest.timestamp < BigInt(Math.floor(Date.now() / 1000) - 900))
    throw new Error('Stale discovery provider.');
  if (
    anchor &&
    (!/^(0|[1-9]\d{0,15})$/.test(anchor.number) ||
      BigInt(anchor.number) > latest.number)
  )
    throw new Error('Invalid older discovery anchor.');
  const tip = anchor
    ? header(
        await rpc('eth_getBlockByNumber', [
          '0x' + BigInt(anchor.number).toString(16),
          false,
        ]),
      )
    : latest;
  if (
    anchor &&
    (tip.number.toString() !== anchor.number ||
      tip.hash !== evmTransactionHash(anchor.hash))
  )
    throw new Error('Older discovery branch changed.');
  const count = Number(tip.number < 9n ? tip.number + 1n : 10n);
  const blocks: Array<{
    anchor: ReturnType<typeof header>;
    transactions: Record<string, unknown>[];
    eventsByHash?: Map<string, EvmTransferEvent[]>;
    matchingEventCount?: number;
  }> = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(3, count) }, async () => {
      while (next < count) {
        readSignal.throwIfAborted();
        const index = next++,
          number = tip.number - BigInt(index);
        const row = object(
            await rpc('eth_getBlockByNumber', [
              '0x' + number.toString(16),
              true,
            ]),
          ),
          anchor = header(row);
        if (
          anchor.number !== number ||
          !Array.isArray(row.transactions) ||
          row.transactions.length > 2000
        )
          throw new Error('Incomplete discovery block.');
        blocks[index] = {
          anchor,
          transactions: row.transactions.map((value) => {
            const tx = object(value);
            return {
              hash: tx.hash,
              blockHash: tx.blockHash,
              blockNumber: tx.blockNumber,
              transactionIndex: tx.transactionIndex,
              from: tx.from,
              to: tx.to,
              value: tx.value,
              ...(tx.chainId === undefined ? {} : { chainId: tx.chainId }),
            };
          }),
        };
        if (includeTokenEvents) {
          const decoded = discoveryReceiptEvents(
            await rpc('eth_getBlockReceipts', [anchor.hash]),
            {
              chain,
              address,
              blockNumber: anchor.number.toString(),
              blockHash: anchor.hash,
              transactions: blocks[index].transactions,
            },
          );
          blocks[index].eventsByHash = decoded.eventsByHash;
          blocks[index].matchingEventCount = decoded.matchingEventCount;
        }
      }
    }),
  ).catch((error: unknown) => {
    cancellation.abort();
    throw error;
  });
  if (
    blocks[0].anchor.hash !== tip.hash ||
    blocks[0].anchor.number !== tip.number ||
    blocks[0].anchor.timestamp !== tip.timestamp ||
    blocks[0].anchor.parentHash !== tip.parentHash
  )
    throw new Error('Discovery tip changed.');
  const candidates: Array<{
    hash: string;
    blockNumber: string;
    blockHash: string;
    transactionIndex: string;
    blockTime: string;
    from: string;
    to: string | null;
    direction: 'Incoming' | 'Outgoing' | 'Self' | 'Token events';
    transferEvents?: EvmTransferEvent[];
    valueRaw: string;
    value: string;
  }> = [];
  const seen = new Set<string>();
  let transactionsScanned = 0;
  let matchingEventCount = 0;
  for (let b = 0; b < blocks.length; b++) {
    const { anchor, transactions } = blocks[b];
    if (
      b &&
      (blocks[b - 1].anchor.parentHash !== anchor.hash ||
        blocks[b - 1].anchor.timestamp < anchor.timestamp)
    )
      throw new Error('Discovery block chain is inconsistent.');
    transactionsScanned += transactions.length;
    matchingEventCount += blocks[b].matchingEventCount ?? 0;
    if (matchingEventCount > 1000)
      throw new Error('Discovery event limit reached.');
    if (transactionsScanned > 10000)
      throw new Error('Discovery window exceeds transaction bound.');
    const found: typeof candidates = [];
    for (let i = 0; i < transactions.length; i++) {
      const tx = transactions[i],
        hash = evmTransactionHash(tx.hash);
      if (
        seen.has(hash) ||
        evmTransactionHash(tx.blockHash) !== anchor.hash ||
        quantity(tx.blockNumber) !== anchor.number ||
        quantity(tx.transactionIndex) !== BigInt(i) ||
        (tx.chainId !== undefined &&
          quantity(tx.chainId) !== BigInt(network.id))
      )
        throw new Error('Discovery transaction context mismatch.');
      seen.add(hash);
      if (
        typeof tx.from !== 'string' ||
        !/^0x[0-9a-fA-F]{40}$/.test(tx.from) ||
        (tx.to !== null &&
          (typeof tx.to !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(tx.to)))
      )
        throw new Error('Invalid discovery participants.');
      const from = getAddress(tx.from),
        to = tx.to === null ? null : getAddress(tx.to as string),
        value = quantity(tx.value);
      const transferEvents = blocks[b].eventsByHash?.get(hash) ?? [];
      if (from !== address && to !== address && !transferEvents.length)
        continue;
      found.push({
        hash,
        blockNumber: anchor.number.toString(),
        blockHash: anchor.hash,
        transactionIndex: String(i),
        blockTime: new Date(Number(anchor.timestamp) * 1000).toISOString(),
        from,
        to,
        direction:
          from === address
            ? to === address
              ? 'Self'
              : 'Outgoing'
            : to === address
              ? 'Incoming'
              : 'Token events',
        ...(includeTokenEvents ? { transferEvents } : {}),
        valueRaw: value.toString(),
        value: formatNativeBalance(value.toString(), 18),
      });
      if (candidates.length + found.length > 100)
        throw new Error(
          'Too many discovery matches. Narrower indexing is required.',
        );
    }
    candidates.push(...found.reverse());
  }
  const final = header(
    await rpc('eth_getBlockByNumber', ['0x' + tip.number.toString(16), false]),
  );
  if (
    final.hash !== tip.hash ||
    final.number !== tip.number ||
    final.timestamp !== tip.timestamp ||
    final.parentHash !== tip.parentHash
  )
    throw new Error('Discovery anchor changed.');
  signal.throwIfAborted();
  if (anchor) {
    const [child, original] = await Promise.all([
      rpc('eth_getBlockByNumber', [
        '0x' + BigInt(anchor.childNumber).toString(16),
        false,
      ]).then(header),
      rpc('eth_getBlockByNumber', [
        '0x' + BigInt(anchor.originalNumber).toString(16),
        false,
      ]).then(header),
    ]);
    if (
      child.number !== tip.number + 1n ||
      child.hash !== anchor.childHash ||
      child.parentHash !== tip.hash ||
      child.timestamp < tip.timestamp ||
      original.number.toString() !== anchor.originalNumber ||
      original.hash !== anchor.originalHash
    )
      throw new Error(
        'Saved discovery branch changed. Refresh the latest window.',
      );
  }
  signal.throwIfAborted();
  return {
    chain,
    address,
    source: new URL(network.endpoint).hostname,
    observedAt: new Date().toISOString(),
    currency: network.currency,
    fromBlock: blocks[count - 1].anchor.number.toString(),
    toBlock: tip.number.toString(),
    blockHash: tip.hash,
    fromBlockHash: blocks[count - 1].anchor.hash,
    fromParentHash: blocks[count - 1].anchor.parentHash,
    blocksScanned: count,
    transactionsScanned,
    candidates,
    includesTokenEvents: includeTokenEvents,
    matchingEventCount,
    coverage: includeTokenEvents
      ? 'Direct participants and ERC-20-layout transfer events from block-bound receipt sets in this window. NFT/nonstandard layouts are omitted. Inspect a selected hash for detailed status and gas cost. Events do not prove balance changes or authentic token contracts. No internal transfers, pending transactions, trade classification, wallet age or finality.'
      : 'Direct transaction sender/recipient matches in this block window only. No token-only events, internal transfers, pending transactions, receipt status, trade classification or wallet age. This is not complete address history or finality.',
  };
}
export type EvmDiscoveryWindow = Awaited<
  ReturnType<typeof discoverEvmTransactions>
>;
export type DiscoveryPage = Pick<
  EvmDiscoveryWindow,
  | 'fromBlock'
  | 'toBlock'
  | 'blockHash'
  | 'observedAt'
  | 'blocksScanned'
  | 'transactionsScanned'
>;
export type EvmDiscovery = EvmDiscoveryWindow & { pages?: DiscoveryPage[] };
export function olderDiscoveryAnchor(previous: EvmDiscovery) {
  const pages = previous.pages ?? [previous];
  if (
    !/^(0|[1-9]\d{0,15})$/.test(previous.fromBlock) ||
    BigInt(previous.fromBlock) === 0n ||
    pages.length >= 20 ||
    previous.candidates.length >= 100
  )
    throw new Error('Discovery continuation limit reached.');
  return {
    number: (BigInt(previous.fromBlock) - 1n).toString(),
    hash: evmTransactionHash(previous.fromParentHash),
    childNumber: previous.fromBlock,
    childHash: evmTransactionHash(previous.fromBlockHash),
    originalNumber: previous.toBlock,
    originalHash: evmTransactionHash(previous.blockHash),
  };
}
export function appendDiscovery(
  previous: EvmDiscovery,
  older: EvmDiscoveryWindow,
): EvmDiscovery {
  const anchor = olderDiscoveryAnchor(previous);
  if (
    older.chain !== previous.chain ||
    Boolean(older.includesTokenEvents) !==
      Boolean(previous.includesTokenEvents) ||
    (older.matchingEventCount ?? 0) + (previous.matchingEventCount ?? 0) >
      1000 ||
    older.address !== previous.address ||
    older.toBlock !== anchor.number ||
    older.blockHash !== anchor.hash ||
    BigInt(older.fromBlock) >= BigInt(previous.fromBlock) ||
    older.observedAt <= previous.observedAt ||
    older.candidates.some((c) =>
      previous.candidates.some((p) => p.hash === c.hash),
    ) ||
    older.candidates.length + previous.candidates.length > 100
  )
    throw new Error('Older discovery does not extend this scan.');
  const page = (p: EvmDiscoveryWindow): DiscoveryPage => ({
    fromBlock: p.fromBlock,
    toBlock: p.toBlock,
    blockHash: p.blockHash,
    observedAt: p.observedAt,
    blocksScanned: p.blocksScanned,
    transactionsScanned: p.transactionsScanned,
  });
  return {
    ...previous,
    fromBlock: older.fromBlock,
    fromBlockHash: older.fromBlockHash,
    fromParentHash: older.fromParentHash,
    observedAt: older.observedAt,
    blocksScanned: previous.blocksScanned + older.blocksScanned,
    transactionsScanned:
      previous.transactionsScanned + older.transactionsScanned,
    candidates: [...previous.candidates, ...older.candidates],
    matchingEventCount:
      (previous.matchingEventCount ?? 0) + (older.matchingEventCount ?? 0),
    pages: [...(previous.pages ?? [page(previous)]), page(older)],
  };
}
