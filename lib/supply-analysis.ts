export function formatRawAmount(raw: bigint, decimals: number) {
  const negative = raw < 0n;
  const digits = (negative ? -raw : raw).toString().padStart(decimals + 1, "0");
  if (decimals === 0) return `${negative ? "-" : ""}${digits}`;
  const whole = digits.slice(0, -decimals);
  const fraction = digits.slice(-decimals).replace(/0+$/, "").slice(0, 6);
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

export function percentOfSupply(part: bigint, total: bigint) {
  if (total <= 0n) return 0;
  return Number((part * 1_000_000n) / total) / 10_000;
}
