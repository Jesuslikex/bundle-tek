import bs58 from 'bs58';
import type { WarmupSigningReview } from './warmup-signing';
import {
  withdrawalFailureReason,
  withdrawalFailureLabel,
  type WithdrawalFailureReason,
} from './withdrawal-failure';
export type SwapFailureReceipt = {
  failed: true;
  network: 'mainnet';
  commitment: 'finalized';
  signatureVerified: true;
  signature: string;
  wallet: string;
  sha256: string;
  inputMint: string;
  outputMint: string;
  inputRaw: string;
  minimumOutputRaw: string;
  reviewedFeeLamports: string;
  networkFeeLamports: string;
  walletChangeRaw: string;
  feeLimitExceeded: boolean;
  slot: number;
  blockTime: number | null;
  error: WithdrawalFailureReason;
  observedAt: string;
  source: string;
};
type Context = Pick<
  WarmupSigningReview,
  | 'wallet'
  | 'sha256'
  | 'inputMint'
  | 'outputMint'
  | 'inputRaw'
  | 'minimumOutputRaw'
> & { maximumFeeLamports?: string };
const uint = (v: unknown) => {
  if (
    typeof v !== 'string' ||
    !/^(0|[1-9]\d{0,19})$/.test(v) ||
    BigInt(v) > (1n << 64n) - 1n
  )
    throw new Error('Invalid failure amount.');
  return BigInt(v);
};
export function validatedSwapFailure(
  value: unknown,
  context: Context,
  signature: string,
): SwapFailureReceipt {
  const f = value as SwapFailureReceipt;
  if (
    !f ||
    f.failed !== true ||
    f.network !== 'mainnet' ||
    f.commitment !== 'finalized' ||
    f.signatureVerified !== true ||
    f.signature !== signature ||
    bs58.decode(signature).length !== 64 ||
    f.wallet !== context.wallet ||
    f.sha256 !== context.sha256 ||
    f.inputMint !== context.inputMint ||
    f.outputMint !== context.outputMint ||
    f.inputRaw !== context.inputRaw ||
    f.minimumOutputRaw !== context.minimumOutputRaw ||
    !Number.isSafeInteger(f.slot) ||
    f.slot < 0 ||
    (f.blockTime !== null &&
      (!Number.isSafeInteger(f.blockTime) || f.blockTime < 0)) ||
    f.walletChangeRaw !== (-uint(f.networkFeeLamports)).toString() ||
    f.feeLimitExceeded !==
      uint(f.networkFeeLamports) > uint(f.reviewedFeeLamports) ||
    (context.maximumFeeLamports !== undefined &&
      f.reviewedFeeLamports !== context.maximumFeeLamports) ||
    !Number.isFinite(Date.parse(f.observedAt)) ||
    typeof f.source !== 'string' ||
    f.source.length > 253 ||
    !/^[A-Za-z0-9.-]+$/.test(f.source) ||
    !f.error
  )
    throw new Error('Swap failure evidence differs.');
  const normalized =
    f.error.type === 'InstructionError'
      ? withdrawalFailureReason({
          InstructionError: [
            f.error.instructionIndex,
            f.error.instructionCode === 'Custom'
              ? { Custom: f.error.customCode }
              : f.error.instructionCode,
          ],
        })
      : withdrawalFailureReason(f.error.type);
  if (
    Object.keys(f.error).length !== Object.keys(normalized).length ||
    Object.entries(normalized).some(
      ([k, v]) => f.error[k as keyof WithdrawalFailureReason] !== v,
    )
  )
    throw new Error('Failure code differs.');
  return f;
}
export function swapFailureDetail(f: SwapFailureReceipt) {
  return `Verified finalized failure slot ${f.slot} · ${withdrawalFailureLabel(f.error)} · actual network fee ${f.networkFeeLamports} lamports · wallet SOL debit ${f.networkFeeLamports} lamports${f.feeLimitExceeded ? ' · fee exceeded reviewed limit' : ''} · observed ${f.observedAt} via ${f.source}`;
}
