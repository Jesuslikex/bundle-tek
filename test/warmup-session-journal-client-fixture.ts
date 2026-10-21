import { warmupConsentClientFixture } from './warmup-session-consent-client-fixture';
import { warmupConsentSaved } from '../lib/wallet-warmup-session-consent-view';
import {
  warmupJournalContext,
  type WarmupJournalView,
  type WarmupJournalRequest,
} from '../lib/wallet-warmup-session-journal-view';
import { walletWarmupSessionDigest as digest } from '../lib/wallet-warmup-session-digest';
/** Synthetic display/control DTOs only. No wallet, provider, SQL or execution. */
export async function warmupJournalClientFixture(at = Date.now()) {
  const base = await warmupConsentClientFixture(at);
  const prepared = await base.preview(new Date(at + 120000).toISOString());
  const consent = await warmupConsentSaved(
    base.saved('00000000-0000-4000-8000-000000000002', prepared),
    { id: '00000000-0000-4000-8000-000000000002', planId: base.plan.id },
    base.view.review,
  );
  const context = warmupJournalContext(consent);
  function root(
    id = '00000000-0000-4000-8000-000000000003',
  ): WarmupJournalView {
    return {
      id,
      consentId: consent.id,
      termsSha256: consent.termsSha256,
      createdAt: consent.createdAt,
      sessionExpiresAt: consent.terms.sessionExpiresAt,
      effectiveReviewExpiresAt: context.sourceReviewExpiresAt,
      version: 0,
      headSha256: 'a'.repeat(64),
      recoveryRequired: false,
      snapshot: {
        phase: 'review-required',
        planId: base.plan.id,
        planRevision: 1,
        sourceReviewFresh: true,
        sourceReviewExpiresAt: context.sourceReviewExpiresAt,
        completedActions: 0,
        totalActions: context.actions.length,
        nextReviewAt: context.actions[0].scheduledAt,
        reviewWindowUnavailable: false,
        paused: false,
        stopped: false,
        pending: null,
        wallets: context.wallets.map((w) => ({
          wallet: w.wallet,
          recordedFurtherBuySpendLamports: '0',
          recordedFurtherFeeRentLamports: '0',
          remainingReserveLamports: w.remainingFeeReserveLamports,
        })),
      },
      commandReceipt: null,
      executionAllowed: false,
      signingAllowed: false,
      automaticExecutionAllowed: false,
    };
  }
  function request(
    journal: WarmupJournalView,
    control: 'pause' | 'resume' | 'stop' = 'pause',
  ): WarmupJournalRequest {
    return {
      format: 'warmup-journal-request-v1',
      kind: 'control',
      id: crypto.randomUUID(),
      consentId: consent.id,
      termsSha256: consent.termsSha256,
      journalId: journal.id,
      expectedVersion: journal.version,
      expectedHeadSha256: journal.headSha256,
      control,
    };
  }
  async function apply(
    journal: WarmupJournalView,
    command: Extract<WarmupJournalRequest, { kind: 'control' }>,
    clock = Date.now(),
  ) {
    const j = structuredClone(journal),
      version = j.version + 1,
      date = new Date(clock).toISOString();
    j.headSha256 = await digest(
      JSON.stringify({
        at: date,
        eventId: command.id,
        operation: command.control,
        previousSha256: command.expectedHeadSha256,
        version,
      }),
    );
    j.version = version;
    if (command.control === 'pause') j.snapshot.paused = true;
    if (command.control === 'resume') j.snapshot.paused = false;
    if (command.control === 'stop') j.snapshot.stopped = true;
    j.snapshot.phase =
      j.snapshot.pending?.state === 'unknown'
        ? 'recovery-required'
        : j.snapshot.stopped
          ? 'stopped'
          : j.snapshot.pending
            ? 'in-flight'
            : j.snapshot.completedActions === j.snapshot.totalActions
              ? 'complete'
              : j.snapshot.paused
                ? 'paused'
                : 'review-required';
    j.commandReceipt = {
      id: command.id,
      operation: command.control,
      actionId: null,
      version,
      headSha256: j.headSha256,
      at: date,
    };
    return j;
  }
  return { ...base, consent, context, root, request, apply };
}
