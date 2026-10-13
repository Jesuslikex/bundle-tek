import { walletAddress } from './wallet-workspace';
import { formatNativeBalance } from './wallet-balance-format';
const maximum = (1n << 64n) - 1n;
const denominator = 100000000n;
export type DcaSupplyToken = {
  chain: string;
  address: string;
  decimals: number;
  totalSupplyRaw?: string;
  observedAt?: string;
};
export type DcaSupplySizing = {
  format: 'dca-supply-percentage-v1';
  mint: string;
  totalSupplyRaw: string;
  observedAt: string;
  totalPercent: string;
  minimumPercent?: string;
  maximumPercent?: string;
};
export function dcaSupplyBasis(token: DcaSupplyToken) {
  if (
    token.chain !== 'Solana' ||
    !Number.isInteger(token.decimals) ||
    token.decimals < 0 ||
    token.decimals > 255 ||
    typeof token.totalSupplyRaw !== 'string' ||
    !/^[1-9]\d{0,19}$/.test(token.totalSupplyRaw) ||
    BigInt(token.totalSupplyRaw) > maximum ||
    typeof token.observedAt !== 'string' ||
    !Number.isFinite(Date.parse(token.observedAt))
  )
    throw new Error(
      'Saved mint supply unavailable. Refresh the imported token before supply sizing.',
    );
  return {
    mint: walletAddress(token.address, 'Solana'),
    totalSupplyRaw: token.totalSupplyRaw,
    observedAt: token.observedAt,
  };
}
function percent(value: unknown) {
  if (
    typeof value !== 'string' ||
    !/^(0|[1-9]\d{0,2})(\.\d{1,6})?$/.test(value)
  )
    throw new Error(
      'Use a positive supply percentage with at most six decimals.',
    );
  const [whole, fraction = ''] = value.split('.'),
    raw = BigInt(whole) * 1000000n + BigInt(fraction.padEnd(6, '0'));
  if (raw < 1n || raw > denominator)
    throw new Error(
      'Supply percentage must be greater than zero and at most 100.',
    );
  return { raw, canonical: formatNativeBalance(raw.toString(), 6) };
}
export function dcaSupplySizing(value: unknown, token: DcaSupplyToken) {
  const v = value as DcaSupplySizing,
    basis = dcaSupplyBasis(token);
  const bounded =
    v?.minimumPercent !== undefined || v?.maximumPercent !== undefined;
  if (
    !v ||
    Object.keys(v).sort().join(',') !==
      (bounded
        ? 'format,maximumPercent,minimumPercent,mint,observedAt,totalPercent,totalSupplyRaw'
        : 'format,mint,observedAt,totalPercent,totalSupplyRaw') ||
    v.format !== 'dca-supply-percentage-v1' ||
    v.mint !== basis.mint ||
    v.totalSupplyRaw !== basis.totalSupplyRaw ||
    v.observedAt !== basis.observedAt
  )
    throw new Error('DCA supply capture differs from the saved project.');
  const total = percent(v.totalPercent),
    supply = BigInt(basis.totalSupplyRaw),
    totalRaw = (supply * total.raw) / denominator;
  if (totalRaw === 0n)
    throw new Error('Supply budget is smaller than one token atom.');
  let range: { minimumRaw: string; maximumRaw: string } | undefined;
  let percentages:
    | { minimumPercent: string; maximumPercent: string }
    | undefined;
  if (bounded) {
    const min = percent(v.minimumPercent),
      max = percent(v.maximumPercent);
    const minimumRaw = (supply * min.raw + denominator - 1n) / denominator,
      maximumRaw = (supply * max.raw) / denominator;
    if (max.raw < min.raw || minimumRaw > maximumRaw || maximumRaw === 0n)
      throw new Error('Supply bounds contain no valid token-atom amount.');
    range = {
      minimumRaw: minimumRaw.toString(),
      maximumRaw: maximumRaw.toString(),
    };
    percentages = {
      minimumPercent: min.canonical,
      maximumPercent: max.canonical,
    };
  }
  const sizing: DcaSupplySizing = {
    format: 'dca-supply-percentage-v1',
    ...basis,
    totalPercent: total.canonical,
    ...percentages,
  };
  return { sizing, totalRaw: totalRaw.toString(), ...range };
}
export function dcaSupplyInput(
  token: DcaSupplyToken,
  input: {
    totalPercent: string;
    minimumPercent?: string;
    maximumPercent?: string;
  },
) {
  return dcaSupplySizing(
    { format: 'dca-supply-percentage-v1', ...dcaSupplyBasis(token), ...input },
    token,
  );
}
