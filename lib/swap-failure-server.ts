import {
  getBase64Encoder,
  getTransactionDecoder,
  getCompiledTransactionMessageDecoder,
} from '@solana/kit';
import { verifyExactSwapSignature } from './imported-swap-approval';
import { warmupAccountKeysHash } from './warmup-native-settlement';
import type { WarmupSigningReview } from './warmup-signing';
import { validatedSwapFailure } from './swap-failure';
import { withdrawalFailureReason } from './withdrawal-failure';
import { getSolanaRpcEndpoint } from './solana-rpc';
import { walletAddress } from './wallet-workspace';
const uint = (v: unknown) => {
  if (
    typeof v !== 'string' ||
    !/^(0|[1-9]\d{0,19})$/.test(v) ||
    BigInt(v) > (1n << 64n) - 1n
  )
    throw new Error('Invalid failure balances.');
  return BigInt(v);
};
const slot = (v: unknown) => {
  const n = Number(uint(v));
  if (!Number.isSafeInteger(n)) throw new Error('Invalid failure slot.');
  return n;
};
export async function decodeSwapFailure(
  value: unknown,
  review: WarmupSigningReview,
  signature: string,
) {
  const raw = value as {
    version: unknown;
    slot: unknown;
    blockTime: unknown;
    transaction: unknown;
    meta: {
      err: unknown;
      fee: unknown;
      loadedAddresses?: { writable?: unknown[]; readonly?: unknown[] };
      preBalances: unknown[];
      postBalances: unknown[];
    };
  };
  if (
    !raw ||
    raw.version !== '0' ||
    !Array.isArray(raw.transaction) ||
    raw.transaction.length !== 2 ||
    raw.transaction[1] !== 'base64' ||
    typeof raw.transaction[0] !== 'string' ||
    !raw.meta ||
    raw.meta.err === null ||
    raw.meta.err === undefined ||
    verifyExactSwapSignature(review, raw.transaction[0]) !== signature
  )
    throw new Error('Failure packet differs.');
  const bytes = getBase64Encoder().encode(review.transaction),
    hash = Array.from(
      new Uint8Array(
        await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes)),
      ),
      (b) => b.toString(16).padStart(2, '0'),
    ).join('');
  if (hash !== review.sha256) throw new Error('Failure approval hash differs.');
  const tx = getTransactionDecoder().decode(
      getBase64Encoder().encode(raw.transaction[0]),
    ),
    message = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
  if (
    message.version !== 0 ||
    message.staticAccounts[0] !== review.wallet ||
    message.header.numSignerAccounts !== 1
  )
    throw new Error('Failure payer differs.');
  const loaded = raw.meta.loadedAddresses,
    writable = loaded?.writable ?? [],
    readonly = loaded?.readonly ?? [],
    lookups = message.addressTableLookups ?? [];
  if (
    !Array.isArray(writable) ||
    !Array.isArray(readonly) ||
    writable.length !==
      lookups.reduce((n, l) => n + l.writableIndexes.length, 0) ||
    readonly.length !==
      lookups.reduce((n, l) => n + l.readonlyIndexes.length, 0)
  )
    throw new Error('Failure lookup context differs.');
  const keys = [
    ...message.staticAccounts,
    ...writable.map((a) => walletAddress(a, 'Solana')),
    ...readonly.map((a) => walletAddress(a, 'Solana')),
  ];
  if (
    keys.length > 256 ||
    new Set(keys).size !== keys.length ||
    (lookups.length && !review.settlement) ||
    (review.settlement &&
      review.settlement.accountKeysSha256 !==
        (await warmupAccountKeysHash(keys)))
  )
    throw new Error('Failure account identities differ.');
  const meta = raw.meta;
  if (
    !Array.isArray(meta.preBalances) ||
    !Array.isArray(meta.postBalances) ||
    meta.preBalances.length !== keys.length ||
    meta.postBalances.length !== keys.length
  )
    throw new Error('Failure balances incomplete.');
  const before = meta.preBalances.map(uint),
    after = meta.postBalances.map(uint),
    fee = uint(meta.fee),
    error = withdrawalFailureReason(meta.err);
  if (
    after[0] - before[0] !== -fee ||
    before.some((v, i) => i > 0 && v !== after[i]) ||
    (error.instructionIndex !== undefined &&
      error.instructionIndex >= message.instructions.length)
  )
    throw new Error('Failure rollback or fee differs.');
  return validatedSwapFailure(
    {
      failed: true,
      network: 'mainnet',
      commitment: 'finalized',
      signatureVerified: true,
      signature,
      wallet: review.wallet,
      sha256: review.sha256,
      inputMint: review.inputMint,
      outputMint: review.outputMint,
      inputRaw: review.inputRaw,
      minimumOutputRaw: review.minimumOutputRaw,
      reviewedFeeLamports: review.maximumFeeLamports,
      networkFeeLamports: fee.toString(),
      walletChangeRaw: (-fee).toString(),
      feeLimitExceeded: fee > uint(review.maximumFeeLamports),
      slot: slot(raw.slot),
      blockTime: raw.blockTime === null ? null : slot(raw.blockTime),
      error,
      observedAt: new Date().toISOString(),
      source: new URL(getSolanaRpcEndpoint('mainnet')).hostname,
    },
    review,
    signature,
  );
}
