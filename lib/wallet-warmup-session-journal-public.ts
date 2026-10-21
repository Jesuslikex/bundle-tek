import type { readWalletWarmupSessionJournal } from './wallet-warmup-session-journal-storage';
type Journal = NonNullable<
  Awaited<ReturnType<typeof readWalletWarmupSessionJournal>>
>;

/** Whitelist only. Internal plan, source, proof and raw event documents stay server-side. */
export function publicWalletWarmupSessionJournal(
  journal: Journal,
  eventId?: string,
) {
  const snapshot = journal.snapshot;
  const event = eventId
    ? journal.events.find((e) => e.id === eventId)
    : undefined;
  const document = event ? JSON.parse(event.document) : null;
  const pending = snapshot.pending;
  const reviewWindowUnavailable =
    snapshot.nextReviewAt !== null &&
    Date.parse(snapshot.nextReviewAt) >=
      Date.parse(journal.effectiveReviewExpiresAt);
  return {
    id: journal.id,
    consentId: journal.consentId,
    termsSha256: journal.termsSha256,
    createdAt: journal.createdAt,
    sessionExpiresAt: journal.sessionExpiresAt,
    effectiveReviewExpiresAt: journal.effectiveReviewExpiresAt,
    version: journal.version,
    headSha256: journal.headSha256,
    recoveryRequired: journal.recoveryRequired,
    snapshot: {
      phase:
        reviewWindowUnavailable &&
        ['waiting', 'review-required'].includes(snapshot.phase)
          ? ('refresh-required' as const)
          : snapshot.phase,
      planId: snapshot.planId,
      planRevision: snapshot.planRevision,
      sourceReviewFresh: snapshot.sourceReviewFresh,
      sourceReviewExpiresAt: snapshot.sourceReviewExpiresAt,
      completedActions: snapshot.completedActions,
      totalActions: snapshot.totalActions,
      nextReviewAt: reviewWindowUnavailable ? null : snapshot.nextReviewAt,
      reviewWindowUnavailable,
      paused: snapshot.paused,
      stopped: snapshot.stopped,
      pending: pending
        ? {
            state: pending.state,
            action: {
              id: pending.action.id,
              side: pending.action.side,
              cycle: pending.action.cycle,
              wallet: pending.action.wallet,
              walletRevision: pending.action.walletRevision,
              mint: pending.action.mint,
              scheduledAt: pending.action.scheduledAt,
            },
          }
        : null,
      wallets: snapshot.wallets.map((w) => ({
        wallet: w.wallet,
        recordedFurtherBuySpendLamports: w.recordedFurtherBuySpendLamports,
        recordedFurtherFeeRentLamports: w.recordedFurtherFeeRentLamports,
        remainingReserveLamports: w.remainingReserveLamports,
      })),
    },
    commandReceipt:
      event && document
        ? {
            id: event.id,
            operation: document.operation as string,
            actionId:
              typeof document.actionId === 'string' ? document.actionId : null,
            version: event.version,
            headSha256: event.event_sha256,
            at: event.created_at,
          }
        : null,
    executionAllowed: false as const,
    signingAllowed: false as const,
    automaticExecutionAllowed: false as const,
  };
}
