import { z } from 'zod';
import bs58 from 'bs58';

const amount = z
  .string()
  .regex(/^(0|[1-9]\d{0,19})$/)
  .refine(
    (v) => /^(0|[1-9]\d{0,19})$/.test(v) && BigInt(v) <= (1n << 64n) - 1n,
  );
const timestamp = z.iso.datetime();
const wallet = z.string().refine((v) => {
  try {
    return bs58.decode(v).length === 32 && bs58.encode(bs58.decode(v)) === v;
  } catch {
    return false;
  }
});
const label = z
  .string()
  .min(1)
  .max(80)
  .refine((v) =>
    v.split('').every((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127),
  );
const tier = z.enum(['funding-only', 'light-history', 'established']);
const regionLabel = label.refine(
  (value) =>
    value.trim().length > 0 &&
    value === value.trim() &&
    !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value) &&
    value.toLowerCase() !== 'not reported',
);
function queryArray(value: unknown) {
  if (typeof value !== 'string' || value.length > 1800) return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}
const sources = z.preprocess(
  queryArray,
  z
    .array(label)
    .min(1)
    .max(20)
    .refine((values) => new Set(values).size === values.length)
    .transform((values) => [...values].sort()),
);
const regionChoices = z.preprocess(
  queryArray,
  z
    .array(regionLabel)
    .min(1)
    .max(20)
    .refine((values) => new Set(values).size === values.length)
    .transform((values) => [...values].sort()),
);
const tiers = z.preprocess(
  queryArray,
  z
    .array(tier)
    .min(1)
    .max(3)
    .refine((values) => new Set(values).size === values.length)
    .transform((values) => [...values].sort()),
);
export const marketplaceListing = z
  .object({
    id: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
    address: wallet,
    source: label,
    region: regionLabel.optional(),
    tier,
    fundedAt: timestamp,
    balanceLamports: amount,
    purchasePriceLamports: amount,
    transactionCount: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  })
  .strict();
export const marketplaceInventory = z
  .object({
    format: z.literal('bundle-wallet-catalog-v1'),
    chain: z.literal('Solana'),
    provider: label,
    observedAt: timestamp,
    coverage: z.enum(['complete', 'partial']),
    listings: z.array(marketplaceListing).max(500),
  })
  .strict();
export type MarketplaceListing = z.infer<typeof marketplaceListing>;
export type MarketplaceInventory = z.infer<typeof marketplaceInventory>;

export const marketplaceFilters = z
  .object({
    count: z.coerce.number().int().min(1).max(200).default(25),
    minimumAgeDays: z.coerce.number().int().min(1).max(36500).default(1),
    maximumAgeDays: z.coerce.number().int().min(1).max(36500).optional(),
    minimumGapMinutes: z.coerce.number().int().min(0).max(525600).default(30),
    minimumBalanceLamports: amount.default('0'),
    maximumBalanceLamports: amount.optional(),
    maximumPriceLamports: amount.optional(),
    minimumTransactions: z.coerce
      .number()
      .int()
      .min(0)
      .max(Number.MAX_SAFE_INTEGER)
      .default(0),
    maximumTransactions: z.coerce
      .number()
      .int()
      .min(0)
      .max(Number.MAX_SAFE_INTEGER)
      .optional(),
    source: label.optional(),
    tier: tier.optional(),
    sources: sources.optional(),
    region: regionLabel.optional(),
    regions: regionChoices.optional(),
    tiers: tiers.optional(),
  })
  .strict()
  .refine(
    (f) =>
      !(f.source && f.sources) &&
      !(f.region && f.regions) &&
      !(f.tier && f.tiers) &&
      amount.safeParse(f.minimumBalanceLamports).success &&
      (f.maximumBalanceLamports === undefined ||
        amount.safeParse(f.maximumBalanceLamports).success) &&
      (f.maximumAgeDays === undefined ||
        f.maximumAgeDays >= f.minimumAgeDays) &&
      (f.maximumBalanceLamports === undefined ||
        BigInt(f.maximumBalanceLamports) >= BigInt(f.minimumBalanceLamports)) &&
      (f.maximumTransactions === undefined ||
        f.maximumTransactions >= f.minimumTransactions),
    'Choose maximum values at or above their minimums.',
  );
export type MarketplaceFilters = z.infer<typeof marketplaceFilters>;
export const marketplaceResult = z
  .object({
    format: z.literal('bundle-wallet-marketplace-v1'),
    purchaseEnabled: z.literal(false),
    provider: label,
    observedAt: timestamp,
    expiresAt: timestamp,
    coverage: z.enum(['complete', 'partial']),
    inventoryCount: z.number().int().min(0).max(500),
    matchingCount: z.number().int().min(0).max(500),
    sources: z.array(label).max(500),
    regions: z.array(regionLabel).min(1).max(500).optional(),
    filters: marketplaceFilters,
    listings: z.array(marketplaceListing).max(200),
    totalBalanceLamports: z.string().regex(/^\d+$/),
    totalPriceLamports: z.string().regex(/^\d+$/),
    netCostLamports: z.string().regex(/^-?\d+$/),
  })
  .strict()
  .refine(
    (result) =>
      (!result.regions ||
        (new Set(result.regions).size === result.regions.length &&
          result.regions.every(
            (region, index) =>
              index === 0 || result.regions![index - 1] < region,
          ))) &&
      result.listings.every(
        (listing) =>
          (listing.region === undefined ||
            result.regions?.includes(listing.region)) &&
          (!result.filters.region ||
            listing.region === result.filters.region) &&
          (!result.filters.regions ||
            (listing.region !== undefined &&
              result.filters.regions.includes(listing.region))),
      ),
    'Reported regions are inconsistent with this inventory snapshot.',
  );
export type MarketplaceResult = z.infer<typeof marketplaceResult>;

export function selectMarketplaceInventory(
  input: unknown,
  filters: MarketplaceFilters,
  now: number,
): MarketplaceResult {
  const inventory = marketplaceInventory.parse(input);
  const observed = Date.parse(inventory.observedAt);
  if (!Number.isFinite(now) || observed > now || now - observed >= 60000)
    throw new Error('Inventory snapshot is stale or dated in the future.');
  const ids = new Set<string>(),
    addresses = new Set<string>();
  for (const item of inventory.listings) {
    if (
      ids.has(item.id) ||
      addresses.has(item.address) ||
      Date.parse(item.fundedAt) > observed
    )
      throw new Error('Inventory identity or funding time is inconsistent.');
    ids.add(item.id);
    addresses.add(item.address);
  }
  const f = marketplaceFilters.parse(filters);
  const matches = inventory.listings
    .filter(
      (item) =>
        observed - Date.parse(item.fundedAt) >= f.minimumAgeDays * 86400000 &&
        (f.maximumAgeDays === undefined ||
          observed - Date.parse(item.fundedAt) <=
            f.maximumAgeDays * 86400000) &&
        BigInt(item.balanceLamports) >= BigInt(f.minimumBalanceLamports) &&
        (f.maximumBalanceLamports === undefined ||
          BigInt(item.balanceLamports) <= BigInt(f.maximumBalanceLamports)) &&
        item.transactionCount >= f.minimumTransactions &&
        (f.maximumTransactions === undefined ||
          item.transactionCount <= f.maximumTransactions) &&
        (f.maximumPriceLamports === undefined ||
          BigInt(item.purchasePriceLamports) <=
            BigInt(f.maximumPriceLamports)) &&
        (!f.source || item.source === f.source) &&
        (!f.tier || item.tier === f.tier) &&
        (!f.sources || f.sources.includes(item.source)) &&
        (!f.region || item.region === f.region) &&
        (!f.regions ||
          (item.region !== undefined && f.regions.includes(item.region))) &&
        (!f.tiers || f.tiers.includes(item.tier)),
    )
    .sort((a, b) => {
      const delta =
        BigInt(a.purchasePriceLamports) - BigInt(b.purchasePriceLamports);
      return delta < 0n ? -1 : delta > 0n ? 1 : a.id.localeCompare(b.id);
    });
  const listings: MarketplaceListing[] = [];
  for (const item of matches) {
    if (
      listings.every(
        (previous) =>
          Math.abs(Date.parse(previous.fundedAt) - Date.parse(item.fundedAt)) >=
          f.minimumGapMinutes * 60000,
      )
    )
      listings.push(item);
    if (listings.length === f.count) break;
  }
  const balances = listings.reduce(
    (sum, item) => sum + BigInt(item.balanceLamports),
    0n,
  );
  const prices = listings.reduce(
    (sum, item) => sum + BigInt(item.purchasePriceLamports),
    0n,
  );
  const regions = [
    ...new Set(
      inventory.listings.flatMap((item) =>
        item.region === undefined ? [] : [item.region],
      ),
    ),
  ].sort();
  return {
    format: 'bundle-wallet-marketplace-v1',
    purchaseEnabled: false,
    provider: inventory.provider,
    observedAt: inventory.observedAt,
    expiresAt: new Date(observed + 60000).toISOString(),
    coverage: inventory.coverage,
    inventoryCount: inventory.listings.length,
    matchingCount: matches.length,
    sources: [...new Set(inventory.listings.map((item) => item.source))].sort(),
    ...(regions.length ? { regions } : {}),
    filters: f,
    listings,
    totalBalanceLamports: String(balances),
    totalPriceLamports: String(prices),
    netCostLamports: String(prices - balances),
  };
}

export function marketplaceSol(raw: string) {
  const value = BigInt(raw),
    absolute = value < 0n ? -value : value;
  return `${value < 0n ? '-' : ''}${absolute / 1000000000n}.${
    String(absolute % 1000000000n)
      .padStart(9, '0')
      .replace(/0+$/, '') || '0'
  }`;
}

export type MarketplaceSort =
  | 'price'
  | 'balance'
  | 'net'
  | 'funded'
  | 'transactions';
/** Display order only; never reselects wallets or changes captured totals. */
export function sortMarketplaceListings(
  listings: MarketplaceListing[],
  sort: MarketplaceSort,
  descending: boolean,
) {
  const value = (row: MarketplaceListing) =>
    sort === 'price'
      ? BigInt(row.purchasePriceLamports)
      : sort === 'balance'
        ? BigInt(row.balanceLamports)
        : sort === 'net'
          ? BigInt(row.purchasePriceLamports) - BigInt(row.balanceLamports)
          : sort === 'transactions'
            ? BigInt(row.transactionCount)
            : BigInt(Date.parse(row.fundedAt));
  return [...listings].sort((a, b) => {
    const left = value(a),
      right = value(b);
    const difference = left < right ? -1 : left > right ? 1 : 0;
    return difference
      ? difference * (descending ? -1 : 1)
      : a.id < b.id
        ? -1
        : a.id > b.id
          ? 1
          : 0;
  });
}

/** Exact user-facing SOL conversion. Never round a spending/filter boundary. */
export function marketplaceLamports(sol: string) {
  if (!/^(0|[1-9]\d{0,10})(?:\.\d{1,9})?$/.test(sol))
    throw new Error(
      'Enter a non-negative SOL amount with up to 9 decimal places.',
    );
  const [whole, fraction = ''] = sol.split('.');
  const raw = BigInt(whole) * 1000000000n + BigInt(fraction.padEnd(9, '0'));
  if (raw > (1n << 64n) - 1n)
    throw new Error('SOL amount exceeds the supported limit.');
  return raw.toString();
}
