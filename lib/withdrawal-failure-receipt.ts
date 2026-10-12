import { getCompiledTransactionMessageDecoder } from '@solana/kit';
import type { NativeWithdrawalReview } from './native-withdrawal';
import {
  withdrawalFailureReason,
  validatedWithdrawalFailure,
} from './withdrawal-failure';
import { getSolanaRpcEndpoint } from './solana-rpc';
const uint = (value: unknown) => {
  if (
    typeof value !== 'string' ||
    !/^(0|[1-9]\d{0,19})$/.test(value) ||
    BigInt(value) > (1n << 64n) - 1n
  )
    throw new Error('Failure balance evidence unavailable.');
  return BigInt(value);
};
const slot = (value: unknown) => {
  const n = Number(uint(value));
  if (!Number.isSafeInteger(n)) throw new Error('Failure slot unavailable.');
  return n;
};
/** Caller must first verify the exact retained packet and wallet signature. */
export function decodeWithdrawalFailure(
  result: {
    slot: unknown;
    blockTime: unknown;
    meta: {
      err: unknown;
      fee: unknown;
      preBalances: unknown[];
      postBalances: unknown[];
    };
  },
  review: NativeWithdrawalReview,
  signature: string,
  message: Uint8Array,
) {
  const compiled = getCompiledTransactionMessageDecoder().decode(message),
    count = compiled.staticAccounts.length,
    meta = result.meta;
  if (compiled.version !== 'legacy')
    throw new Error('Withdrawal failure packet version differs.');
  if (
    !Array.isArray(meta.preBalances) ||
    !Array.isArray(meta.postBalances) ||
    meta.preBalances.length !== count ||
    meta.postBalances.length !== count
  )
    throw new Error('Failure balance context differs.');
  const before = meta.preBalances.map(uint),
    after = meta.postBalances.map(uint),
    fee = uint(meta.fee),
    error = withdrawalFailureReason(meta.err);
  if (
    after[0] - before[0] !== -fee ||
    before.some((v, i) => i > 0 && v !== after[i]) ||
    (error.instructionIndex !== undefined &&
      error.instructionIndex >= compiled.instructions.length)
  )
    throw new Error('Failure fee or account changes differ.');
  return validatedWithdrawalFailure(
    {
      failed: true,
      network: 'mainnet',
      commitment: 'finalized',
      signatureVerified: true,
      signature,
      wallet: review.wallet,
      recipient: review.recipient,
      requestedAmountRaw: review.amountRaw,
      sha256: review.sha256,
      slot: slot(result.slot),
      blockTime: result.blockTime === null ? null : slot(result.blockTime),
      networkFeeLamports: fee.toString(),
      walletChangeRaw: (-fee).toString(),
      feeLimitExceeded: fee > uint(review.feeLamports),
      error,
      observedAt: new Date().toISOString(),
      source: new URL(getSolanaRpcEndpoint('mainnet')).hostname,
    },
    review,
    signature,
  );
}
