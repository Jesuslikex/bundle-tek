import { z } from 'zod';
import { WARMUP_V2_POLICY } from './wallet-warmup-session-v2-consent';

const MAX_DATE_MS = 8640000000000000;
const iso = z.iso
  .datetime()
  .refine(
    (value) =>
      Number.isFinite(Date.parse(value)) &&
      new Date(value).toISOString() === value,
  );
const input = z
  .object({
    actions: z
      .array(
        z
          .object({
            id: z.string().min(1).max(256),
            scheduledAt: iso,
          })
          .strict(),
      )
      .min(1)
      .max(4800),
    sessionExpiresAt: iso,
  })
  .strict();

/**
 * Necessary schedule bound only, NOT execution admission. The caller must derive
 * this ordered selection from a newly verified immutable execution manifest.
 * Runtime reads, user approvals, finality and competing owner work only add time.
 * Does not read providers/storage, extend a deadline, or change v2 read consent.
 */
export function reviewWalletWarmupExecutionPacing(
  value: unknown,
  now = Date.now(),
) {
  const selected = input.parse(value);
  if (!Number.isSafeInteger(now) || now < 0 || now > MAX_DATE_MS)
    throw Error('Choose a valid server observation time.');
  if (
    new Set(selected.actions.map((action) => action.id)).size !==
    selected.actions.length
  )
    throw Error('Each captured action must have a distinct identity.');
  const minimumGapMs = WARMUP_V2_POLICY.minimumGapMs;
  const deadline = Date.parse(selected.sessionExpiresAt);
  let earliest = now;
  let firstUnreachableActionId: string | null = null;
  for (const [index, action] of selected.actions.entries()) {
    // Date inputs are <=MAX_DATE_MS; <=4,799 additions of 30s stay below 2^53.
    earliest = Math.max(
      Date.parse(action.scheduledAt),
      index === 0 ? now : earliest + minimumGapMs,
    );
    if (earliest >= deadline && firstUnreachableActionId === null)
      firstUnreachableActionId = action.id;
  }
  const fitsMinimumPacing = firstUnreachableActionId === null;
  return {
    scope: 'schedule-lower-bound-only' as const,
    status: fitsMinimumPacing
      ? ('qualification-required' as const)
      : ('minimum-pacing-refused' as const),
    fitsMinimumPacing,
    actionCount: selected.actions.length,
    minimumGapMs,
    sessionExpiresAt: selected.sessionExpiresAt,
    earliestLastStartEpochMs: earliest,
    earliestLastStartAt:
      earliest <= MAX_DATE_MS ? new Date(earliest).toISOString() : null,
    firstUnreachableActionId,
    executionAllowed: false as const,
    signingAllowed: false as const,
    automaticExecutionAllowed: false as const,
  };
}
