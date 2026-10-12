export const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
export type WithdrawalTransferFee = {
  epoch: string;
  configSha256: string;
  basisPoints: number;
  maximumFeeRaw: string;
  feeRaw: string;
  netAmountRaw: string;
};
export function withdrawalTransferFee(
  amount: bigint,
  basisPoints: number,
  maximum: bigint,
) {
  if (
    !Number.isInteger(basisPoints) ||
    basisPoints < 0 ||
    basisPoints > 10000 ||
    maximum < 0n ||
    maximum > (1n << 64n) - 1n
  )
    throw new Error('Invalid token transfer fee.');
  const rounded = (amount * BigInt(basisPoints) + 9999n) / 10000n;
  return rounded < maximum ? rounded : maximum;
}
