export function lamportsToSolNumber(value: bigint): number {
  const whole = value / 1_000_000_000n;
  const fraction = value % 1_000_000_000n;
  return Number(whole) + Number(fraction) / 1_000_000_000;
}
