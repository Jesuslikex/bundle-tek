import { warmupV2ClientFixture } from './warmup-session-v2-client-fixture';
import {
  warmupV2Saved,
  warmupV2Journal,
} from '@/lib/wallet-warmup-session-v2-view';
export async function warmupV2AttemptClientFixture(at = Date.now()) {
  const f = await warmupV2ClientFixture(at),
    consent = await warmupV2Saved(f.consent, {
      id: f.consent.consent.id,
      planId: f.plan.id,
    });
  const root = await f.journal();
  const controlled = await f.control(root, {
    id: crypto.randomUUID(),
    control: 'begin-review',
  });
  const journal = await warmupV2Journal(controlled, consent, {
    id: root.journal.id,
  });
  const action = f.view.review.actions[0],
    wrapped = 'So11111111111111111111111111111111111111112';
  function response(
    id: string,
    kind: 'prepared' | 'refused' | 'pending' = 'prepared',
    attempt = 1,
  ) {
    const created = at + 1000,
      result = at + 2000,
      quote = at + 26000;
    return {
      attempt: {
        format: 'wallet-warmup-session-attempt-v2',
        id,
        originalHead: {
          format: 'wallet-warmup-attempt-head-v2',
          historical: true,
          journal,
        },
        journalId: journal.id,
        actionId: action.id,
        sequence: attempt,
        attempt,
        maxAttempts: 3,
        reviewVersion: journal.version,
        reviewHeadSha256: journal.headSha256,
        termsSha256: consent.termsSha256,
        createdAt: new Date(created).toISOString(),
        leaseExpiresAt: new Date(
          Math.min(created + 60000, Date.parse(consent.terms.sessionExpiresAt)),
        ).toISOString(),
        nextAttemptAt: new Date(created + 30000).toISOString(),
        outcome:
          kind === 'pending'
            ? null
            : {
                kind,
                createdAt: new Date(result).toISOString(),
                expiresAt: new Date(
                  kind === 'prepared' ? quote : result,
                ).toISOString(),
                refusalCode: kind === 'refused' ? 'evidence-refused' : null,
                recordSha256: 'a'.repeat(64),
              },
        preview:
          kind === 'prepared'
            ? {
                side: 'Buy',
                wallet: action.wallet,
                inputMint: wrapped,
                outputMint: action.mint,
                inAmountRaw: action.side === 'Buy' ? action.inputLamports : '1',
                quotedOutRaw: '101',
                minimumOutRaw: '100',
                quoteExpiresAt: new Date(quote).toISOString(),
                packetSha256: 'b'.repeat(64),
                estimatedFeesLamports: '10000',
                feeUpperBoundLamports: '10000',
                networkFeeLamports: '5000',
                fees: {
                  signatureFeeLamports: '5000',
                  prioritizationFeeLamports: '0',
                  rentFeeLamports: '5000',
                  observedNetworkFeeLamports: '5000',
                  boundLamports: '10000',
                },
                simulationSucceeded: true,
                tokensComplete: true,
              }
            : null,
        executionAllowed: false,
        signingAllowed: false,
        automaticExecutionAllowed: false,
        instructionsVerified: false,
        limitations:
          'Unsigned quote and simulation preview only. No instruction, custody or signing qualification, funds reservation or trade execution.',
      },
    };
  }
  return { ...f, consent, journal, response, at };
}
