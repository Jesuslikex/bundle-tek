import {
  amountToUiAmountForScaledUiAmountMintWithoutSimulation,
  uiAmountToAmountForScaledUiAmountMintWithoutSimulation,
} from '@solana-program/token-2022';
import { formatNativeBalance } from './wallet-balance-format';

export type PairAmountPolicy =
  | { kind: 'unscaled' }
  | {
      kind: 'scaled-ui-v1';
      multiplierHex: string;
      nextMultiplierHex: string;
      effectiveTimestamp: string;
    };
const MAX = (1n << 64n) - 1n;
export function pairMultiplierHex(value: number) {
  if (!Number.isFinite(value) || value <= 0)
    throw new Error('Scaled token multiplier is invalid.');
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setFloat64(0, value);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
export function pairMultiplier(hex: string) {
  if (typeof hex !== 'string' || !/^[a-f0-9]{16}$/.test(hex))
    throw new Error('Scaled token multiplier is invalid.');
  const bytes = Uint8Array.from(hex.match(/../g)!, (v) =>
    Number.parseInt(v, 16),
  );
  const value = new DataView(bytes.buffer).getFloat64(0);
  if (pairMultiplierHex(value) !== hex)
    throw new Error('Scaled token multiplier is noncanonical.');
  return value;
}
export function validPairAmountPolicy(
  value: unknown,
): value is PairAmountPolicy {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  try {
    if (v.kind === 'unscaled') return Object.keys(v).join(',') === 'kind';
    if (
      v.kind !== 'scaled-ui-v1' ||
      Object.keys(v).sort().join(',') !==
        'effectiveTimestamp,kind,multiplierHex,nextMultiplierHex' ||
      typeof v.effectiveTimestamp !== 'string' ||
      !/^(0|-?[1-9]\d{0,18})$/.test(v.effectiveTimestamp) ||
      BigInt(v.effectiveTimestamp) < -(1n << 63n) ||
      BigInt(v.effectiveTimestamp) >= 1n << 63n
    )
      return false;
    pairMultiplier(v.multiplierHex as string);
    pairMultiplier(v.nextMultiplierHex as string);
    return true;
  } catch {
    return false;
  }
}
export function activePairMultiplier(policy: PairAmountPolicy, unix: string) {
  if (!validPairAmountPolicy(policy) || !/^[1-9]\d{0,15}$/.test(unix))
    throw new Error('Token amount clock or policy is invalid.');
  return policy.kind === 'unscaled'
    ? 1
    : pairMultiplier(
        BigInt(unix) >= BigInt(policy.effectiveTimestamp)
          ? policy.nextMultiplierHex
          : policy.multiplierHex,
      );
}
function precision(decimals: number) {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18)
    throw new Error('Token amount precision is invalid.');
}
/** Exact user budget in UI quantum units; its raw-token u64 check comes after scale conversion. */
export function pairUiBudget(amount: string, decimals: number) {
  precision(decimals);
  if (typeof amount !== 'string' || !/^\d{1,20}(?:\.\d{1,18})?$/.test(amount))
    throw new Error('Use a positive plain decimal UI amount.');
  const [whole, fraction = ''] = amount.split('.');
  if (fraction.length > decimals)
    throw new Error('UI amount exceeds the selected mint precision.');
  const value = BigInt(whole + fraction.padEnd(decimals, '0'));
  if (value < 1n)
    throw new Error('UI amount is below the selected mint precision.');
  return value;
}
function atoms(raw: string) {
  if (
    typeof raw !== 'string' ||
    !/^(0|[1-9]\d{0,19})$/.test(raw) ||
    BigInt(raw) > MAX
  )
    throw new Error('Token amount exceeds Solana limits.');
  return BigInt(raw);
}
/** SPL's canonical f64 display convention, with exact raw units retained separately. */
export function pairUiAmount(
  raw: string,
  decimals: number,
  policy: PairAmountPolicy,
  unix: string,
) {
  const value = atoms(raw);
  precision(decimals);
  const multiplier = activePairMultiplier(policy, unix);
  if (policy.kind === 'unscaled') return formatNativeBalance(raw, decimals);
  if (
    !Number.isFinite(multiplier / 10 ** decimals) ||
    multiplier / 10 ** decimals <= 0
  )
    throw new Error('Scaled token precision is not representable.');
  const result = amountToUiAmountForScaledUiAmountMintWithoutSimulation(
    value,
    decimals,
    multiplier,
  );
  if (
    !/^(0|[1-9]\d{0,308})(?:\.\d{1,18})?$/.test(result) ||
    (result.split('.')[1]?.length ?? 0) > decimals
  )
    throw new Error('Scaled token display is not representable.');
  return result;
}
function multiplierRatio(multiplier: number) {
  const bits = BigInt('0x' + pairMultiplierHex(multiplier));
  const exponentBits = Number((bits >> 52n) & 2047n);
  const mantissa =
    (bits & ((1n << 52n) - 1n)) | (exponentBits ? 1n << 52n : 0n);
  const exponent = exponentBits ? exponentBits - 1075 : -1074;
  return exponent >= 0
    ? { numerator: mantissa << BigInt(exponent), denominator: 1n }
    : { numerator: mantissa, denominator: 1n << BigInt(-exponent) };
}
function displayedBudget(value: string, decimals: number) {
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole + fraction.padEnd(decimals, '0'));
}
/**
 * Bound both exact multiplier arithmetic and SPL's f64 conversion/display by the
 * entered UI budget. Rounding can leave dust; it never silently increases a cap.
 */
export function pairUiAtoms(
  amount: string,
  decimals: number,
  policy: PairAmountPolicy,
  unix: string,
) {
  const budget = pairUiBudget(amount, decimals);
  const multiplier = activePairMultiplier(policy, unix);
  if (policy.kind === 'unscaled') {
    if (budget > MAX) throw new Error('Token amount exceeds Solana limits.');
    return budget;
  }
  const ratio = multiplierRatio(multiplier);
  const exactCap = (budget * ratio.denominator) / ratio.numerator;
  if (exactCap > MAX) throw new Error('Token amount exceeds Solana limits.');
  if (exactCap < 1n)
    throw new Error('UI amount converts to no spendable raw units.');
  const native = uiAmountToAmountForScaledUiAmountMintWithoutSimulation(
    amount,
    decimals,
    multiplier,
  );
  let cap = native < exactCap ? native : exactCap;
  if (cap < 1n || cap > MAX)
    throw new Error('UI amount converts to invalid raw units.');
  const within = (n: bigint) =>
    displayedBudget(
      pairUiAmount(n.toString(), decimals, policy, unix),
      decimals,
    ) <= budget;
  if (!within(cap)) {
    let low = 0n,
      high = cap;
    while (low < high) {
      const mid = (low + high + 1n) / 2n;
      if (within(mid)) low = mid;
      else high = mid - 1n;
    }
    cap = low;
  }
  if (cap < 1n || pairUiAmount(cap.toString(), decimals, policy, unix) === '0')
    throw new Error('UI amount converts below the displayed mint precision.');
  return cap;
}
/** A scheduled multiplier transition shortens the observation lifetime. */
export function pairAmountLifetimeMs(
  policies: PairAmountPolicy[],
  unix: string,
  observedAt = Number(unix) * 1000,
) {
  if (!Number.isSafeInteger(observedAt))
    throw new Error('Token observation clock is invalid.');
  let life = 30000;
  for (const policy of policies) {
    activePairMultiplier(policy, unix);
    if (
      policy.kind !== 'scaled-ui-v1' ||
      policy.multiplierHex === policy.nextMultiplierHex
    )
      continue;
    const remaining = BigInt(policy.effectiveTimestamp) - BigInt(unix);
    if (remaining > 0n)
      life = Math.min(
        life,
        Math.max(0, Number(remaining - 1n) * 1000),
        Math.max(
          0,
          Number(policy.effectiveTimestamp) * 1000 - observedAt - 1000,
        ),
      );
  }
  return life;
}
