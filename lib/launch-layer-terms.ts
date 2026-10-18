import { z } from 'zod';
import bs58 from 'bs58';
import { validateLaunchPlan, type SavedLaunchPlan } from './launch-plan';
import { quoteCatalog } from './quote-catalog';
import { walletReferenceFolderMatches } from './launch-wallets';
import type { WalletWorkspace } from './wallet-workspace';

// Planning contract only. None of these terms admits a funding or trade packet.
const U64_MAX = (1n << 64n) - 1n;
const NATIVE_QUOTE = 'So11111111111111111111111111111111111111112';
const revision = z
  .number()
  .int()
  .min(1)
  .max(Number.MAX_SAFE_INTEGER - 1);
const publicAddress = z.string().refine((address) => {
  if (address.length < 32 || address.length > 44) return false;
  try {
    const bytes = bs58.decode(address);
    return bytes.length === 32 && bs58.encode(bytes) === address;
  } catch {
    return false;
  }
}, 'Use a canonical Solana public address.');
const rawAmount = z
  .string()
  .regex(/^(0|[1-9]\d{0,19})$/)
  .refine(
    (value) => /^(0|[1-9]\d{0,19})$/.test(value) && BigInt(value) <= U64_MAX,
    'Amount exceeds a Solana unsigned 64-bit amount.',
  );
const walletReference = z
  .object({
    address: publicAddress,
    revision,
    folderRevision: z
      .number()
      .int()
      .min(0)
      .max(Number.MAX_SAFE_INTEGER - 1),
    folderId: z
      .string()
      .regex(/^[a-zA-Z0-9_-]{1,64}$/)
      .optional(),
    root: z.literal(true).optional(),
  })
  .strict()
  .refine(
    (ref) =>
      ref.root === true
        ? ref.folderId === undefined && ref.folderRevision === 0
        : ref.folderId === undefined
          ? ref.folderRevision === 0
          : ref.folderRevision > 0,
    'Use an exact current root or folder reference.',
  );
const walletBudget = z
  .object({
    wallet: walletReference,
    maximumBuyQuoteRaw: rawAmount,
    maximumNetworkFeeLamports: rawAmount,
    maximumAccountRentLamports: rawAmount,
    retainedNativeReserveLamports: rawAmount,
  })
  .strict();
const roles = z
  .object({
    funder: walletBudget,
    developer: walletBudget.optional(),
    front: z.array(walletBudget).min(1).max(200),
    back: z.array(walletBudget).max(200),
    temporary: z.array(walletBudget).max(200),
    holders: z.array(walletBudget).min(1).max(200),
  })
  .strict();
const delays = z
  .object({
    fundingDelaySeconds: z.number().int().min(0).max(86400),
    frontToBackDelayMs: z.number().int().min(0).max(10000),
    backToTemporaryDelayMs: z.number().int().min(0).max(10000),
  })
  .strict();
const requestSchema = z.object({ roles, delays }).strict();
const targetSchema = z
  .object({
    kind: z.enum(['new', 'imported']),
    mint: publicAddress,
  })
  .strict();
const timestamp = z.string().refine((value) => {
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}, 'Use an exact saved UTC timestamp.');
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const totalsSchema = z
  .object({
    maximumBuyQuoteRaw: rawAmount,
    maximumNetworkFeeLamports: rawAmount,
    maximumAccountRentLamports: rawAmount,
    retainedNativeReserveLamports: rawAmount,
    maximumNativeBudgetLamports: rawAmount,
  })
  .strict();
const termsSchema = z
  .object({
    format: z.literal('launch-layer-terms-v1'),
    protocol: z.literal('buyback'),
    binding: z
      .object({
        ownerId: z.string().min(1).max(200),
        savedPlanUpdatedAt: timestamp,
        savedPlanJson: z.string(),
        target: targetSchema,
      })
      .strict(),
    launchpad: z.enum(['PumpFun', 'StonkFun']),
    quote: z
      .object({
        kind: z.enum(['native', 'token']),
        address: publicAddress,
        decimals: z.number().int().min(0).max(18),
        symbol: z.string().min(1).max(40),
        evidence: z.literal('saved-catalog-units-only'),
      })
      .strict(),
    roles,
    delays,
    totals: totalsSchema,
    fundingAllowed: z.literal(false),
    signingAllowed: z.literal(false),
    executionAllowed: z.literal(false),
  })
  .strict();
const envelopeSchema = z
  .object({ terms: termsSchema, sha256: digestSchema })
  .strict();
export type LaunchLayerRequest = z.infer<typeof requestSchema>;
export type LaunchLayerTerms = z.infer<typeof termsSchema>;
export type LaunchLayerEnvelope = z.infer<typeof envelopeSchema>;
export type LaunchLayerContext = {
  // The future service must load these from authenticated owned storage.
  ownerId: string;
  savedPlan: SavedLaunchPlan;
  workspace: WalletWorkspace;
  target: z.infer<typeof targetSchema>;
};

function buildTerms(
  value: unknown,
  context: LaunchLayerContext,
): LaunchLayerTerms {
  const request = requestSchema.parse(value);
  const plan = validateLaunchPlan(context.savedPlan);
  const target = targetSchema.parse(context.target);
  if (
    plan.chain !== 'Solana' ||
    plan.mode !== 'Block-0' ||
    (plan.launchpad !== 'PumpFun' && plan.launchpad !== 'StonkFun')
  )
    throw new Error(
      'Layer terms currently describe Solana PumpFun or StonkFun sequenced plans only.',
    );
  if (target.kind === 'imported' && !plan.scheduled)
    throw new Error(
      'Imported layer terms require a scheduled existing-token plan.',
    );
  if ((target.kind === 'new') !== Boolean(request.roles.developer))
    throw new Error(
      'New launches need a developer wallet; imported tokens cannot claim a developer wallet.',
    );
  if (request.roles.holders.length !== plan.holderCount)
    throw new Error('Layer holders must exactly match the saved holder count.');
  if (
    plan.launchpad === 'StonkFun' &&
    (request.roles.front.length > 12 ||
      request.roles.back.length ||
      request.roles.temporary.length)
  )
    throw new Error(
      'StonkFun supports at most 12 Front wallets and no Back or temporary layer.',
    );
  if (
    !request.roles.back.length &&
    (request.roles.temporary.length || request.delays.frontToBackDelayMs)
  )
    throw new Error(
      'A Back layer is required for this buyback protocol and its delay.',
    );
  if (!request.roles.temporary.length && request.delays.backToTemporaryDelayMs)
    throw new Error('A temporary layer is required for its delay.');
  const candidates = quoteCatalog(plan.chain, plan.launchpad).assets.filter(
    (asset) =>
      asset.symbol === plan.currency &&
      (!plan.quoteAddress || asset.address === plan.quoteAddress),
  );
  if (candidates.length !== 1)
    throw new Error(
      'Select one exact quote asset before reviewing launch layers.',
    );
  const asset = candidates[0];
  const native = asset.address === NATIVE_QUOTE;
  if (asset.address === target.mint)
    throw new Error('The launch mint cannot also be its quote asset.');
  const entries = [
    { role: 'funder', member: request.roles.funder },
    ...(request.roles.developer
      ? [{ role: 'developer', member: request.roles.developer }]
      : []),
    ...(['front', 'back', 'temporary', 'holders'] as const).flatMap((role) =>
      request.roles[role].map((member) => ({ role, member })),
    ),
  ];
  const seen = new Set<string>();
  const sums = {
    maximumBuyQuoteRaw: 0n,
    maximumNetworkFeeLamports: 0n,
    maximumAccountRentLamports: 0n,
    retainedNativeReserveLamports: 0n,
    maximumNativeBudgetLamports: 0n,
  };
  for (const { role, member } of entries) {
    const ref = member.wallet;
    if (
      seen.has(ref.address) ||
      ref.address === target.mint ||
      ref.address === asset.address
    )
      throw new Error(
        'Layer wallets must be unique across roles and distinct from token mints.',
      );
    seen.add(ref.address);
    const matches = context.workspace.wallets.filter(
      (wallet) => wallet.chain === 'Solana' && wallet.address === ref.address,
    );
    const wallet = matches[0];
    if (
      matches.length !== 1 ||
      !wallet ||
      wallet.archived ||
      wallet.revision !== ref.revision ||
      !walletReferenceFolderMatches(ref, wallet, context.workspace)
    )
      throw new Error(
        `Reselect the current owned ${role} wallet ${ref.address} and folder.`,
      );
    if (
      (role === 'funder' || role === 'temporary') &&
      member.maximumBuyQuoteRaw !== '0'
    )
      throw new Error(
        'Funder and temporary roles cannot claim purchase budgets.',
      );
    if (
      (role === 'front' || role === 'back') &&
      member.maximumBuyQuoteRaw === '0'
    )
      throw new Error(
        'Front and Back buyer roles need explicit positive purchase ceilings.',
      );
    const nativeBudget =
      BigInt(member.maximumNetworkFeeLamports) +
      BigInt(member.maximumAccountRentLamports) +
      BigInt(member.retainedNativeReserveLamports) +
      (native ? BigInt(member.maximumBuyQuoteRaw) : 0n);
    if (nativeBudget > U64_MAX)
      throw new Error('Per-wallet native budget exceeds a Solana amount.');
    for (const key of [
      'maximumBuyQuoteRaw',
      'maximumNetworkFeeLamports',
      'maximumAccountRentLamports',
      'retainedNativeReserveLamports',
    ] as const)
      sums[key] += BigInt(member[key]);
    sums.maximumNativeBudgetLamports += nativeBudget;
  }
  if (Object.values(sums).some((total) => total > U64_MAX))
    throw new Error('Aggregate budget exceeds the supported Solana amount.');
  return termsSchema.parse({
    format: 'launch-layer-terms-v1',
    protocol: 'buyback',
    binding: {
      ownerId: context.ownerId,
      savedPlanUpdatedAt: context.savedPlan.updatedAt,
      savedPlanJson: JSON.stringify(plan),
      target,
    },
    launchpad: plan.launchpad,
    quote: {
      kind: native ? 'native' : 'token',
      ...asset,
      evidence: 'saved-catalog-units-only',
    },
    roles: request.roles,
    delays: request.delays,
    totals: Object.fromEntries(
      Object.entries(sums).map(([key, amount]) => [key, String(amount)]),
    ),
    fundingAllowed: false,
    signingAllowed: false,
    executionAllowed: false,
  });
}

const sha256 = async (text: string) =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)),
    ),
    (byte) => byte.toString(16).padStart(2, '0'),
  ).join('');

/** User ceilings, not funding requirements, mint attestations, approvals or signatures. */
export async function createLaunchLayerTerms(
  value: unknown,
  context: LaunchLayerContext,
): Promise<LaunchLayerEnvelope> {
  const terms = buildTerms(value, context);
  const sha256Digest = await sha256(JSON.stringify(terms));
  if (JSON.stringify(buildTerms(value, context)) !== JSON.stringify(terms))
    throw new Error('Launch layer context changed while capturing the terms.');
  return { terms, sha256: sha256Digest };
}

/** Rebuild under current owned context; a matching unkeyed digest grants no authority. */
export async function verifyLaunchLayerTerms(
  value: unknown,
  context: LaunchLayerContext,
): Promise<LaunchLayerEnvelope> {
  const saved = envelopeSchema.parse(value);
  const current = await createLaunchLayerTerms(
    { roles: saved.terms.roles, delays: saved.terms.delays },
    context,
  );
  if (
    saved.sha256 !== current.sha256 ||
    JSON.stringify(saved.terms) !== JSON.stringify(current.terms)
  )
    throw new Error(
      'Launch layer terms differ from the current saved plan, wallets or budgets.',
    );
  return current;
}
