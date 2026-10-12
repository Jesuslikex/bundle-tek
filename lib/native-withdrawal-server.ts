import { decodeWithdrawalFailure } from './withdrawal-failure-receipt';
import type { NativeWithdrawalFailureReceipt } from './withdrawal-failure';
import { prepareSolanaFunding } from './solana-funding';
import { solanaTransferMessage } from './solana-transfer-message';
import { balanceRpc, SOLANA_MAINNET_GENESIS } from './wallet-balances';
import {
  getSolanaRpcEndpoint,
  requireConsistentSolanaSlots,
} from './solana-rpc';
import { solanaTokenAtoms } from './solana-token-amount';
import {
  inspectNativeWithdrawal,
  type NativeWithdrawalReview,
  type NativeWithdrawalReceipt,
  type withdrawalInput,
} from './native-withdrawal';
const SYSTEM = '11111111111111111111111111111111';
const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const decode = (value: string) => {
  if (
    typeof value !== 'string' ||
    value.length > 1644 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    )
  )
    throw new Error('Invalid withdrawal packet.');
  const bytes = Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
  if (encode(bytes) !== value) throw new Error();
  return bytes;
};
const uint = (value: unknown) => {
  if (
    typeof value !== 'string' ||
    !/^(0|[1-9]\d{0,19})$/.test(value) ||
    BigInt(value) > (1n << 64n) - 1n
  )
    throw new Error('Invalid withdrawal integer.');
  return BigInt(value);
};
const slot = (value: unknown) => {
  const n = Number(uint(value));
  if (!Number.isSafeInteger(n)) throw new Error();
  return n;
};
const sha = async (bytes: Uint8Array) =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes).buffer),
    ),
    (b) => b.toString(16).padStart(2, '0'),
  ).join('');
export async function prepareNativeWithdrawal(
  input: ReturnType<typeof withdrawalInput>,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<NativeWithdrawalReview> {
  const prepared = await prepareSolanaFunding(
    {
      name: 'Native SOL withdrawal',
      chain: 'Solana',
      currency: 'SOL',
      source: 'Wallet',
      sourceLabel: '',
      funderAddress: input.wallet,
      startAt: new Date(Date.now() - 1000).toISOString(),
      delaySeconds: 0,
      recipients: [{ address: input.recipient, amount: input.amount }],
    },
    signal,
    fetcher,
  );
  const transfer = prepared.transactions[0];
  const review: NativeWithdrawalReview = {
    ...input,
    id: crypto.randomUUID(),
    network: 'mainnet',
    feeLamports: transfer.feeLamports,
    reserveLamports: solanaTokenAtoms(prepared.rentReserve, 9).toString(),
    maximumDebitRaw: (
      BigInt(input.amountRaw) + BigInt(transfer.feeLamports)
    ).toString(),
    blockhash: prepared.blockhash,
    lastValidBlockHeight: prepared.lastValidBlockHeight,
    slot: prepared.slot,
    transaction: transfer.unsignedTransactionBase64,
    sha256: await sha(decode(transfer.unsignedTransactionBase64)),
    preparedAt: prepared.preparedAt,
    expiresAt: prepared.expiresAt,
    source: prepared.source,
  };
  await inspectNativeWithdrawal(review, review.transaction, false);
  return review;
}
export async function recheckNativeWithdrawal(
  review: NativeWithdrawalReview,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
) {
  await inspectNativeWithdrawal(review, review.transaction, false);
  if (Date.parse(review.expiresAt) <= Date.now())
    throw new Error('Withdrawal approval expired.');
  const endpoint = getSolanaRpcEndpoint('mainnet'),
    rpc = (method: string, params: unknown[]) =>
      balanceRpc(endpoint, method, params, signal, fetcher);
  if ((await rpc('getGenesisHash', [])) !== SOLANA_MAINNET_GENESIS)
    throw new Error('Withdrawal network differs.');
  const config = {
    encoding: 'base64',
    commitment: 'finalized',
    minContextSlot: review.slot,
  };
  const accounts = (await rpc('getMultipleAccounts', [
    [review.wallet, review.recipient],
    config,
  ])) as {
    context: { slot: string };
    value: ({
      lamports: string;
      owner: string;
      executable: boolean;
      data: [string, string];
    } | null)[];
  };
  if (
    !Array.isArray(accounts.value) ||
    accounts.value.length !== 2 ||
    !accounts.value[0]
  )
    throw new Error('Withdrawal accounts unavailable.');
  for (const account of accounts.value)
    if (
      account &&
      (account.owner !== SYSTEM ||
        account.executable !== false ||
        account.data?.[0] !== '' ||
        account.data?.[1] !== 'base64')
    )
      throw new Error('Use ordinary system wallets without account data.');
  const slots = [slot(accounts.context.slot)];
  const reserve = uint(
    await rpc('getMinimumBalanceForRentExemption', [
      0,
      { commitment: 'finalized' },
    ]),
  );
  if (
    uint(accounts.value[0].lamports) < uint(review.maximumDebitRaw) + reserve ||
    uint(accounts.value[1]?.lamports ?? '0') + uint(review.amountRaw) < reserve
  )
    throw new Error(
      'Balance or rent reserve no longer covers this withdrawal.',
    );
  const fee = (await rpc('getFeeForMessage', [
    encode(
      solanaTransferMessage(
        review.wallet,
        review.recipient,
        review.blockhash,
        uint(review.amountRaw),
      ),
    ),
    { commitment: 'finalized', minContextSlot: review.slot },
  ])) as { context: { slot: string }; value: string | null };
  slots.push(slot(fee.context.slot));
  if (fee.value === null || uint(fee.value) > uint(review.feeLamports))
    throw new Error('Withdrawal fee changed or blockhash expired.');
  const sim = (await rpc('simulateTransaction', [
    review.transaction,
    {
      encoding: 'base64',
      commitment: 'finalized',
      sigVerify: false,
      replaceRecentBlockhash: false,
      minContextSlot: review.slot,
    },
  ])) as { context: { slot: string }; value: { err: unknown } };
  slots.push(slot(sim.context.slot));
  if (sim.value?.err !== null) throw new Error('Withdrawal simulation failed.');
  const valid = (await rpc('isBlockhashValid', [
    review.blockhash,
    { commitment: 'finalized', minContextSlot: review.slot },
  ])) as { context: { slot: string }; value: boolean };
  slots.push(slot(valid.context.slot));
  if (slots.some((s) => s < review.slot))
    throw new Error('Withdrawal checks returned a stale context slot.');
  requireConsistentSolanaSlots(slots);
  if (
    valid.value !== true ||
    uint(await rpc('getBlockHeight', [{ commitment: 'finalized' }])) >=
      uint(review.lastValidBlockHeight) ||
    Date.parse(review.expiresAt) <= Date.now()
  )
    throw new Error('Withdrawal blockhash or approval expired.');
  signal.throwIfAborted();
}
export async function decodeNativeWithdrawalReceipt(
  raw: unknown,
  review: NativeWithdrawalReview,
  signature: string,
): Promise<NativeWithdrawalReceipt | NativeWithdrawalFailureReceipt> {
  const result = raw as {
    slot: string;
    blockTime: string | null;
    version: 'legacy';
    transaction: [string, string];
    meta: {
      err: unknown;
      fee: string;
      preBalances: string[];
      postBalances: string[];
    };
  };
  if (
    !result ||
    result.version !== 'legacy' ||
    !Array.isArray(result.transaction) ||
    result.transaction[1] !== 'base64' ||
    !result.meta ||
    result.meta.err === undefined ||
    slot(result.slot) < review.slot
  )
    throw new Error('Finalized withdrawal receipt unavailable.');
  const signed = await inspectNativeWithdrawal(
    review,
    result.transaction[0],
    true,
  );
  if (signed.signature !== signature)
    throw new Error('Finalized withdrawal signature differs.');
  if (result.meta.err !== null)
    return decodeWithdrawalFailure(result, review, signature, signed.message);
  const meta = result.meta;
  if (
    !Array.isArray(meta.preBalances) ||
    !Array.isArray(meta.postBalances) ||
    meta.preBalances.length !== 3 ||
    meta.postBalances.length !== 3
  )
    throw new Error('Withdrawal receipt account balances differ.');
  const before = meta.preBalances.map(uint),
    after = meta.postBalances.map(uint),
    fee = uint(meta.fee),
    amount = uint(review.amountRaw);
  if (
    fee > uint(review.feeLamports) ||
    after[0] - before[0] !== -(amount + fee) ||
    after[1] - before[1] !== amount ||
    after[2] !== before[2]
  )
    throw new Error('Finalized withdrawal settlement differs.');
  return {
    network: 'mainnet',
    commitment: 'finalized',
    signatureVerified: true,
    signature,
    wallet: review.wallet,
    recipient: review.recipient,
    amountRaw: review.amountRaw,
    networkFeeLamports: fee.toString(),
    walletChangeRaw: (after[0] - before[0]).toString(),
    recipientChangeRaw: amount.toString(),
    slot: slot(result.slot),
    blockTime: result.blockTime === null ? null : slot(result.blockTime),
    sha256: review.sha256,
    observedAt: new Date().toISOString(),
    source: new URL(getSolanaRpcEndpoint('mainnet')).hostname,
  };
}
