/** Only this mint gives the pool quote amount SOL units. No USD conversion is inferred. */
export const AUTO_SELL_SOL_QUOTE =
  'So11111111111111111111111111111111111111112';

/** Compare provider decimals exactly, including precision beyond JavaScript numbers. */
export function autoSellQuoteAtLeast(amount: string, minimum: string) {
  const decimal = /^\d{1,40}(?:\.\d{1,80})?$/;
  if (
    typeof amount !== 'string' ||
    typeof minimum !== 'string' ||
    !decimal.test(amount) ||
    !decimal.test(minimum)
  )
    return false;
  const [whole, fraction = ''] = amount.split('.');
  const [bound, boundFraction = ''] = minimum.split('.');
  const precision = Math.max(fraction.length, boundFraction.length);
  return (
    BigInt(whole + fraction.padEnd(precision, '0')) >=
    BigInt(bound + boundFraction.padEnd(precision, '0'))
  );
}
