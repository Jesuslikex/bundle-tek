import { warmupConsentClientFixture } from './warmup-session-consent-client-fixture';
import { walletWarmupSessionDigest as digest } from '@/lib/wallet-warmup-session-digest';
import { warmupV2ClientCanonical as canonical } from '@/lib/wallet-warmup-session-v2-view';
/** Synthetic public DTOs only. These are newly constructed v2 policy fixtures,
 * never an upgrade/conversion of an actual retained v1 approval. */
export async function warmupV2ClientFixture(at = Date.now()) {
  const f = await warmupConsentClientFixture(at);
  const finish = new Date(
    Math.max(...f.view.review.actions.map((a) => Date.parse(a.scheduledAt))) +
      60000,
  ).toISOString();
  async function preview(deadline = finish) {
    const base = await f.preview(deadline);
    const terms = {
      ...base.consentReview.terms,
      format: 'wallet-warmup-session-consent-v2' as const,
      policy: {
        qualificationTtlMs: 60000 as const,
        minimumGapMs: 30000 as const,
        maxAttemptsPerAction: 3 as const,
        maxPendingActions: 1 as const,
        maxQualifications: f.view.review.actions.length * 3,
      },
    };
    return {
      consentReview: {
        ...base.consentReview,
        terms,
        termsSha256: await digest(canonical(terms)),
      },
    };
  }
  const prepared = await preview();
  function saved(id = crypto.randomUUID(), value = prepared) {
    return {
      consent: {
        id,
        createdAt: new Date(at).toISOString(),
        terms: value.consentReview.terms,
        termsSha256: value.consentReview.termsSha256,
        reviewCreatedAt: value.consentReview.reviewCreatedAt,
      },
    };
  }
  const consent = saved();
  async function journal(id = crypto.randomUUID(), value = consent) {
    const createdAt = new Date(at).toISOString();
    return {
      journal: {
        format: 'wallet-warmup-session-journal-v2' as const,
        id,
        consentId: value.consent.id,
        termsSha256: value.consent.termsSha256,
        createdAt,
        version: 0,
        headSha256: await digest(
          canonical([
            'wallet-warmup-session-journal-v2',
            id,
            value.consent.id,
            value.consent.termsSha256,
            createdAt,
          ]),
        ),
        updatedAt: createdAt,
        sessionExpiresAt: value.consent.terms.sessionExpiresAt,
        planId: f.plan.id,
        planRevision: f.plan.revision,
        snapshot: {
          phase: 'review-required',
          paused: false,
          stopped: false,
          expired: false,
          totalActions: f.view.review.actions.length,
          completedActions: 0,
          pendingReview: null as null | {
            id: string;
            wallet: string;
            walletRevision: number;
            cycle: number;
            side: 'Buy' | 'Sell';
            mint: string;
            scheduledAt: string;
          },
        },
        wallets: f.view.review.wallets.map((w) => ({
          wallet: w.wallet,
          reviewedBuySpendLamports: w.buySpendLamports,
          reviewedFeeReserveLamports: w.remainingFeeReserveLamports,
        })),
        commandReceipt: null as null | {
          id: string;
          operation: 'begin-review' | 'pause' | 'resume' | 'stop';
          version: number;
          previousSha256: string;
          headSha256: string;
          at: string;
          actionId?: string;
        },
        executionAllowed: false,
        signingAllowed: false,
        automaticExecutionAllowed: false,
        qualificationAvailable: false,
        limitations:
          'Saved plan history and review-slot metadata only. No fresh provider qualification, funds reservation, signing or automatic activity is enabled.',
      },
    };
  }
  async function control(
    previous: Awaited<ReturnType<typeof journal>>,
    input: {
      id: string;
      control: 'begin-review' | 'pause' | 'resume' | 'stop';
    },
  ) {
    const j = structuredClone(previous.journal),
      a = f.view.review.actions[0],
      createdAt = new Date(Date.now()).toISOString();
    const event = {
      format: 'wallet-warmup-session-event-v2',
      eventId: input.id,
      version: j.version + 1,
      previousSha256: j.headSha256,
      at: createdAt,
      operation: input.control,
      ...(input.control === 'begin-review' ? { actionId: a.id } : {}),
    };
    j.version++;
    j.headSha256 = await digest(canonical(event));
    j.updatedAt = createdAt;
    j.commandReceipt = {
      id: input.id,
      operation: input.control,
      version: j.version,
      previousSha256: event.previousSha256,
      headSha256: j.headSha256,
      at: createdAt,
      ...(input.control === 'begin-review' ? { actionId: a.id } : {}),
    };
    if (input.control === 'begin-review')
      j.snapshot.pendingReview = {
        id: a.id,
        wallet: a.wallet,
        walletRevision: a.walletRevision,
        cycle: a.cycle,
        side: a.side,
        mint: a.mint,
        scheduledAt: a.scheduledAt,
      };
    if (input.control === 'pause') j.snapshot.paused = true;
    if (input.control === 'resume') j.snapshot.paused = false;
    if (input.control === 'stop') j.snapshot.stopped = true;
    j.snapshot.phase = j.snapshot.stopped
      ? 'stopped'
      : j.snapshot.paused
        ? 'paused'
        : j.snapshot.pendingReview
          ? 'reviewing'
          : 'review-required';
    return { journal: j };
  }
  return { ...f, finish, preview, prepared, saved, consent, journal, control };
}
