import { z } from 'zod';
import {
  warmupAttemptHash as hash,
  warmupAttemptIso as iso,
  warmupAttemptUuid as uuid,
} from './wallet-warmup-session-v2-attempt-types';
import {
  warmupV2AttemptReminder,
  warmupV2AttemptView,
  recoverWarmupV2AttemptView,
  warmupV2AttemptPage,
  type WarmupV2AttemptReminder,
  type WarmupV2AttemptView,
} from './wallet-warmup-session-v2-attempt-view';
import type {
  WarmupV2Saved,
  WarmupV2Journal,
} from './wallet-warmup-session-v2-view';
export type WarmupReadMode = 'preview' | 'runtime';
export type WarmupReadReminder = Omit<WarmupV2AttemptReminder, 'format'> & {
  format: 'wallet-warmup-read-reminder-v1';
  mode: WarmupReadMode;
};
const mode = z.enum(['preview', 'runtime']);
const markerSchema = z
  .object({
    format: z.literal('wallet-warmup-read-reminder-v1'),
    mode,
    id: uuid,
    journal: z.unknown(),
  })
  .strict();
const limits =
  'Saved raw-account and code identity observations only. The minimum is the order’s own bound, with no independent price check. Code chunks use context-slot floors, not per-chunk Clock reads. No trusted code policy, funds reservation, signing or execution permission.';
const slot = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const runtimeSchema = z
  .object({
    mode: z.literal('runtime-observation-v1'),
    purposeSha256: hash,
    effectiveExpiresAt: iso.nullable(),
    observation: z
      .object({
        packetSha256: hash,
        observedAt: iso,
        expiresAt: iso,
        minimumSlot: slot,
        maximumSlot: slot,
        programCount: z.number().int().min(1).max(16),
        codeScans: z.literal(2),
        referenceMinimum: z.literal('order-self'),
        codeClockPolicy: z.literal('context-slot-floor-only'),
      })
      .strict()
      .nullable(),
    programCodeAttested: z.literal(false),
    independentPriceProtectionEstablished: z.literal(false),
    trustedProgramPolicyEstablished: z.literal(false),
    signingAllowed: z.literal(false),
    executionAllowed: z.literal(false),
    automaticExecutionAllowed: z.literal(false),
    instructionsVerified: z.literal(false),
    limitations: z.literal(limits),
  })
  .strict();
const valueSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('preview'), attempt: z.unknown() }).strict(),
  z
    .object({
      mode: z.literal('runtime'),
      attempt: z.unknown(),
      runtime: runtimeSchema,
    })
    .strict(),
]);
function fail(): never {
  throw Error(
    'Saved check differs from its original mode or request. Keep the original ID and recover it.',
  );
}
function bound(value: unknown) {
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 32768)
    fail();
}
const legacy = (m: WarmupReadReminder): WarmupV2AttemptReminder => ({
  format: 'wallet-warmup-attempt-reminder-v2',
  id: m.id,
  journal: m.journal,
});
export async function warmupReadReminder(
  value: unknown,
  consent: WarmupV2Saved,
): Promise<WarmupReadReminder> {
  bound(value);
  if (
    (value as { format?: unknown })?.format ===
    'wallet-warmup-attempt-reminder-v2'
  ) {
    const old = await warmupV2AttemptReminder(value, consent);
    return {
      ...old,
      format: 'wallet-warmup-read-reminder-v1',
      mode: 'preview',
    };
  }
  const parsed = markerSchema.parse(value);
  const old = await warmupV2AttemptReminder(
    {
      format: 'wallet-warmup-attempt-reminder-v2',
      id: parsed.id,
      journal: parsed.journal,
    },
    consent,
  );
  return {
    ...old,
    format: 'wallet-warmup-read-reminder-v1',
    mode: parsed.mode,
  };
}
export type WarmupReadView = {
  mode: WarmupReadMode;
  attempt: WarmupV2AttemptView;
  runtime: z.infer<typeof runtimeSchema> | null;
};
export function warmupReadPostResponse(value: unknown, mode: WarmupReadMode) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    'mode' in value
  )
    fail();
  return valueSchema.parse({ mode, ...value });
}
/** Exact display admission only. Historical observations cannot authorize a trade. */
export async function warmupReadView(
  value: unknown,
  marker: WarmupReadReminder,
  consent: WarmupV2Saved,
): Promise<WarmupReadView> {
  bound(value);
  const parsed = valueSchema.parse(value);
  if (parsed.mode !== marker.mode) fail();
  const attempt = await warmupV2AttemptView(
    { attempt: parsed.attempt },
    legacy(marker),
    consent,
  );
  return bindRuntime(parsed, attempt);
}
function bindRuntime(
  parsed: z.infer<typeof valueSchema>,
  attempt: WarmupV2AttemptView,
): WarmupReadView {
  const runtime = parsed.mode === 'runtime' ? parsed.runtime : null;
  if (runtime) {
    const o = runtime.observation,
      prepared = attempt.outcome?.kind === 'prepared';
    if (prepared !== !!o || prepared !== !!runtime.effectiveExpiresAt) fail();
    if (
      o &&
      (!attempt.preview ||
        !attempt.outcome ||
        o.packetSha256 !== attempt.preview.packetSha256 ||
        o.maximumSlot < o.minimumSlot ||
        o.maximumSlot - o.minimumSlot > 32 ||
        Date.parse(o.observedAt) >= Date.parse(o.expiresAt) ||
        Date.parse(o.observedAt) > Date.parse(attempt.outcome.createdAt) ||
        Date.parse(o.expiresAt) <= Date.parse(attempt.outcome.createdAt) ||
        Date.parse(o.expiresAt) > Date.parse(attempt.outcome.expiresAt) ||
        runtime.effectiveExpiresAt !== o.expiresAt)
    )
      fail();
  }
  return { mode: parsed.mode, attempt, runtime };
}
export async function recoverWarmupReadView(
  value: unknown,
  id: string,
  consent: WarmupV2Saved,
) {
  bound(value);
  const parsed = valueSchema.parse(value);
  const prior = await recoverWarmupV2AttemptView(
    { attempt: parsed.attempt },
    id,
    consent,
  );
  const marker: WarmupReadReminder = {
    ...prior.marker,
    format: 'wallet-warmup-read-reminder-v1',
    mode: parsed.mode,
  };
  return { marker, view: bindRuntime(parsed, prior.attempt) };
}
export function warmupReadPage(
  value: unknown,
  journal: WarmupV2Journal,
  consent: WarmupV2Saved,
  before: number | null,
) {
  bound(value);
  // The original parser validates all lease/head/cursor/authority fields. Modes
  // are admitted separately; they never change a retained request's purpose.
  const outer = z
    .object({
      page: z
        .object({
          format: z.literal('wallet-warmup-read-page-v1'),
          requests: z.array(z.object({ mode }).loose()).max(25),
        })
        .loose(),
    })
    .strict()
    .parse(value);
  const modes = outer.page.requests.map((r) => r.mode);
  const page = warmupV2AttemptPage(
    {
      page: {
        ...outer.page,
        format: 'wallet-warmup-attempt-page-v2',
        requests: outer.page.requests.map(({ mode: _mode, ...row }) => row),
      },
    },
    journal,
    consent,
    before,
  );
  return {
    ...page,
    format: 'wallet-warmup-read-page-v1' as const,
    requests: page.requests.map((row, index) => ({
      ...row,
      mode: modes[index],
    })),
  };
}
export type WarmupReadPage = ReturnType<typeof warmupReadPage>;
