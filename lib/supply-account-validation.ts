import { walletAddress } from './wallet-workspace';
import { TOKEN_PROGRAMS } from './wallet-holdings';
const object = (value: unknown) => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid supply account data.');
  return value as Record<string, unknown>;
};
export function supplyTokenAmount(value: unknown, expectedDecimals?: number) {
  const data = object(value);
  if (
    typeof data.amount !== 'string' ||
    !/^(0|[1-9]\d{0,19})$/.test(data.amount) ||
    BigInt(data.amount) > (1n << 64n) - 1n ||
    !Number.isInteger(data.decimals) ||
    (data.decimals as number) < 0 ||
    (data.decimals as number) > 255 ||
    (expectedDecimals !== undefined && data.decimals !== expectedDecimals)
  )
    throw new Error('Invalid supply token amount.');
  return { raw: BigInt(data.amount), decimals: data.decimals as number };
}
export function supplyAccountBalance(
  value: unknown,
  mint: string,
  decimals: number,
  expectedOwner?: string,
) {
  const account = object(value),
    parsed = object(object(account.data).parsed),
    info = object(parsed.info);
  if (
    !TOKEN_PROGRAMS.includes(
      account.owner as (typeof TOKEN_PROGRAMS)[number],
    ) ||
    account.executable !== false ||
    parsed.type !== 'account' ||
    info.mint !== mint ||
    !['initialized', 'frozen'].includes(String(info.state))
  )
    throw new Error('Supply account differs from the requested mint.');
  const owner = walletAddress(info.owner, 'Solana');
  if (expectedOwner !== undefined && owner !== expectedOwner)
    throw new Error('Supply account differs from requested wallet.');
  return { owner, ...supplyTokenAmount(info.tokenAmount, decimals) };
}
export function largestSupplyOwners(
  rows: unknown,
  details: unknown,
  mint: string,
  decimals: number,
  total: bigint,
) {
  if (
    !Array.isArray(rows) ||
    rows.length > 20 ||
    !Array.isArray(details) ||
    details.length !== rows.length
  )
    throw new Error('Largest account coverage differs.');
  const seen = new Set<string>(),
    owners = new Map<string, bigint>();
  let sum = 0n;
  rows.forEach((value, index) => {
    const row = object(value),
      address = walletAddress(row.address, 'Solana');
    if (seen.has(address)) throw new Error('Duplicate largest token account.');
    seen.add(address);
    const amount = supplyTokenAmount(row, decimals),
      account = supplyAccountBalance(details[index], mint, decimals);
    if (amount.raw !== account.raw)
      throw new Error('Largest account amount changed during observation.');
    sum += account.raw;
    owners.set(account.owner, (owners.get(account.owner) ?? 0n) + account.raw);
  });
  if (sum > total) throw new Error('Sampled holdings exceed total supply.');
  return owners;
}
