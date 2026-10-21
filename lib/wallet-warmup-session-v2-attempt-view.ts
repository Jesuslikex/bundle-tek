import { z } from 'zod';
import {
  warmupAttemptUuid as uuid,
  warmupAttemptHash as hash,
  warmupAttemptIso as iso,
  warmupAttemptUnits as units,
  warmupV2FeeEvidence as feeSchema,
} from './wallet-warmup-session-v2-attempt-types';
import {
  warmupV2Journal,
  type WarmupV2Journal,
  type WarmupV2Saved,
} from './wallet-warmup-session-v2-view';
import type { WalletWarmupSessionView } from './wallet-warmup-session-view';
const flags = {
  executionAllowed: z.literal(false),
  signingAllowed: z.literal(false),
  automaticExecutionAllowed: z.literal(false),
  instructionsVerified: z.literal(false),
};
const address = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
const positive = units.refine((v) => v !== '0');
const schema = z
  .object({
    attempt: z
      .object({
        format: z.literal('wallet-warmup-session-attempt-v2'),
        id: uuid,
        originalHead: z
          .object({
            format: z.literal('wallet-warmup-attempt-head-v2'),
            historical: z.literal(true),
            journal: z.unknown(),
          })
          .strict(),
        journalId: uuid,
        actionId: z.string().min(1).max(256),
        sequence: z.number().int().min(1).max(14400),
        attempt: z.number().int().min(1).max(3),
        maxAttempts: z.literal(3),
        reviewVersion: z.number().int().min(1).max(65535),
        reviewHeadSha256: hash,
        termsSha256: hash,
        createdAt: iso,
        leaseExpiresAt: iso,
        nextAttemptAt: iso,
        outcome: z
          .object({
            kind: z.enum(['prepared', 'refused']),
            createdAt: iso,
            expiresAt: iso,
            refusalCode: z
              .enum([
                'provider-refused',
                'provider-limited',
                'provider-unavailable',
                'evidence-refused',
              ])
              .nullable(),
            recordSha256: hash,
          })
          .strict()
          .nullable(),
        preview: z
          .object({
            side: z.enum(['Buy', 'Sell']),
            wallet: address,
            inputMint: address,
            outputMint: address,
            inAmountRaw: positive,
            quotedOutRaw: positive,
            minimumOutRaw: positive,
            quoteExpiresAt: iso,
            packetSha256: hash,
            estimatedFeesLamports: units,
            feeUpperBoundLamports: units,
            networkFeeLamports: units,
            fees: feeSchema,
            simulationSucceeded: z.literal(true),
            tokensComplete: z.literal(true),
          })
          .strict()
          .nullable(),
        ...flags,
        limitations: z.literal(
          'Unsigned quote and simulation preview only. No instruction, custody or signing qualification, funds reservation or trade execution.',
        ),
      })
      .strict(),
  })
  .strict();
export type WarmupV2AttemptView = z.infer<typeof schema>['attempt'];
const markerSchema = z
  .object({
    format: z.literal('wallet-warmup-attempt-reminder-v2'),
    id: uuid,
    journal: z.unknown(),
  })
  .strict();
export type WarmupV2AttemptReminder = {
  format: 'wallet-warmup-attempt-reminder-v2';
  id: string;
  journal: WarmupV2Journal;
};
function fail(): never {
  throw Error(
    'Unsigned preview differs from the saved request. Keep its original ID and recover before another attempt.',
  );
}
export async function warmupV2AttemptReminder(
  value: unknown,
  consent: WarmupV2Saved,
): Promise<WarmupV2AttemptReminder> {
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 32768)
    fail();
  const marker = markerSchema.parse(value),
    journal = await warmupV2Journal({ journal: marker.journal }, consent, {
      id: (marker.journal as { id?: string })?.id ?? '',
    });
  if (
    journal.snapshot.phase !== 'reviewing' ||
    !journal.snapshot.pendingReview ||
    journal.version < 1 ||
    journal.version > 65535
  )
    fail();
  return { ...marker, journal };
}
/** Display admission and saved-only recovery. No source freshness or signing renewal. */
export async function warmupV2AttemptView(
  value: unknown,
  marker: WarmupV2AttemptReminder,
  consent: WarmupV2Saved,
) {
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 16384)
    fail();
  const a = schema.parse(value).attempt,
    j = marker.journal,
    manifest = JSON.parse(
      consent.terms.reviewDocument,
    ) as WalletWarmupSessionView['review'],
    action = manifest.actions[0],
    wallet = manifest.wallets.find((w) => w.wallet === action.wallet);
  const historical = await warmupV2AttemptReminder(
    {
      format: 'wallet-warmup-attempt-reminder-v2',
      id: a.id,
      journal: a.originalHead.journal,
    },
    consent,
  );
  if (
    historical.journal.id !== j.id ||
    historical.journal.version !== j.version ||
    historical.journal.headSha256 !== j.headSha256
  )
    fail();
  if (
    !wallet ||
    j.consentId !== consent.id ||
    j.termsSha256 !== consent.termsSha256 ||
    !j.snapshot.pendingReview ||
    a.id !== marker.id ||
    a.journalId !== j.id ||
    a.termsSha256 !== consent.termsSha256 ||
    a.actionId !== action.id ||
    a.reviewVersion !== j.version ||
    a.reviewHeadSha256 !== j.headSha256 ||
    a.sequence > consent.terms.policy.maxQualifications ||
    a.createdAt < j.updatedAt ||
    a.createdAt < action.scheduledAt ||
    a.leaseExpiresAt !==
      new Date(
        Math.min(
          Date.parse(a.createdAt) + 60000,
          Date.parse(consent.terms.sessionExpiresAt),
        ),
      ).toISOString() ||
    a.createdAt >= a.leaseExpiresAt ||
    a.nextAttemptAt !== new Date(Date.parse(a.createdAt) + 30000).toISOString()
  )
    fail();
  const o = a.outcome,
    p = a.preview;
  if (o && (o.createdAt < a.createdAt || o.createdAt >= a.leaseExpiresAt))
    fail();
  if (o?.kind === 'prepared') {
    const wrapped = 'So11111111111111111111111111111111111111112';
    if (
      !p ||
      o.refusalCode !== null ||
      p.side !== action.side ||
      p.wallet !== action.wallet ||
      p.inputMint !== (action.side === 'Buy' ? wrapped : action.mint) ||
      p.outputMint !== (action.side === 'Sell' ? wrapped : action.mint) ||
      p.inAmountRaw !==
        (action.side === 'Buy'
          ? action.inputLamports
          : action.source.kind === 'saved-buy'
            ? action.source.remainingRaw
            : '') ||
      BigInt(p.minimumOutRaw) > BigInt(p.quotedOutRaw) ||
      p.fees.observedNetworkFeeLamports !== p.networkFeeLamports ||
      BigInt(p.estimatedFeesLamports) !==
        BigInt(p.fees.signatureFeeLamports) +
          BigInt(p.fees.prioritizationFeeLamports) +
          BigInt(p.fees.rentFeeLamports) ||
      BigInt(p.feeUpperBoundLamports) !==
        (BigInt(p.fees.signatureFeeLamports) +
          BigInt(p.fees.prioritizationFeeLamports) >
        BigInt(p.networkFeeLamports)
          ? BigInt(p.fees.signatureFeeLamports) +
            BigInt(p.fees.prioritizationFeeLamports)
          : BigInt(p.networkFeeLamports)) +
          BigInt(p.fees.rentFeeLamports) ||
      p.fees.boundLamports !== p.feeUpperBoundLamports ||
      BigInt(p.feeUpperBoundLamports) >
        BigInt(wallet.remainingFeeReserveLamports) ||
      o.expiresAt !==
        new Date(
          Math.min(Date.parse(a.leaseExpiresAt), Date.parse(p.quoteExpiresAt)),
        ).toISOString() ||
      o.createdAt >= o.expiresAt
    )
      fail();
  } else if (
    p !== null ||
    (o && (o.refusalCode === null || o.expiresAt !== o.createdAt))
  )
    fail();
  return a;
}
export async function recoverWarmupV2AttemptView(
  value: unknown,
  id: string,
  consent: WarmupV2Saved,
) {
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 16384)
    fail();
  const a = schema.parse(value).attempt;
  if (a.id !== id) fail();
  const marker = await warmupV2AttemptReminder(
    {
      format: 'wallet-warmup-attempt-reminder-v2',
      id,
      journal: a.originalHead.journal,
    },
    consent,
  );
  return { marker, attempt: await warmupV2AttemptView(value, marker, consent) };
}
const pageSchema = z
  .object({
    page: z
      .object({
        format: z.literal('wallet-warmup-attempt-page-v2'),
        journalId: uuid,
        termsSha256: hash,
        requests: z
          .array(
            z
              .object({
                id: uuid,
                actionId: z.string().min(1).max(256),
                sequence: z.number().int().min(1).max(14400),
                attempt: z.number().int().min(1).max(3),
                createdAt: iso,
                expiresAt: iso,
              })
              .strict(),
          )
          .max(25),
        nextBefore: z.number().int().min(1).max(14400).nullable(),
        ...flags,
      })
      .strict(),
  })
  .strict();
export type WarmupV2AttemptPage = z.infer<typeof pageSchema>['page'];
export function warmupV2AttemptPage(
  value: unknown,
  journal: WarmupV2Journal,
  consent: WarmupV2Saved,
  before: number | null,
) {
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 16384)
    fail();
  const p = pageSchema.parse(value).page;
  if (
    p.journalId !== journal.id ||
    p.termsSha256 !== consent.termsSha256 ||
    journal.consentId !== consent.id
  )
    fail();
  const manifest = JSON.parse(
      consent.terms.reviewDocument,
    ) as WalletWarmupSessionView['review'],
    ids = new Set<string>();
  let last = before ?? 14401;
  for (const a of p.requests) {
    if (
      ids.has(a.id) ||
      a.actionId !== manifest.actions[0].id ||
      a.sequence >= last ||
      a.sequence > consent.terms.policy.maxQualifications ||
      a.createdAt < consent.createdAt ||
      a.createdAt < manifest.actions[0].scheduledAt ||
      a.expiresAt !==
        new Date(
          Math.min(
            Date.parse(a.createdAt) + 60000,
            Date.parse(consent.terms.sessionExpiresAt),
          ),
        ).toISOString()
    )
      fail();
    ids.add(a.id);
    last = a.sequence;
  }
  if (
    p.nextBefore !== null &&
    (p.requests.length !== 25 || p.nextBefore !== p.requests.at(-1)?.sequence)
  )
    fail();
  return p;
}
