import { z } from 'zod';
import { operatorListingSelection } from './marketplace-operator-review';
import {
  admitMarketplaceOwnedInventory,
  type MarketplaceOwnedInventory,
} from './marketplace-owned-inventory';
const uint = z
  .string()
  .regex(/^(0|[1-9]\d{0,19})$/)
  .refine((v) => BigInt(v) <= (1n << 64n) - 1n);
const slot = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const system = '11111111111111111111111111111111';
export class MarketplaceInspectionClockError extends Error {
  constructor() {
    super(
      'Account inspection is stale or ahead of this device clock. Check automatic date and time, then request a fresh review and inspection.',
    );
  }
}
const account = z
  .object({
    kind: z.enum(['absent', 'system-wallet', 'unsupported-account']),
    balanceLamports: uint,
    owner: z.string().min(32).max(44).nullable(),
    executable: z.boolean().nullable(),
    space: uint.nullable(),
  })
  .strict();
export const saleInspectionSchema = z
  .object({
    format: z.literal('bundle-sale-account-inspection-v1'),
    chain: z.literal('Solana'),
    selection: operatorListingSelection,
    startedAt: z.iso.datetime(),
    observedAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
    source: z
      .string()
      .min(1)
      .max(253)
      .regex(/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/),
    commitment: z.literal('confirmed'),
    floorSlot: slot,
    accountSlot: slot,
    finalSlot: slot,
    account,
    historicalControlProofAt: z.iso.datetime().nullable(),
    historicalBalanceLamports: uint.nullable(),
    balanceDifferenceLamports: z
      .string()
      .regex(/^-?(0|[1-9]\d{0,19})$/)
      .nullable(),
    currentControlVerified: z.literal(false),
    tokenInventoryChecked: z.literal(false),
    provenanceVerified: z.literal(false),
    saleQualified: z.literal(false),
    paymentAllowed: z.literal(false),
    deliveryAllowed: z.literal(false),
    signingAllowed: z.literal(false),
  })
  .strict();
export type SaleInspection = z.infer<typeof saleInspectionSchema>;
/** Exact informational replay only. No schema flag admits sale or signing authority. */
export function admitSaleInspection(
  value: unknown,
  inventory: MarketplaceOwnedInventory,
  selection: unknown,
  now = Date.now(),
): SaleInspection {
  const envelope = z
    .object({ inspection: saleInspectionSchema })
    .strict()
    .parse(value);
  const result = envelope.inspection,
    expected = operatorListingSelection.parse(selection);
  const start = Date.parse(result.startedAt),
    observed = Date.parse(result.observedAt),
    expiry = Date.parse(result.expiresAt);
  if (
    [result.startedAt, result.observedAt, result.expiresAt].some(
      (v) => new Date(v).toISOString() !== v,
    )
  )
    throw Error('Account inspection timestamps differ.');
  const fail = (): never => {
    throw Error(
      'Account inspection differs or expired. Reload seller inventory and inspect again.',
    );
  };
  if (Number.isSafeInteger(now) && (observed > now || now >= expiry))
    throw new MarketplaceInspectionClockError();
  const captured = admitMarketplaceOwnedInventory(inventory, now).wallets.find(
    (w) =>
      w.address === expected.address && w.revision === expected.walletRevision,
  );
  if (
    !captured ||
    JSON.stringify(result.selection) !== JSON.stringify(expected) ||
    !Number.isSafeInteger(now) ||
    start < Date.parse(inventory.observedAt) ||
    observed < start ||
    observed > now ||
    expiry - start !== 60000 ||
    now >= expiry ||
    observed >= expiry ||
    result.accountSlot < result.floorSlot ||
    result.finalSlot < result.accountSlot ||
    result.finalSlot - result.floorSlot > 32
  )
    return fail();
  if (
    result.historicalControlProofAt !== captured.ownershipProofAt ||
    result.historicalBalanceLamports !==
      (captured.latestHistory?.balanceLamports ?? null)
  )
    return fail();
  const a = result.account;
  if (a.kind === 'absent') {
    if (
      a.balanceLamports !== '0' ||
      a.owner !== null ||
      a.executable !== null ||
      a.space !== null
    )
      return fail();
  } else {
    if (
      a.owner === null ||
      a.executable === null ||
      a.space === null ||
      BigInt(a.space) > BigInt(Number.MAX_SAFE_INTEGER)
    )
      return fail();
    const ordinary =
      a.owner === system && a.executable === false && a.space === '0';
    if ((a.kind === 'system-wallet') !== ordinary) return fail();
  }
  const difference =
    captured.latestHistory === null
      ? null
      : (
          BigInt(a.balanceLamports) -
          BigInt(captured.latestHistory.balanceLamports)
        ).toString();
  if (difference !== result.balanceDifferenceLamports) return fail();
  return result;
}
