import { z } from 'zod';
import bs58 from 'bs58';
import { operatorListingSelection } from './marketplace-operator-review';
import { operatorDraftCanonical } from './marketplace-operator-draft-view';
import {
  admitMarketplaceOwnedInventory,
  type MarketplaceOwnedInventory,
  type MarketplaceOwnedWallet,
} from './marketplace-owned-inventory';
import { walletWarmupSessionDigest as digest } from './wallet-warmup-session-digest';
export const MARKETPLACE_TOKEN_PROGRAMS = [
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
] as const;
export const MARKETPLACE_TOKEN_ACCOUNT_LIMIT = 200;
export class MarketplaceTokenInspectionClockError extends Error {
  constructor() {
    super(
      'Token inspection is stale or ahead of this device clock. Check automatic date and time, then request a fresh review and inspection.',
    );
  }
}
export const MARKETPLACE_ACCOUNT_EXTENSIONS = [
  'TransferFeeAmount',
  'ConfidentialTransferAccount',
  'ImmutableOwner',
  'MemoTransfer',
  'CpiGuard',
  'NonTransferableAccount',
  'TransferHookAccount',
  'ConfidentialTransferFeeAmount',
  'PausableAccount',
] as const;
export const MARKETPLACE_TOKEN_COVERAGE =
  'Provider-returned accounts owned by this wallet under the original Token Program and Token-2022 only. Limits are 200 accounts combined, 2 MiB per enumeration response and 16 KiB per account; exceeding any limit refuses the whole inspection. Large Token-2022 accounts can reach the response limit before 200 accounts. Raw base amounts are not token prices or transferable balances. Mint authorities, permanent delegates, confidential amounts, stake, compressed assets and other programs are not covered. No empty-wallet or sale qualification guarantee.';
const key = z
  .string()
  .min(32)
  .max(44)
  .refine((v) => {
    try {
      const b = bs58.decode(v);
      return b.length === 32 && bs58.encode(b) === v;
    } catch {
      return false;
    }
  });
const uint = z
  .string()
  .regex(/^(0|[1-9]\d{0,19})$/)
  .refine((v) => BigInt(v) <= (1n << 64n) - 1n);
const slot = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const count = z.number().int().min(0).max(MARKETPLACE_TOKEN_ACCOUNT_LIMIT);
const program = z.enum(MARKETPLACE_TOKEN_PROGRAMS);
export const marketplaceTokenAccount = z
  .object({
    address: key,
    program,
    walletOwner: key,
    mint: key,
    slot,
    amountRaw: uint,
    lamports: uint,
    state: z.enum(['initialized', 'frozen']),
    delegate: key.nullable(),
    delegatedAmountRaw: uint,
    closeAuthority: key.nullable(),
    nativeReserveRaw: uint.nullable(),
    extensions: z.array(z.enum(MARKETPLACE_ACCOUNT_EXTENSIONS)).max(64),
    byteLength: z.number().int().min(165).max(16384),
    encodedDataSha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type MarketplaceTokenAccount = z.infer<typeof marketplaceTokenAccount>;
const observation = z.object({ program, slot, count }).strict();
export const marketplaceTokenInspection = z
  .object({
    format: z.literal('bundle-sale-token-inspection-v1'),
    chain: z.literal('Solana'),
    selection: operatorListingSelection,
    sellerEvidenceSha256: z.string().regex(/^[a-f0-9]{64}$/),
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
    finalSlot: slot,
    programs: z.tuple([observation, observation]),
    accounts: z
      .array(marketplaceTokenAccount)
      .max(MARKETPLACE_TOKEN_ACCOUNT_LIMIT),
    accountCount: count,
    nonzeroRawAccounts: count,
    frozenAccounts: count,
    delegatedAccounts: count,
    foreignCloseAuthorities: count,
    extendedAccounts: count,
    coverage: z.literal(MARKETPLACE_TOKEN_COVERAGE),
    currentControlVerified: z.literal(false),
    allAssetsAndAuthoritiesChecked: z.literal(false),
    extensionSemanticsChecked: z.literal(false),
    saleQualified: z.literal(false),
    paymentAllowed: z.literal(false),
    deliveryAllowed: z.literal(false),
    signingAllowed: z.literal(false),
  })
  .strict();
export type MarketplaceTokenInspection = z.infer<
  typeof marketplaceTokenInspection
>;
export function tokenInspectionCounts(
  accounts: MarketplaceTokenAccount[],
  wallet: string,
) {
  return {
    accountCount: accounts.length,
    nonzeroRawAccounts: accounts.filter((a) => a.amountRaw !== '0').length,
    frozenAccounts: accounts.filter((a) => a.state === 'frozen').length,
    delegatedAccounts: accounts.filter((a) => a.delegate !== null).length,
    foreignCloseAuthorities: accounts.filter(
      (a) => a.closeAuthority !== null && a.closeAuthority !== wallet,
    ).length,
    extendedAccounts: accounts.filter((a) => a.extensions.length > 0).length,
  };
}
export function tokenInspectionSourceHash(wallet: MarketplaceOwnedWallet) {
  return digest(
    operatorDraftCanonical({ ...wallet, observedActivityAgeSeconds: null }),
  );
}
/** Informational admission only; a complete provider response cannot establish custody or sale authority. */
export async function admitMarketplaceTokenInspection(
  value: unknown,
  inventory: MarketplaceOwnedInventory,
  input: unknown,
  now = Date.now(),
) {
  const { inspection } = z
    .object({ inspection: marketplaceTokenInspection })
    .strict()
    .parse(value);
  const selection = operatorListingSelection.parse(input),
    captured = admitMarketplaceOwnedInventory(inventory, now).wallets.find(
      (w) =>
        w.address === selection.address &&
        w.revision === selection.walletRevision,
    );
  const fail = (): never => {
    throw Error(
      'Owned token inspection differs or expired. Reload inventory and inspect again.',
    );
  };
  if (
    !captured ||
    operatorDraftCanonical(inspection.selection) !==
      operatorDraftCanonical(selection)
  )
    return fail();
  const start = Date.parse(inspection.startedAt),
    observed = Date.parse(inspection.observedAt),
    expiry = Date.parse(inspection.expiresAt);
  if (Number.isSafeInteger(now) && (observed > now || now >= expiry))
    throw new MarketplaceTokenInspectionClockError();
  if (
    !Number.isSafeInteger(now) ||
    [inspection.startedAt, inspection.observedAt, inspection.expiresAt].some(
      (v) => new Date(v).toISOString() !== v,
    ) ||
    start < Date.parse(inventory.observedAt) ||
    observed < start ||
    observed > now ||
    observed >= expiry ||
    expiry - start !== 60000 ||
    now >= expiry
  )
    return fail();
  if (
    inspection.sellerEvidenceSha256 !==
    (await tokenInspectionSourceHash(captured))
  )
    return fail();
  let previousSlot = inspection.floorSlot;
  for (let i = 0; i < 2; i++) {
    const p = inspection.programs[i];
    if (p.program !== MARKETPLACE_TOKEN_PROGRAMS[i] || p.slot < previousSlot)
      return fail();
    previousSlot = p.slot;
  }
  if (
    inspection.finalSlot < previousSlot ||
    inspection.finalSlot - inspection.floorSlot > 32
  )
    return fail();
  const seen = new Set<string>();
  let previousAddress = '';
  for (const a of inspection.accounts) {
    if (
      seen.has(a.address) ||
      a.address <= previousAddress ||
      a.walletOwner !== selection.address ||
      a.slot !==
        inspection.programs.find((p) => p.program === a.program)?.slot ||
      (a.delegate === null && a.delegatedAmountRaw !== '0') ||
      (a.nativeReserveRaw !== null &&
        BigInt(a.nativeReserveRaw) > BigInt(a.lamports)) ||
      new Set(a.extensions).size !== a.extensions.length ||
      a.extensions.some((e, i) => i > 0 && e <= a.extensions[i - 1]) ||
      (a.program === MARKETPLACE_TOKEN_PROGRAMS[0] &&
        (a.byteLength !== 165 || a.extensions.length !== 0)) ||
      (a.byteLength === 165 && a.extensions.length !== 0)
    )
      return fail();
    seen.add(a.address);
    previousAddress = a.address;
  }
  for (const p of inspection.programs)
    if (
      p.count !==
      inspection.accounts.filter((a) => a.program === p.program).length
    )
      return fail();
  for (const [k, v] of Object.entries(
    tokenInspectionCounts(inspection.accounts, selection.address),
  ))
    if (inspection[k as keyof ReturnType<typeof tokenInspectionCounts>] !== v)
      return fail();
  return inspection;
}
