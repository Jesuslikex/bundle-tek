import { z } from 'zod';
import type {
  WarmupJournalContext,
  WarmupJournalView,
} from './wallet-warmup-session-journal-view';

const uuid = z.uuid().refine((v) => v === v.toLowerCase());
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const iso = z.iso.datetime().refine((v) => new Date(v).toISOString() === v);
const address = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
const units = z
  .string()
  .regex(/^(0|[1-9]\d{0,19})$/)
  .refine((v) => BigInt(v) < 1n << 64n);
const positive = units.refine((v) => v !== '0');
const nativeChange = z
  .string()
  .regex(/^(0|-?[1-9]\d{0,19})$/)
  .refine((v) => {
    const n = BigInt(v);
    return n > -(1n << 64n) && n < 1n << 64n;
  });
const wrappedSol = 'So11111111111111111111111111111111111111112';
const limitations =
  'Unsigned preparation only. No signing, sending or automatic execution. Simulation and fee estimates do not establish instruction or custody clearance.';
const schema = z
  .object({
    id: uuid,
    journalId: uuid,
    actionId: z.string().min(1).max(256),
    reviewVersion: z.number().int().min(1).max(4095),
    reviewHeadSha256: hash,
    planId: z.string().min(1).max(64),
    planRevision: z.number().int().positive(),
    cycle: z.number().int().min(1).max(20),
    walletRevision: z.number().int().positive(),
    createdAt: iso,
    side: z.enum(['Buy', 'Sell']),
    wallet: address,
    mint: address,
    inputMint: address,
    outputMint: address,
    inAmountRaw: positive,
    quotedOutRaw: positive,
    minimumOutRaw: positive,
    expiresAt: iso,
    packetAvailability: z.enum([
      'retained',
      'summary-only',
      'storage-unavailable',
    ]),
    packetSha256: hash.nullable(),
    estimatedFeesLamports: units,
    nativeChangeRaw: nativeChange.nullable(),
    limitations: z.literal(limitations),
    simulation: z
      .object({
        succeeded: z.literal(true),
        networkFeeLamports: units,
        tokensComplete: z.literal(true),
        inputAmountMatches: z.boolean().nullable(),
        minimumOutputCovered: z.boolean().nullable(),
      })
      .strict(),
    executionAllowed: z.literal(false),
    signingAllowed: z.literal(false),
    automaticExecutionAllowed: z.literal(false),
    instructionsVerified: z.literal(false),
  })
  .strict();
export type WarmupPreparationView = z.infer<typeof schema>;
export type WarmupPreparationIdentity = {
  id: string;
  journalId: string;
  version: number;
  headSha256: string;
};
function fail(): never {
  throw Error(
    'Saved unsigned preparation is unavailable or differs from this action. Recover the original request before preparing again.',
  );
}
/** Display admission only. Pass the original admitted review head, including during recovery.
 * Expired records remain readable; this function never renews them or grants authority. */
export function warmupPreparationView(
  value: unknown,
  identity: WarmupPreparationIdentity,
  journal: WarmupJournalView,
  context: WarmupJournalContext,
) {
  try {
    if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 16384)
      fail();
    const p = z
      .object({ preparation: schema })
      .strict()
      .parse(value).preparation;
    const pending = journal.snapshot.pending;
    const a = pending?.action;
    const original = context.actions.find((item) => item.id === a?.id);
    const budget = journal.snapshot.wallets.find((w) => w.wallet === a?.wallet);
    const expectedDeadline = Math.min(
      Date.parse(context.sourceReviewExpiresAt),
      Date.parse(context.sessionExpiresAt),
    );
    if (
      !a ||
      !original ||
      !budget ||
      pending?.state !== 'reviewing' ||
      journal.consentId !== context.consentId ||
      journal.termsSha256 !== context.termsSha256 ||
      journal.snapshot.planId !== context.planId ||
      journal.snapshot.planRevision !== context.planRevision ||
      Object.entries(a).some(([key, item]) => original[key] !== item) ||
      identity.id !== p.id ||
      identity.journalId !== journal.id ||
      identity.version !== journal.version ||
      identity.headSha256 !== journal.headSha256 ||
      p.journalId !== identity.journalId ||
      p.reviewVersion !== identity.version ||
      p.reviewHeadSha256 !== identity.headSha256 ||
      p.actionId !== a.id ||
      p.planId !== context.planId ||
      p.planRevision !== context.planRevision ||
      p.side !== a.side ||
      p.wallet !== a.wallet ||
      p.walletRevision !== a.walletRevision ||
      p.cycle !== a.cycle ||
      p.mint !== a.mint ||
      p.mint === wrappedSol ||
      p.inputMint !== (a.side === 'Buy' ? wrappedSol : a.mint) ||
      p.outputMint !== (a.side === 'Buy' ? a.mint : wrappedSol) ||
      Date.parse(journal.effectiveReviewExpiresAt) !== expectedDeadline ||
      Date.parse(p.createdAt) < Date.parse(journal.createdAt) ||
      Date.parse(p.createdAt) < Date.parse(a.scheduledAt) ||
      Date.parse(p.expiresAt) <= Date.parse(p.createdAt) ||
      Date.parse(p.createdAt) >= expectedDeadline ||
      BigInt(p.minimumOutRaw) > BigInt(p.quotedOutRaw) ||
      BigInt(p.estimatedFeesLamports) >
        BigInt(budget.remainingReserveLamports) ||
      BigInt(p.simulation.networkFeeLamports) >
        BigInt(budget.remainingReserveLamports) ||
      (p.packetAvailability === 'retained') !== (p.packetSha256 !== null) ||
      (a.side === 'Buy'
        ? p.inAmountRaw !== original.inputLamports ||
          p.simulation.minimumOutputCovered !== true ||
          p.simulation.inputAmountMatches === false
        : p.simulation.inputAmountMatches !== true ||
          p.simulation.minimumOutputCovered === false)
    )
      fail();
    // A saved-buy action has an immutable upper bound. A session-buy lot is checked server-side.
    if (a.side === 'Sell') {
      const source = z
        .object({ kind: z.string(), remainingRaw: positive.optional() })
        .loose()
        .parse(original.source);
      if (
        source.kind === 'saved-buy' &&
        (!source.remainingRaw ||
          BigInt(p.inAmountRaw) > BigInt(source.remainingRaw))
      )
        fail();
    }
    return {
      ...p,
      effectiveReviewExpiresAt: new Date(
        Math.min(Date.parse(p.expiresAt), expectedDeadline),
      ).toISOString(),
    };
  } catch {
    return fail();
  }
}
