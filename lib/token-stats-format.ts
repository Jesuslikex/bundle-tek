const SUBSCRIPT = '₀₁₂₃₄₅₆₇₈₉';

/**
 * Short USD price for a provider decimal string. Prices below 0.001 collapse
 * their leading zeros into a subscript count ("0.0₄4567"), as trading
 * terminals do, so tiny prices stay readable. Callers keep the exact string
 * available separately; this is display only.
 */
export function shortUsdPrice(price: string | null): string {
  if (price === null || !/^\d+(\.\d+)?$/.test(price)) return 'Unavailable';
  const [whole, fraction = ''] = price.split('.');
  if (whole !== '0' || !fraction) {
    const value = Number(price);
    return (
      '$' +
      value.toLocaleString('en-US', {
        minimumFractionDigits: value >= 1 ? 2 : 0,
        maximumFractionDigits: value >= 1 ? 2 : 4,
      })
    );
  }
  const zeros = fraction.match(/^0*/)![0].length;
  const digits = fraction.slice(zeros, zeros + 4).replace(/0+$/, '') || '0';
  if (zeros === fraction.length) return '$0';
  if (zeros < 3) return '$0.' + '0'.repeat(zeros) + digits;
  const count = String(zeros)
    .split('')
    .map((d) => SUBSCRIPT[Number(d)])
    .join('');
  return `$0.0${count}${digits}`;
}

/** Compact USD amount such as "$4.06K" or "$1.2M". */
export function compactUsd(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return 'Unavailable';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    notation: 'compact',
    maximumFractionDigits: value >= 1000 ? 2 : 0,
  }).format(value);
}

/** Signed percentage such as "+12.4%" or "−3.0%". */
export function signedPercent(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return 'Unavailable';
  const text = Math.abs(value).toFixed(Math.abs(value) >= 100 ? 0 : 1);
  return value > 0 ? `+${text}%` : value < 0 ? `−${text}%` : `${text}%`;
}

/** "just now", "45s ago", "3m ago", "2h ago", "4d ago". */
export function readAge(observedAt: string, now: number): string {
  const seconds = Math.max(
    0,
    Math.floor((now - Date.parse(observedAt)) / 1000),
  );
  if (!Number.isFinite(seconds)) return 'time unknown';
  if (seconds < 10) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

/** Observations older than this are shown as stale. */
export const STALE_AFTER_MS = 5 * 60 * 1000;
