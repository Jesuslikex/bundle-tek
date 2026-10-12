export function solanaTokenAtoms(value: unknown, decimals: number) {
  if (
    !Number.isInteger(decimals) ||
    decimals < 0 ||
    decimals > 255 ||
    typeof value !== 'string' ||
    value.length > 277 ||
    !/^\d{1,20}(?:\.\d{1,255})?$/.test(value)
  )
    throw new Error('Enter a positive plain decimal token amount.');
  const [whole, fraction = ''] = value.split('.');
  if (fraction.length > decimals)
    throw new Error(`Use at most ${decimals} token decimal places.`);
  const raw =
    BigInt(whole) * 10n ** BigInt(decimals) +
    BigInt(fraction.padEnd(decimals, '0') || '0');
  if (raw < 1n || raw > (1n << 64n) - 1n)
    throw new Error('Token amount must be positive and within Solana limits.');
  return raw;
}
