import { walletAddress } from './wallet-workspace';
const object = (value: unknown) => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Holder summary unavailable.');
  return value as Record<string, unknown>;
};
const raw = (value: unknown) => {
  if (
    typeof value !== 'string' ||
    !/^(0|[1-9]\d{0,19})$/.test(value) ||
    BigInt(value) > (1n << 64n) - 1n
  )
    throw new Error('Holder amount invalid.');
  return value;
};
export function importedHolderSummary(
  value: unknown,
  mint: string,
  decimals: number,
  excluded: string[],
) {
  const data = object(value),
    bundle = object(data.bundle),
    external = object(data.external);
  const total = raw(data.totalSupplyRaw),
    excludedRaw = raw(bundle.raw),
    externalRaw = raw(external.raw);
  if (
    data.mint !== mint ||
    data.network !== 'mainnet' ||
    data.decimals !== decimals ||
    !Number.isSafeInteger(data.slot) ||
    (data.slot as number) < 0 ||
    typeof data.observedAt !== 'string' ||
    !Number.isFinite(Date.parse(data.observedAt)) ||
    bundle.walletCount !== excluded.length ||
    BigInt(total) === 0n ||
    BigInt(excludedRaw) + BigInt(externalRaw) !== BigInt(total) ||
    !Array.isArray(data.topExternal) ||
    data.topExternal.length > 20
  )
    throw new Error(
      'Holder summary differs from this token and excluded wallets.',
    );
  const seen = new Set<string>();
  let prior = BigInt(total),
    sum = 0n;
  const holders = data.topExternal.map((value, index) => {
    const row = object(value),
      owner = walletAddress(row.owner, 'Solana'),
      units = raw(row.raw);
    if (
      seen.has(owner) ||
      excluded.includes(owner) ||
      row.rank !== index + 1 ||
      BigInt(units) > prior
    )
      throw new Error('Sampled holder ranking differs.');
    seen.add(owner);
    prior = BigInt(units);
    sum += prior;
    return { owner, raw: units };
  });
  if (sum > BigInt(externalRaw))
    throw new Error('Sampled holders exceed remaining supply.');
  return {
    mint,
    decimals,
    slot: data.slot as number,
    observedAt: data.observedAt,
    totalSupplyRaw: total,
    excludedRaw,
    externalRaw,
    holders,
  };
}
