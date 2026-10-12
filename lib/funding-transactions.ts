import { parseUnits } from 'viem';
import {
  fundingTransfers,
  reviewFundingFees,
  type FundingFeeReview,
} from './funding-fees';
import { balanceRpc } from './wallet-balances';
import { formatNativeBalance } from './wallet-balance-format';

export class FundingPreparationError extends Error {
  override name = 'FundingPreparationError';
}

const hex = (value: bigint) => `0x${value.toString(16)}`;
function quantity(value: unknown) {
  if (
    typeof value !== 'string' ||
    !/^0x(?:0|[1-9a-f][0-9a-f]{0,63})$/i.test(value)
  )
    throw new FundingPreparationError('Invalid transaction provider quantity.');
  return BigInt(value);
}
export type UnsignedFundingBatch = {
  version: 1;
  executionAllowed: false;
  signed: false;
  chain: string;
  chainId: number;
  funder: string;
  contract: string | null;
  currency: string;
  nativeCurrency: string;
  draftHash: string;
  preparedAt: string;
  expiresAt: string;
  source: string;
  blockNumber: number;
  blockHash: string;
  startingNonce: string;
  gasAllowancePercent: 20;
  maximumGasFee: string;
  nativeRequired: string;
  review: FundingFeeReview;
  transactions: {
    recipient: string;
    amount: string;
    transaction: {
      type: '0x0';
      chainId: string;
      from: string;
      to: string;
      value: string;
      data: string;
      nonce: string;
      gas: string;
      gasPrice: string;
    };
  }[];
};
export async function prepareUnsignedFunding(
  value: unknown,
  signal: AbortSignal = AbortSignal.timeout(45000),
  fetcher: typeof fetch = fetch,
): Promise<UnsignedFundingBatch> {
  const started = Date.now();
  const plan = fundingTransfers(value);
  if (plan.document.delaySeconds || Date.parse(plan.document.startAt) > started)
    throw new FundingPreparationError(
      'Use an immediate wallet funding draft. Scheduled execution is not available.',
    );
  const review = await reviewFundingFees(value, signal, fetcher);
  if (
    review.transferShortfall !== '0' ||
    review.nativeShortfall !== '0' ||
    review.transfers.some((item) => item.gas === null)
  )
    throw new FundingPreparationError(
      'Funder balance does not cover this batch.',
    );
  const rpc = (method: string, params: unknown[]) =>
    balanceRpc(plan.network.endpoint, method, params, signal, fetcher);
  const reference = { blockHash: review.blockHash, requireCanonical: true };
  const [mined, pending, code, header] = await Promise.all([
    rpc('eth_getTransactionCount', [plan.funder, reference]),
    rpc('eth_getTransactionCount', [plan.funder, 'pending']),
    rpc('eth_getCode', [plan.funder, reference]),
    rpc('eth_getBlockByNumber', [hex(BigInt(review.blockNumber)), false]),
  ]);
  const nonce = quantity(mined);
  if (nonce !== quantity(pending))
    throw new FundingPreparationError(
      'Funder has pending transactions. Wait for them to settle and refresh.',
    );
  if (nonce + BigInt(plan.transfers.length) > (1n << 64n) - 1n)
    throw new FundingPreparationError(
      'Funding nonce exceeds the EVM account limit.',
    );
  if (code !== '0x')
    throw new FundingPreparationError(
      'Smart-contract and delegated funders are not supported by this transaction planner.',
    );
  if (
    !header ||
    typeof header !== 'object' ||
    !('hash' in header) ||
    header.hash !== review.blockHash ||
    !('gasLimit' in header)
  )
    throw new FundingPreparationError(
      'Funding observation block changed or is incomplete.',
    );
  const blockGasLimit = quantity(header.gasLimit);
  const gasPrice = BigInt(review.gasPriceRaw);
  const transactions = plan.transfers.map((transfer, index) => {
    const gas = (BigInt(review.transfers[index].gas!) * 120n + 99n) / 100n;
    if (!gas || gas > blockGasLimit || gas > 10_000_000n)
      throw new FundingPreparationError(
        'Buffered transfer gas exceeds the supported block limit.',
      );
    return {
      recipient: transfer.recipient,
      amount: transfer.amount,
      transaction: {
        type: '0x0' as const,
        chainId: hex(BigInt(plan.network.id)),
        ...transfer.transaction,
        nonce: hex(nonce + BigInt(index)),
        gas: hex(gas),
        gasPrice: hex(gasPrice),
      },
    };
  });
  const maximumGas = transactions.reduce(
    (sum, item) => sum + quantity(item.transaction.gas) * gasPrice,
    0n,
  );
  const required = maximumGas + (plan.contract ? 0n : plan.totalRaw);
  if (required > parseUnits(review.nativeBalance, 18))
    throw new FundingPreparationError(
      'Native balance does not cover transfers and the 20% gas allowance.',
    );
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, transactions.length) }, async () => {
      while (next < transactions.length) {
        const index = next++;
        const item = transactions[index];
        // Reject recipients whose fallback/delegation would make this a contract operation.
        if ((await rpc('eth_getCode', [item.recipient, reference])) !== '0x')
          throw new FundingPreparationError(
            'Contract or delegated recipients need a separate execution review.',
          );
        const { from, to, value, data, gas } = item.transaction;
        const result = await rpc('eth_call', [
          { from, to, value, data, gas },
          reference,
        ]);
        if (
          plan.contract
            ? result !== '0x' && result !== `0x${'0'.repeat(63)}1`
            : result !== '0x'
        )
          throw new FundingPreparationError(
            'Transfer simulation failed or returned an unsupported result.',
          );
      }
    }),
  );
  const [finalNonce, finalHeader, finalChain, finalGasPrice] =
    await Promise.all([
      rpc('eth_getTransactionCount', [plan.funder, 'pending']),
      rpc('eth_getBlockByNumber', [hex(BigInt(review.blockNumber)), false]),
      rpc('eth_chainId', []),
      rpc('eth_gasPrice', []),
    ]);
  if (
    quantity(finalNonce) !== nonce ||
    !finalHeader ||
    typeof finalHeader !== 'object' ||
    !('hash' in finalHeader) ||
    finalHeader.hash !== review.blockHash ||
    quantity(finalChain) !== BigInt(plan.network.id) ||
    quantity(finalGasPrice) > gasPrice
  )
    throw new FundingPreparationError(
      'Funding network, nonce or observation block changed. Refresh preparation.',
    );
  if (signal.aborted || Date.now() >= started + 60_000)
    throw new FundingPreparationError(
      'Funding preparation expired. Refresh preparation.',
    );
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify(plan.document)),
  );
  return {
    version: 1,
    executionAllowed: false,
    signed: false,
    chain: plan.chain,
    chainId: plan.network.id,
    funder: plan.funder,
    contract: plan.contract,
    currency: plan.document.currency,
    nativeCurrency: plan.network.currency,
    draftHash: Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, '0'),
    ).join(''),
    preparedAt: new Date(started).toISOString(),
    expiresAt: new Date(started + 60_000).toISOString(),
    source: review.source,
    blockNumber: review.blockNumber,
    blockHash: review.blockHash,
    startingNonce: nonce.toString(),
    gasAllowancePercent: 20,
    maximumGasFee: formatNativeBalance(maximumGas.toString(), 18),
    nativeRequired: formatNativeBalance(required.toString(), 18),
    review,
    transactions,
  };
}
