import type { NativeWithdrawalReview } from './native-withdrawal';

export type WithdrawalFailureReason = {
  type: string;
  instructionIndex?: number;
  instructionCode?: string;
  customCode?: number;
};
export type NativeWithdrawalFailureReceipt = {
  failed: true;
  network: 'mainnet';
  commitment: 'finalized';
  signatureVerified: true;
  signature: string;
  wallet: string;
  recipient: string;
  requestedAmountRaw: string;
  sha256: string;
  slot: number;
  blockTime: number | null;
  networkFeeLamports: string;
  walletChangeRaw: string;
  feeLimitExceeded: boolean;
  error: WithdrawalFailureReason;
  observedAt: string;
  source: string;
};
const code = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Z][A-Za-z0-9]{0,79}$/.test(value);
const integer = (value: unknown, max: number) => {
  if (typeof value === 'string' && !/^(0|[1-9]\d{0,9})$/.test(value))
    throw new Error('Invalid failure code.');
  if (typeof value !== 'number' && typeof value !== 'string')
    throw new Error('Invalid failure code.');
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0 || n > max)
    throw new Error('Invalid failure code.');
  return n;
};
export function withdrawalFailureReason(raw: unknown): WithdrawalFailureReason {
  if (code(raw)) return { type: raw };
  if (
    !raw ||
    typeof raw !== 'object' ||
    Array.isArray(raw) ||
    Object.keys(raw).length !== 1
  )
    throw new Error('Failure reason unavailable.');
  const [type, value] = Object.entries(raw)[0];
  if (!code(type)) throw new Error('Failure reason unavailable.');
  if (type !== 'InstructionError') return { type };
  if (!Array.isArray(value) || value.length !== 2)
    throw new Error('Instruction failure unavailable.');
  const instructionIndex = integer(value[0], 255),
    detail = value[1];
  if (code(detail)) return { type, instructionIndex, instructionCode: detail };
  if (
    detail &&
    typeof detail === 'object' &&
    !Array.isArray(detail) &&
    Object.keys(detail).length === 1 &&
    'Custom' in detail
  )
    return {
      type,
      instructionIndex,
      instructionCode: 'Custom',
      customCode: integer(detail.Custom, 4294967295),
    };
  throw new Error('Instruction failure unavailable.');
}
export function withdrawalFailureLabel(reason: WithdrawalFailureReason) {
  return reason.type === 'InstructionError'
    ? `Instruction ${reason.instructionIndex}: ${reason.instructionCode}${reason.customCode === undefined ? '' : ` ${reason.customCode}`}`
    : reason.type;
}
const uint = (value: unknown) => {
  if (
    typeof value !== 'string' ||
    !/^(0|[1-9]\d{0,19})$/.test(value) ||
    BigInt(value) > (1n << 64n) - 1n
  )
    throw new Error('Invalid failure fee.');
  return BigInt(value);
};
export function validatedWithdrawalFailure(
  value: unknown,
  review: NativeWithdrawalReview,
  signature: string,
): NativeWithdrawalFailureReceipt {
  const f = value as NativeWithdrawalFailureReceipt;
  if (
    !f ||
    f.failed !== true ||
    f.network !== 'mainnet' ||
    f.commitment !== 'finalized' ||
    f.signatureVerified !== true ||
    f.signature !== signature ||
    f.wallet !== review.wallet ||
    f.recipient !== review.recipient ||
    f.requestedAmountRaw !== review.amountRaw ||
    f.sha256 !== review.sha256 ||
    !Number.isSafeInteger(f.slot) ||
    f.slot < review.slot ||
    (f.blockTime !== null &&
      (!Number.isSafeInteger(f.blockTime) || f.blockTime < 0)) ||
    f.walletChangeRaw !== (-uint(f.networkFeeLamports)).toString() ||
    f.feeLimitExceeded !==
      uint(f.networkFeeLamports) > uint(review.feeLamports) ||
    !Number.isFinite(Date.parse(f.observedAt)) ||
    typeof f.source !== 'string' ||
    f.source.length > 253 ||
    !/^[A-Za-z0-9.-]+$/.test(f.source) ||
    !f.error
  )
    throw new Error('Finalized failure evidence differs.');
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
    throw new Error('Retained failure reason differs.');
  return f;
}
