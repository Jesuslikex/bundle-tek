import { z } from 'zod';
import bs58 from 'bs58';
const timestamp = z.iso.datetime();
const address = z.string().refine((value) => {
  try {
    return (
      bs58.decode(value).length === 32 &&
      bs58.encode(bs58.decode(value)) === value
    );
  } catch {
    return false;
  }
});
const revision = z.number().int().min(1).max(1e9);
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const lamports = z
  .string()
  .regex(/^(0|[1-9]\d{0,19})$/)
  .refine((value) => BigInt(value) <= (1n << 64n) - 1n);
const label = z
  .string()
  .max(80)
  .refine((value) => !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value));
const source = z
  .string()
  .min(1)
  .max(253)
  .regex(/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/);
const observation = z
  .object({
    address,
    chain: z.literal('Solana'),
    observedAt: timestamp,
    source,
    nativeBalance: z.string().regex(/^(0|[1-9]\d{0,11})(?:\.\d{1,9})?$/),
    currency: z.literal('SOL'),
    block: z.string().regex(/^(0|[1-9]\d{0,15})$/),
    outgoingTransactions: z.null(),
    sampleCount: count.max(50),
    successfulSampleCount: count.max(50),
    oldestObservedAt: timestamp.nullable(),
    latestObservedAt: timestamp.nullable(),
    coverage: z.string().min(1).max(1000),
  })
  .strict();
const wallet = z
  .object({ address, label, revision, updatedAt: timestamp })
  .strict();
const proof = z.object({ address, verifiedAt: timestamp }).strict();
const run = z
  .object({
    id: z.string().min(1).max(64),
    revision,
    createdAt: timestamp,
    updatedAt: timestamp,
    document: z.string().max(131072),
  })
  .strict();
const runDocument = z
  .object({
    chain: z.literal('Solana'),
    wallets: z.array(z.object({ address, revision }).strict()).min(1).max(20),
    results: z
      .array(
        z
          .object({
            address,
            observation: observation.optional(),
            error: z.string().min(1).max(1000).optional(),
          })
          .strict(),
      )
      .max(20),
  })
  .strict();
const receiptCounts = z
  .object({ address, receiptCount: count, uniqueSignatures: count })
  .strict();
const retainedObservation = z
  .object({
    runId: z.string().min(1).max(64),
    walletRevision: revision,
    observedAt: timestamp,
    source,
    balanceLamports: lamports,
    sampleCount: count.max(50),
    successfulSampleCount: count.max(50),
    oldestSampledActivityAt: timestamp.nullable(),
    latestSampledActivityAt: timestamp.nullable(),
  })
  .strict();
export const marketplaceOwnedInventoryResult = z
  .object({
    format: z.literal('bundle-owned-wallet-inventory-v1'),
    chain: z.literal('Solana'),
    observedAt: timestamp,
    listingEnabled: z.literal(false),
    purchaseEnabled: z.literal(false),
    deliveryEnabled: z.literal(false),
    wallets: z
      .array(
        wallet.extend({
          ownershipProofAt: timestamp.nullable(),
          latestHistory: retainedObservation.nullable(),
          oldestRecordedActivityAt: timestamp.nullable(),
          observedActivityAgeSeconds: count.nullable(),
          savedHistoryChecks: count,
          failedHistoryChecks: count,
          warmupReceiptCount: count,
          warmupUniqueSignatures: count,
        }),
      )
      .max(500),
  })
  .strict();
export type MarketplaceOwnedInventory = z.infer<
  typeof marketplaceOwnedInventoryResult
>;
export type MarketplaceOwnedWallet =
  MarketplaceOwnedInventory['wallets'][number];
export type OwnedInventorySources = {
  wallets: unknown[];
  proofs: unknown[];
  runs: unknown[];
  receipts: unknown[];
};
const fail = (): never => {
  throw Error(
    'Saved wallet inventory evidence is unavailable or inconsistent.',
  );
};
export const MARKETPLACE_INVENTORY_CAPACITY_MESSAGE =
  "Saved history exceeds this inventory inspector's bounded capacity (100 relevant saved history runs or 4 MiB of retained history). Inventory is not partially shown. Retrying alone will not fix this capacity limit; bounded history pagination is not yet supported. Keep your saved history.";
type InventoryCapacityCode =
  | 'saved-history-run-limit'
  | 'saved-history-byte-limit';
export class MarketplaceInventoryCapacityError extends Error {
  constructor(readonly errorCode: InventoryCapacityCode) {
    super(MARKETPLACE_INVENTORY_CAPACITY_MESSAGE);
    this.name = 'MarketplaceInventoryCapacityError';
  }
}
export function marketplaceInventoryCapacityBody(
  error: MarketplaceInventoryCapacityError,
) {
  return {
    format: 'marketplace-inventory-capacity-v1' as const,
    errorCode: error.errorCode,
    error: MARKETPLACE_INVENTORY_CAPACITY_MESSAGE,
    inventoryShown: false as const,
    listingEnabled: false as const,
    purchaseEnabled: false as const,
    deliveryEnabled: false as const,
  };
}
export function isMarketplaceInventoryCapacityResponse(
  status: number,
  value: unknown,
) {
  if (
    status !== 409 ||
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    return false;
  const code = Object.getOwnPropertyDescriptor(value, 'errorCode');
  if (
    !code ||
    !Object.hasOwn(code, 'value') ||
    !['saved-history-run-limit', 'saved-history-byte-limit'].includes(
      code.value,
    )
  )
    return false;
  const expected = marketplaceInventoryCapacityBody(
    new MarketplaceInventoryCapacityError(code.value),
  );
  if (Reflect.ownKeys(value).length !== Object.keys(expected).length)
    return false;
  return Object.entries(expected).every(([key, expectedValue]) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return (
      descriptor?.enumerable &&
      Object.hasOwn(descriptor, 'value') &&
      descriptor.value === expectedValue
    );
  });
}
export class MarketplaceInventoryClockError extends Error {
  constructor() {
    super(
      'Seller inventory is stale or ahead of this device clock. Check automatic date and time, then reload seller inventory.',
    );
  }
}
const time = (value: string, now: number) => {
  const result = Date.parse(value);
  if (
    !Number.isSafeInteger(result) ||
    result > now ||
    new Date(result).toISOString() !== value
  )
    return fail();
  return result;
};
function atoms(value: string) {
  const [whole, fraction = ''] = value.split('.');
  const result = BigInt(whole) * 1000000000n + BigInt(fraction.padEnd(9, '0'));
  if (result > (1n << 64n) - 1n) return fail();
  return result.toString();
}

/** Reads evidence already retained by Bundle. This is not current chain qualification or a listing authorization. */
export function buildMarketplaceOwnedInventory(
  input: OwnedInventorySources,
  now = Date.now(),
): MarketplaceOwnedInventory {
  if (
    !Number.isSafeInteger(now) ||
    input.wallets.length > 500 ||
    input.proofs.length > 500 ||
    input.runs.length > 100 ||
    input.receipts.length > 500
  ) {
    if (
      Number.isSafeInteger(now) &&
      input.wallets.length <= 500 &&
      input.proofs.length <= 500 &&
      input.receipts.length <= 500 &&
      input.runs.length > 100
    )
      throw new MarketplaceInventoryCapacityError('saved-history-run-limit');
    return fail();
  }
  const wallets = input.wallets.map((value) => wallet.parse(value)),
    walletMap = new Map(wallets.map((value) => [value.address, value]));
  if (walletMap.size !== wallets.length) return fail();
  for (const item of wallets) time(item.updatedAt, now);
  const proofs = new Map<string, string>();
  for (const value of input.proofs) {
    const item = proof.parse(value);
    if (!walletMap.has(item.address) || proofs.has(item.address)) return fail();
    time(item.verifiedAt, now);
    proofs.set(item.address, item.verifiedAt);
  }
  const receipts = new Map<string, z.infer<typeof receiptCounts>>();
  for (const value of input.receipts) {
    const item = receiptCounts.parse(value);
    if (
      !walletMap.has(item.address) ||
      receipts.has(item.address) ||
      item.uniqueSignatures > item.receiptCount
    )
      return fail();
    receipts.set(item.address, item);
  }
  const checks = new Map<
      string,
      {
        latest: z.infer<typeof retainedObservation> | null;
        oldest: string | null;
        success: number;
        failed: number;
      }
    >(),
    runIds = new Set<string>();
  let bytes = 0;
  for (const value of input.runs) {
    const item = run.parse(value);
    if (runIds.has(item.id)) return fail();
    runIds.add(item.id);
    const created = time(item.createdAt, now),
      updated = time(item.updatedAt, now);
    if (updated < created) return fail();
    bytes += new TextEncoder().encode(item.document).byteLength;
    if (bytes > 4 * 1024 * 1024)
      throw new MarketplaceInventoryCapacityError('saved-history-byte-limit');
    const document = runDocument.parse(JSON.parse(item.document)),
      captures = new Map(document.wallets.map((w) => [w.address, w.revision]));
    if (
      captures.size !== document.wallets.length ||
      new Set(document.results.map((r) => r.address)).size !==
        document.results.length
    )
      return fail();
    for (const result of document.results) {
      if (
        !captures.has(result.address) ||
        Boolean(result.observation) === Boolean(result.error)
      )
        return fail();
      if (!walletMap.has(result.address)) continue;
      const state = checks.get(result.address) ?? {
        latest: null,
        oldest: null,
        success: 0,
        failed: 0,
      };
      checks.set(result.address, state);
      if (result.error) {
        state.failed++;
        continue;
      }
      const obs = result.observation!;
      if (
        obs.address !== result.address ||
        obs.successfulSampleCount > obs.sampleCount
      )
        return fail();
      const observed = time(obs.observedAt, now);
      if (observed < created || observed > updated) return fail();
      if (
        (obs.oldestObservedAt === null) !== (obs.latestObservedAt === null) ||
        (obs.sampleCount === 0 &&
          (obs.oldestObservedAt !== null || obs.successfulSampleCount !== 0))
      )
        return fail();
      if (obs.oldestObservedAt !== null) {
        const oldest = time(obs.oldestObservedAt, observed),
          latest = time(obs.latestObservedAt!, observed);
        if (oldest > latest) return fail();
        if (state.oldest === null || oldest < Date.parse(state.oldest))
          state.oldest = obs.oldestObservedAt;
      }
      state.success++;
      const retained = {
        runId: item.id,
        walletRevision: captures.get(result.address)!,
        observedAt: obs.observedAt,
        source: obs.source,
        balanceLamports: atoms(obs.nativeBalance),
        sampleCount: obs.sampleCount,
        successfulSampleCount: obs.successfulSampleCount,
        oldestSampledActivityAt: obs.oldestObservedAt,
        latestSampledActivityAt: obs.latestObservedAt,
      };
      if (
        !state.latest ||
        observed > Date.parse(state.latest.observedAt) ||
        (observed === Date.parse(state.latest.observedAt) &&
          item.id > state.latest.runId)
      )
        state.latest = retained;
    }
  }
  return marketplaceOwnedInventoryResult.parse({
    format: 'bundle-owned-wallet-inventory-v1',
    chain: 'Solana',
    observedAt: new Date(now).toISOString(),
    listingEnabled: false,
    purchaseEnabled: false,
    deliveryEnabled: false,
    wallets: wallets.map((item) => {
      const evidence = checks.get(item.address),
        receipt = receipts.get(item.address);
      return {
        ...item,
        ownershipProofAt: proofs.get(item.address) ?? null,
        latestHistory: evidence?.latest ?? null,
        oldestRecordedActivityAt: evidence?.oldest ?? null,
        observedActivityAgeSeconds: evidence?.oldest
          ? Math.floor((now - Date.parse(evidence.oldest)) / 1000)
          : null,
        savedHistoryChecks: evidence?.success ?? 0,
        failedHistoryChecks: evidence?.failed ?? 0,
        warmupReceiptCount: receipt?.receiptCount ?? 0,
        warmupUniqueSignatures: receipt?.uniqueSignatures ?? 0,
      };
    }),
  });
}

export function admitMarketplaceOwnedInventory(
  value: unknown,
  now = Date.now(),
): MarketplaceOwnedInventory {
  if (!Number.isSafeInteger(now)) return fail();
  const result = marketplaceOwnedInventoryResult.parse(value),
    observed = Date.parse(result.observedAt);
  if (
    !Number.isSafeInteger(observed) ||
    new Date(observed).toISOString() !== result.observedAt
  )
    return fail();
  if (observed > now || now - observed > 60000)
    throw new MarketplaceInventoryClockError();
  if (
    new Set(result.wallets.map((w) => w.address)).size !== result.wallets.length
  )
    return fail();
  for (const row of result.wallets) {
    time(row.updatedAt, observed);
    if (row.ownershipProofAt) time(row.ownershipProofAt, observed);
    if (row.warmupUniqueSignatures > row.warmupReceiptCount) return fail();
    if (
      (row.oldestRecordedActivityAt === null) !==
        (row.observedActivityAgeSeconds === null) ||
      Boolean(row.latestHistory) !== Boolean(row.savedHistoryChecks) ||
      (!row.latestHistory && row.oldestRecordedActivityAt !== null)
    )
      return fail();
    if (
      row.oldestRecordedActivityAt &&
      row.observedActivityAgeSeconds !==
        Math.floor(
          (observed - time(row.oldestRecordedActivityAt, observed)) / 1000,
        )
    )
      return fail();
    if (row.latestHistory) {
      const h = row.latestHistory;
      time(h.observedAt, observed);
      if (
        h.successfulSampleCount > h.sampleCount ||
        (h.sampleCount === 0 &&
          (h.successfulSampleCount !== 0 ||
            h.oldestSampledActivityAt !== null)) ||
        (h.oldestSampledActivityAt === null) !==
          (h.latestSampledActivityAt === null)
      )
        return fail();
      if (h.oldestSampledActivityAt) {
        if (
          !row.oldestRecordedActivityAt ||
          time(h.oldestSampledActivityAt, Date.parse(h.observedAt)) >
            time(h.latestSampledActivityAt!, Date.parse(h.observedAt)) ||
          Date.parse(row.oldestRecordedActivityAt) >
            Date.parse(h.oldestSampledActivityAt)
        )
          return fail();
      }
    }
  }
  return structuredClone(result);
}
