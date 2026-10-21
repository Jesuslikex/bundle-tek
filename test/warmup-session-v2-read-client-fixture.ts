import { warmupV2AttemptClientFixture } from './warmup-session-v2-attempt-client-fixture';
import type { WarmupReadMode } from '../lib/wallet-warmup-session-v2-read-view';
export async function warmupReadClientFixture(at?: number) {
  const f = await warmupV2AttemptClientFixture(at);
  function response(
    id: string,
    mode: WarmupReadMode = 'preview',
    kind: 'prepared' | 'refused' | 'pending' = 'prepared',
  ) {
    const prior = f.response(id, kind);
    if (mode === 'preview') return { mode, ...prior };
    const expiry = new Date(f.at + 15000).toISOString();
    return {
      mode,
      ...prior,
      runtime: {
        mode: 'runtime-observation-v1',
        purposeSha256: 'c'.repeat(64),
        effectiveExpiresAt: kind === 'prepared' ? expiry : null,
        observation:
          kind === 'prepared'
            ? {
                packetSha256: prior.attempt.preview!.packetSha256,
                observedAt: prior.attempt.outcome!.createdAt,
                expiresAt: expiry,
                minimumSlot: 100,
                maximumSlot: 103,
                programCount: 3,
                codeScans: 2,
                referenceMinimum: 'order-self',
                codeClockPolicy: 'context-slot-floor-only',
              }
            : null,
        programCodeAttested: false,
        independentPriceProtectionEstablished: false,
        trustedProgramPolicyEstablished: false,
        signingAllowed: false,
        executionAllowed: false,
        automaticExecutionAllowed: false,
        instructionsVerified: false,
        limitations:
          'Saved raw-account and code identity observations only. The minimum is the order’s own bound, with no independent price check. Code chunks use context-slot floors, not per-chunk Clock reads. No trusted code policy, funds reservation, signing or execution permission.',
      },
    };
  }
  return { ...f, readResponse: response };
}
