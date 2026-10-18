/** Exact bounded arithmetic on the provider's original JSON number text. */
export function exactMarketCap(value: string) {
  if (typeof value !== 'string' || value.length > 160)
    throw Error('Unsupported market-cap precision.');
  const m = /^(0|[1-9]\d*)(?:\.(\d+))?(?:[eE]([+-]?\d{1,3}))?$/.exec(value);
  if (!m || Math.abs(Number(m[3] ?? 0)) > 100)
    throw Error('Unsupported market-cap precision.');
  const digits = (m[1] + (m[2] ?? '')).replace(/^0+/, '') || '0',
    scale = (m[2]?.length ?? 0) - Number(m[3] ?? 0);
  const coefficient = BigInt(digits);
  if (Math.abs(scale) > 100) throw Error('Unsupported market-cap precision.');
  let text =
    scale <= 0
      ? digits + '0'.repeat(-scale)
      : digits.length > scale
        ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}`
        : `0.${'0'.repeat(scale - digits.length)}${digits}`;
  if (text.includes('.')) text = text.replace(/0+$/, '').replace(/\.$/, '');
  if (coefficient === 0n) text = '0';
  const bound =
    scale >= 0
      ? 1000000000000000000n * 10n ** BigInt(scale)
      : 1000000000000000000n;
  const whole = scale >= 0 ? coefficient : coefficient * 10n ** BigInt(-scale);
  if (whole > bound)
    throw Error('Market cap exceeds the admitted provider range.');
  return { text, coefficient, scale };
}
export function compareExactMarketCap(value: string, targetMicros: bigint) {
  const cap = exactMarketCap(value),
    power = 6 - cap.scale;
  const left =
    power >= 0 ? cap.coefficient * 10n ** BigInt(power) : cap.coefficient;
  const right =
    power >= 0 ? targetMicros : targetMicros * 10n ** BigInt(-power);
  return left < right ? -1 : left > right ? 1 : 0;
}
