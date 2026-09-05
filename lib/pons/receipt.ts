import { type Hex, type PublicClient } from 'viem';
import { PonsError } from './intent';
import { CHAIN_ID } from './chain';
export const REQUIRED_CONFIRMATIONS = 12n;
export type ReceiptState =
  | 'submitted'
  | 'confirming'
  | 'confirmed'
  | 'reverted'
  | 'reorged';
export type ReceiptObservation = {
  txHash: Hex;
  blockNumber?: string;
  blockHash?: Hex;
  confirmations: string;
  status: string;
  observedAt: number;
  requiredConfirmations: string;
  finality: 'not asserted';
};
export type StoredSimulation = {
  ok: boolean;
  unsignedTransaction: {
    chainId: number;
    from: string;
    to: string;
    value: string;
    data: string;
    nonce: number;
  };
  receipt?: ReceiptObservation;
  [key: string]: unknown;
};
const eq = (a: string | null | undefined, b: string) =>
  typeof a === 'string' && a.toLowerCase() === b.toLowerCase();
export async function observeReceipt(
  stored: StoredSimulation,
  hash: Hex,
  client: PublicClient,
): Promise<{ state: ReceiptState; receipt: ReceiptObservation }> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash))
    throw new PonsError(400, 'INVALID_TX_HASH');
  if (!stored.ok || !stored.unsignedTransaction)
    throw new PonsError(409, 'SIMULATION_REQUIRED');
  if (stored.receipt && !eq(stored.receipt.txHash, hash))
    throw new PonsError(409, 'TRANSACTION_ALREADY_BOUND');
  if ((await client.getChainId()) !== CHAIN_ID)
    throw new PonsError(422, 'WRONG_RPC_CHAIN');
  const base = {
    txHash: hash,
    observedAt: Date.now(),
    requiredConfirmations: REQUIRED_CONFIRMATIONS.toString(),
    finality: 'not asserted' as const,
  };
  const previous = stored.receipt;
  const reorged = (): { state: ReceiptState; receipt: ReceiptObservation } => ({
    state: 'reorged',
    receipt: {
      ...previous,
      ...base,
      status: 'noncanonical',
      confirmations: '0',
    },
  });
  const previousReorg = async () =>
    previous?.blockNumber &&
    previous.blockHash &&
    (await client.getBlock({ blockNumber: BigInt(previous.blockNumber) }))
      .hash !== previous.blockHash;
  let tx;
  try {
    tx = await client.getTransaction({ hash });
  } catch (e) {
    if ((e as Error).name !== 'TransactionNotFoundError') throw e;
    if (await previousReorg()) return reorged();
    throw new PonsError(404, 'TRANSACTION_NOT_FOUND');
  }
  const unsigned = stored.unsignedTransaction;
  if (
    tx.chainId !== CHAIN_ID ||
    unsigned.chainId !== CHAIN_ID ||
    !eq(tx.hash, hash) ||
    !eq(tx.from, unsigned.from) ||
    !eq(tx.to, unsigned.to) ||
    tx.value.toString() !== unsigned.value ||
    !eq(tx.input, unsigned.data) ||
    tx.nonce !== unsigned.nonce
  )
    throw new PonsError(422, 'TRANSACTION_MISMATCH');
  const maximumGasPrice = tx.maxFeePerGas ?? tx.gasPrice;
  if (
    typeof stored.maxGasCostWei !== 'string' ||
    typeof stored.maxTotalValueWei !== 'string' ||
    typeof maximumGasPrice !== 'bigint' ||
    typeof tx.gas !== 'bigint'
  )
    throw new PonsError(409, 'SIMULATION_COST_CAP_REQUIRED');
  if (
    tx.gas * maximumGasPrice > BigInt(stored.maxGasCostWei) ||
    tx.value > BigInt(stored.maxTotalValueWei)
  )
    throw new PonsError(422, 'TRANSACTION_COST_CEILING_EXCEEDED');
  let receipt;
  try {
    receipt = await client.getTransactionReceipt({ hash });
  } catch (e) {
    if ((e as Error).name !== 'TransactionReceiptNotFoundError') throw e;
    if (await previousReorg()) return reorged();
    if (previous?.blockHash)
      throw new PonsError(502, 'RECEIPT_TEMPORARILY_UNAVAILABLE');
    return {
      state: 'submitted',
      receipt: { ...base, status: 'pending', confirmations: '0' },
    };
  }
  if (
    !eq(receipt.transactionHash, hash) ||
    !eq(receipt.from, unsigned.from) ||
    !eq(receipt.to, unsigned.to) ||
    !eq(tx.blockHash, receipt.blockHash) ||
    tx.blockNumber !== receipt.blockNumber
  )
    throw new PonsError(422, 'RECEIPT_TRANSACTION_MISMATCH');
  const canonical = await client.getBlock({ blockNumber: receipt.blockNumber });
  const mined = {
    ...base,
    blockNumber: receipt.blockNumber.toString(),
    blockHash: receipt.blockHash,
  };
  if (canonical.hash !== receipt.blockHash)
    return {
      state: 'reorged',
      receipt: { ...mined, status: 'noncanonical', confirmations: '0' },
    };
  const head = await client.getBlock({ blockTag: 'latest' });
  if (head.number === null || head.number < receipt.blockNumber)
    throw new PonsError(502, 'INVALID_RECEIPT_HEAD');
  if (
    (await client.getBlock({ blockNumber: receipt.blockNumber })).hash !==
    receipt.blockHash
  )
    return {
      state: 'reorged',
      receipt: { ...mined, status: 'noncanonical', confirmations: '0' },
    };
  if (receipt.status !== 'success' && receipt.status !== 'reverted')
    throw new PonsError(502, 'INVALID_RECEIPT_STATUS');
  const confirmations = head.number - receipt.blockNumber + 1n;
  return {
    state:
      receipt.status === 'reverted'
        ? 'reverted'
        : confirmations >= REQUIRED_CONFIRMATIONS
          ? 'confirmed'
          : 'confirming',
    receipt: {
      ...mined,
      status: receipt.status,
      confirmations: confirmations.toString(),
    },
  };
}
