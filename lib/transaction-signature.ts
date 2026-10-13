import bs58 from 'bs58';

export function transactionSignature(value: unknown) {
  if (
    typeof value !== 'string' ||
    value.length > 88 ||
    bs58.decode(value).length !== 64
  )
    throw new Error('Invalid transaction signature.');
  return value;
}
