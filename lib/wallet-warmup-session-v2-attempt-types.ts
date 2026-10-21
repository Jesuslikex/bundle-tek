import { z } from 'zod';
export const warmupAttemptUuid = z.uuid().refine((v) => v === v.toLowerCase());
export const warmupAttemptHash = z.string().regex(/^[a-f0-9]{64}$/);
export const warmupAttemptIso = z.iso
  .datetime()
  .refine((v) => new Date(v).toISOString() === v);
export const warmupAttemptUnits = z
  .string()
  .regex(/^(0|[1-9]\d{0,19})$/)
  .refine((v) => BigInt(v) < 1n << 64n);
export const warmupV2AttemptInput = z
  .object({
    id: warmupAttemptUuid,
    journalId: warmupAttemptUuid,
    version: z.number().int().min(1).max(65535),
    headSha256: warmupAttemptHash,
  })
  .strict();
export const warmupV2AttemptRow = z
  .object({
    owner_id: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/),
    id: warmupAttemptUuid,
    journal_id: warmupAttemptUuid,
    action_id: z.string().min(1).max(256),
    sequence: z.number().int().min(1).max(14400),
    attempt_no: z.number().int().min(1).max(3),
    previous_id: warmupAttemptUuid.nullable(),
    review_version: z.number().int().min(1).max(65535),
    review_sha256: warmupAttemptHash,
    terms_sha256: warmupAttemptHash,
    created_at: warmupAttemptIso,
    expires_at: warmupAttemptIso,
  })
  .strict();
export const warmupV2OutcomeRow = z
  .object({
    owner_id: z.string(),
    attempt_id: warmupAttemptUuid,
    kind: z.enum(['prepared', 'refused']),
    summary_document: z.string().max(8192).nullable(),
    unsigned_transaction: z.string().min(1).max(1644).nullable(),
    packet_sha256: warmupAttemptHash.nullable(),
    fee_document: z.string().max(512).nullable(),
    refusal_code: z
      .enum([
        'provider-refused',
        'provider-limited',
        'provider-unavailable',
        'evidence-refused',
      ])
      .nullable(),
    created_at: warmupAttemptIso,
    expires_at: warmupAttemptIso,
    record_sha256: warmupAttemptHash,
  })
  .strict();
export const warmupV2FeeEvidence = z
  .object({
    signatureFeeLamports: warmupAttemptUnits,
    prioritizationFeeLamports: warmupAttemptUnits,
    rentFeeLamports: warmupAttemptUnits,
    observedNetworkFeeLamports: warmupAttemptUnits,
    boundLamports: warmupAttemptUnits,
  })
  .strict();
export type WarmupV2AttemptRow = z.infer<typeof warmupV2AttemptRow>;
export type WarmupV2OutcomeRow = z.infer<typeof warmupV2OutcomeRow>;
export class WalletWarmupV2AttemptError extends Error {
  constructor(
    message = 'Recover the original unsigned attempt before trying again.',
    readonly status = 409,
    readonly recoveryId?: string,
  ) {
    super(message);
  }
}
export const warmupV2AttemptFlags = {
  executionAllowed: false as const,
  signingAllowed: false as const,
  automaticExecutionAllowed: false as const,
  instructionsVerified: false as const,
};
