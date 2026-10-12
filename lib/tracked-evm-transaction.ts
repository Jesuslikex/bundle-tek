import { EVM_NETWORKS, evmChain } from './evm-network';
import { walletAddress } from './wallet-workspace';
import { balanceRpc } from './wallet-balances';
import { warmupDecimal } from './wallet-warmup';
import { decodeEvmTransferLogs } from './evm-transfer-logs';
import type { TransferIdentityReport } from './evm-transfer-identity';

export function evmTransactionHash(value: unknown): string {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(value))
    throw new Error('Enter a complete EVM transaction hash.');
  return value.toLowerCase();
}
function uint(value: unknown) {
  if (
    typeof value !== 'string' ||
    !/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]{0,63})$/.test(value)
  )
    throw new Error('Invalid transaction quantity.');
  return BigInt(value);
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Incomplete transaction data.');
  return value as Record<string, unknown>;
}
export async function observeEvmTransaction(
  chainValue: unknown,
  addressValue: unknown,
  hashValue: unknown,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
) {
  const chain = evmChain(chainValue),
    address = walletAddress(addressValue, chain),
    hash = evmTransactionHash(hashValue);
  const network = EVM_NETWORKS[chain];
  const rpc = (method: string, params: unknown[]) =>
    balanceRpc(network.endpoint, method, params, signal, fetcher);
  if (uint(await rpc('eth_chainId', [])) !== BigInt(network.id))
    throw new Error('Wrong transaction network.');
  const [rawTx, rawReceipt] = await Promise.all([
    rpc('eth_getTransactionByHash', [hash]),
    rpc('eth_getTransactionReceipt', [hash]),
  ]);
  if (rawTx === null || rawReceipt === null) return null;
  const tx = object(rawTx),
    receipt = object(rawReceipt);
  const blockHash = evmTransactionHash(tx.blockHash),
    blockNumber = uint(tx.blockNumber).toString(),
    index = uint(tx.transactionIndex);
  if (
    evmTransactionHash(tx.hash) !== hash ||
    evmTransactionHash(receipt.transactionHash) !== hash ||
    evmTransactionHash(receipt.blockHash) !== blockHash ||
    uint(receipt.blockNumber).toString() !== blockNumber ||
    uint(receipt.transactionIndex) !== index
  )
    throw new Error('Transaction receipt identity mismatch.');
  if (tx.chainId !== undefined && uint(tx.chainId) !== BigInt(network.id))
    throw new Error('Transaction chain mismatch.');
  const from = walletAddress(tx.from, chain),
    to = tx.to === null ? null : walletAddress(tx.to, chain);
  if (
    walletAddress(receipt.from, chain) !== from ||
    (receipt.to === null ? null : walletAddress(receipt.to, chain)) !== to
  )
    throw new Error('Receipt participants mismatch.');
  const status = uint(receipt.status);
  if (status !== 0n && status !== 1n)
    throw new Error('Invalid receipt status.');
  const transfers = decodeEvmTransferLogs(receipt.logs, {
    chain,
    address,
    hash,
    blockHash,
    blockNumber,
    transactionIndex: index.toString(),
    failed: status === 0n,
  });
  const directParticipant = from === address || to === address;
  if (!directParticipant && !transfers.events.length)
    throw new Error('Transaction does not involve this tracked address.');
  const value = uint(tx.value),
    gasUsed = uint(receipt.gasUsed),
    gasPrice = uint(receipt.effectiveGasPrice);
  if (gasUsed > uint(tx.gas))
    throw new Error('Receipt gas exceeds transaction limit.');
  if (typeof tx.input !== 'string' || !/^0x(?:[0-9a-fA-F]{2})*$/.test(tx.input))
    throw new Error('Invalid transaction input.');
  const header = object(
    await rpc('eth_getBlockByNumber', [tx.blockNumber, false]),
  );
  if (
    evmTransactionHash(header.hash) !== blockHash ||
    uint(header.number).toString() !== blockNumber ||
    !Array.isArray(header.transactions) ||
    index >= BigInt(header.transactions.length) ||
    evmTransactionHash(header.transactions[Number(index)]) !== hash
  )
    throw new Error('Transaction is not in the canonical block.');
  const timestamp = uint(header.timestamp) * 1000n;
  if (timestamp < 1577836800000n || timestamp > BigInt(Date.now() + 300000))
    throw new Error('Invalid transaction block time.');
  const final = object(
    await rpc('eth_getBlockByNumber', [tx.blockNumber, false]),
  );
  if (
    final.hash !== header.hash ||
    final.number !== header.number ||
    final.timestamp !== header.timestamp
  )
    throw new Error('Transaction block changed during inspection.');
  const executionGasCost = gasUsed * gasPrice;
  return {
    chain,
    address,
    hash,
    from,
    to,
    blockHash,
    blockNumber,
    transactionIndex: index.toString(),
    blockTime: new Date(Number(timestamp)).toISOString(),
    status: status === 1n ? ('Succeeded' as const) : ('Reverted' as const),
    direction:
      from === address
        ? to === address
          ? ('Self' as const)
          : ('Outgoing' as const)
        : to === address
          ? ('Incoming' as const)
          : ('Token events' as const),
    directParticipant,
    transferEvents: transfers.events,
    receiptLogCount: transfers.receiptLogCount,
    tokenIdentity: undefined as TransferIdentityReport | undefined,
    valueRaw: value.toString(),
    value: warmupDecimal(value, 18),
    currency: network.currency,
    gasUsed: gasUsed.toString(),
    effectiveGasPriceRaw: gasPrice.toString(),
    executionGasCostRaw: executionGasCost.toString(),
    executionGasCost: warmupDecimal(executionGasCost, 18),
    inputBytes: (tx.input.length - 2) / 2,
    selector:
      tx.input.length >= 10 ? tx.input.slice(0, 10).toLowerCase() : null,
    observedAt: new Date().toISOString(),
    source: new URL(network.endpoint).hostname,
    limitations:
      'Mined provider observation, not finality or an owned execution receipt. Declared native value is the transaction value, not this wallet’s net change, and may not transfer on revert. Execution gas cost belongs to the transaction sender and excludes additional chain, L1 and blob fees. Transfer events use the ERC-20 event layout; emitting contracts and balance changes are not independently verified. No token decimals, NFT decoding, internal native transfers, trade classification or wallet ownership proof.',
  };
}
export type EvmTransactionObservation = NonNullable<
  Awaited<ReturnType<typeof observeEvmTransaction>>
>;
