import { z } from 'zod';
import bs58 from 'bs58';
import { canonicalPumpHolderJson as canonical } from './pump-holder-review';
import { walletWarmupSessionDigest as digest } from './wallet-warmup-session-digest';
import {
  SWAP_TOKEN,
  SWAP_TOKEN_2022,
  SWAP_WRAPPED_SOL,
} from './swap-token-program-evidence';
import { reviewWalletWarmupExecutionPacing } from './wallet-warmup-execution-pacing';

export const WARMUP_EXECUTION_POLICY = Object.freeze({
  version: 'warmup-execution-policy-v1' as const,
  minimumGapMs: 30000 as const,
  qualificationTtlMs: 60000 as const,
  maxAttemptsPerAction: 3 as const,
  maxPendingActions: 1 as const,
  authorizationMs: 5000 as const,
  // 4,800 *15 nominal retry/recovery steps +4,096 controls +four terminal steps.
  modelSteps: 76100 as const,
});

export const warmupExecutionUnits = z
  .string()
  .regex(/^(0|[1-9]\d{0,19})$/)
  .refine((v) => BigInt(v) <= (1n << 64n) - 1n);
export const warmupExecutionHash = z.string().regex(/^[a-f0-9]{64}$/);
export const warmupExecutionId = z.uuid().refine((v) => v === v.toLowerCase());
const positive = warmupExecutionUnits.refine((v) => BigInt(v) > 0n);
const address = z
  .string()
  .min(32)
  .max(44)
  .refine((v) => {
    try {
      return bs58.decode(v).length === 32;
    } catch {
      return false;
    }
  });
const iso = z.iso.datetime().refine((v) => {
  const ms = Date.parse(v);
  return Number.isFinite(ms) && new Date(ms).toISOString() === v;
});
export const warmupExecutionTimestamp = iso;
const baseAction = z.object({
  id: z.string().min(1).max(256),
  wallet: address,
  mint: address,
  tokenProgram: z.enum([SWAP_TOKEN, SWAP_TOKEN_2022]),
  decimals: z.number().int().min(0).max(18),
  scheduledAt: iso,
  maximumFeeRentLamports: warmupExecutionUnits,
});
const action = z.discriminatedUnion('side', [
  baseAction
    .extend({ side: z.literal('Buy'), inputLamports: positive })
    .strict(),
  baseAction
    .extend({
      side: z.literal('Sell'),
      source: z.discriminatedUnion('kind', [
        z
          .object({
            kind: z.literal('saved-buy'),
            receiptId: warmupExecutionId,
          })
          .strict(),
        z
          .object({
            kind: z.literal('action-buy'),
            actionId: z.string().min(1).max(256),
          })
          .strict(),
      ]),
    })
    .strict(),
]);
const schema = z
  .object({
    format: z.literal('wallet-warmup-execution-manifest-v1'),
    id: warmupExecutionId,
    ownerId: z.string().min(1).max(256),
    consentId: warmupExecutionId,
    policy: z
      .object({
        version: z.literal(WARMUP_EXECUTION_POLICY.version),
        minimumGapMs: z.literal(WARMUP_EXECUTION_POLICY.minimumGapMs),
        qualificationTtlMs: z.literal(
          WARMUP_EXECUTION_POLICY.qualificationTtlMs,
        ),
        maxAttemptsPerAction: z.literal(
          WARMUP_EXECUTION_POLICY.maxAttemptsPerAction,
        ),
        maxPendingActions: z.literal(WARMUP_EXECUTION_POLICY.maxPendingActions),
        authorizationMs: z.literal(WARMUP_EXECUTION_POLICY.authorizationMs),
        modelSteps: z.literal(WARMUP_EXECUTION_POLICY.modelSteps),
      })
      .strict(),
    planId: z.string().min(1).max(256),
    planRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    sourceSha256: warmupExecutionHash,
    consentSha256: warmupExecutionHash,
    createdAt: iso,
    expiresAt: iso,
    wallets: z
      .array(
        z
          .object({
            wallet: address,
            revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
            maximumBuyLamports: warmupExecutionUnits,
            maximumFeeRentLamports: warmupExecutionUnits,
          })
          .strict(),
      )
      .min(1)
      .max(20),
    savedLots: z
      .array(
        z
          .object({
            receiptId: warmupExecutionId,
            wallet: address,
            mint: address,
            tokenProgram: z.enum([SWAP_TOKEN, SWAP_TOKEN_2022]),
            decimals: z.number().int().min(0).max(18),
            remainingRaw: positive,
            sourceSha256: warmupExecutionHash,
          })
          .strict(),
      )
      .max(4800),
    actions: z.array(action).min(1).max(4800),
  })
  .strict();
export type WarmupExecutionManifest = z.infer<typeof schema>;
export type WarmupExecutionAction = WarmupExecutionManifest['actions'][number];
const intentSchema = schema
  .omit({ format: true, consentSha256: true })
  .extend({ format: z.literal('wallet-warmup-execution-intent-v1') })
  .strict();
export type WarmupExecutionIntent = z.infer<typeof intentSchema>;

/** Shape/economics contract only. Hashes bind content; they are not evidence of
 * consent, wallet ownership, runtime checks, receipt validity or permission. */
export function parseWarmupExecutionManifest(value: unknown) {
  return checkExecutionBody(schema.parse(value));
}
/** Complete pre-consent semantics in a distinct domain. No placeholder hash. */
export function parseWarmupExecutionIntent(value: unknown) {
  return checkExecutionBody(intentSchema.parse(value));
}
function checkExecutionBody<
  T extends Omit<WarmupExecutionManifest, 'format' | 'consentSha256'>,
>(m: T) {
  const fail = (): never => {
    throw Error('Execution manifest dependencies or budgets differ.');
  };
  const start = Date.parse(m.createdAt),
    end = Date.parse(m.expiresAt);
  if (start < 0 || end <= start || end > 8640000000000000 - 60000) fail();
  const wallets = new Map(m.wallets.map((w) => [w.wallet, w]));
  const lots = new Map(m.savedLots.map((l) => [l.receiptId, l]));
  if (wallets.size !== m.wallets.length || lots.size !== m.savedLots.length)
    fail();
  const seen = new Map<string, WarmupExecutionAction>();
  const assets = new Map<string, string>();
  const checkAsset = (a: {
    mint: string;
    tokenProgram: string;
    decimals: number;
  }) => {
    const key = `${a.tokenProgram}:${a.decimals}`;
    if (
      a.mint === SWAP_WRAPPED_SOL ||
      wallets.has(a.mint) ||
      (assets.has(a.mint) && assets.get(a.mint) !== key)
    )
      fail();
    assets.set(a.mint, key);
  };
  for (const l of m.savedLots) checkAsset(l);
  const usedSources = new Set<string>();
  const usedWallets = new Set<string>();
  const buys = new Map<string, bigint>(),
    fees = new Map<string, bigint>();
  let previous = start;
  for (const a of m.actions) {
    checkAsset(a);
    const at = Date.parse(a.scheduledAt);
    if (!wallets.has(a.wallet) || seen.has(a.id) || at < previous || at >= end)
      fail();
    previous = at;
    usedWallets.add(a.wallet);
    fees.set(
      a.wallet,
      (fees.get(a.wallet) ?? 0n) + BigInt(a.maximumFeeRentLamports),
    );
    if (a.side === 'Buy') {
      buys.set(a.wallet, (buys.get(a.wallet) ?? 0n) + BigInt(a.inputLamports));
    } else {
      const key =
        a.source.kind === 'saved-buy'
          ? `saved:${a.source.receiptId}`
          : `action:${a.source.actionId}`;
      const source =
        a.source.kind === 'saved-buy'
          ? lots.get(a.source.receiptId)
          : seen.get(a.source.actionId);
      if (
        !source ||
        ('side' in source && source.side !== 'Buy') ||
        source.wallet !== a.wallet ||
        source.mint !== a.mint ||
        source.tokenProgram !== a.tokenProgram ||
        source.decimals !== a.decimals ||
        usedSources.has(key)
      )
        fail();
      usedSources.add(key);
    }
    seen.set(a.id, a);
  }
  for (const w of m.wallets)
    if (
      !usedWallets.has(w.wallet) ||
      (buys.get(w.wallet) ?? 0n) > BigInt(w.maximumBuyLamports) ||
      (fees.get(w.wallet) ?? 0n) > BigInt(w.maximumFeeRentLamports) ||
      BigInt(w.maximumBuyLamports) + BigInt(w.maximumFeeRentLamports) >
        (1n << 64n) - 1n
    )
      fail();
  for (const a of m.actions)
    if (a.side === 'Buy' && !usedSources.has(`action:${a.id}`)) fail();
  for (const lot of m.savedLots)
    if (!usedSources.has(`saved:${lot.receiptId}`)) fail();
  if (
    end > previous + 300000 ||
    !reviewWalletWarmupExecutionPacing(
      {
        actions: m.actions.map((a) => ({
          id: a.id,
          scheduledAt: a.scheduledAt,
        })),
        sessionExpiresAt: m.expiresAt,
      },
      start,
    ).fitsMinimumPacing
  )
    fail();
  return m;
}
export async function bindWarmupExecutionManifest(value: unknown) {
  const manifest = parseWarmupExecutionManifest(value);
  return { manifest, sha256: await digest(canonical(manifest)) };
}
