import { counterPreviewUiFixture } from './counter-preview-ui-fixture';
import type {
  CounterBudgetReview,
  CounterBudgetSaved,
  CounterBudgetSelection,
} from '../lib/counter-owned-budget';
import type {
  CounterBudgetPreview,
  CounterBudgetPreviewRequest,
} from '../lib/counter-owned-preview';
import { COUNTER_BUY_METADATA_ACK } from '../lib/counter-buy-budget-view';
export function counterBudgetUiFixture(now = Date.now()) {
  const f = counterPreviewUiFixture();
  const selection: CounterBudgetSelection = {
    ...f.request,
    budgetId: '123e4567-e89b-42d3-a456-426614174111',
    maximumInputLamports: '1000000000',
    maximumFeeAndRentLamports: '10000000',
    expiresAt: new Date(now + 86400000).toISOString(),
  };
  // The budget totals are independent of the original per-order request.
  delete (selection as Partial<typeof f.request>).maximumSolInputRaw;
  delete (selection as Partial<typeof f.request>).maximumFeeAndRentRaw;
  const authority = {
    signingAllowed: false as const,
    executionAllowed: false as const,
    automaticExecutionAllowed: false as const,
    sourceVerified: false as const,
    instructionsVerified: false as const,
    walletFundsReserved: false as const,
  };
  const metadata = {
    ...authority,
    approvalAllowed: false as const,
    reservationCreated: false as const,
    accountingCapacityReserved: false as const,
  };
  const review: CounterBudgetReview = {
    format: 'owned-counter-budget-review-v1',
    selection,
    terms: {
      id: selection.budgetId,
      projectId: selection.projectId,
      projectRevision: selection.projectRevision,
      mint: f.plan.ledger.scope.mint,
      tokenDecimals: f.plan.ledger.scope.decimals,
      maximumInputLamports: selection.maximumInputLamports,
      maximumFeeAndRentLamports: selection.maximumFeeAndRentLamports,
      expiresAt: selection.expiresAt,
      wallets: [
        {
          address: selection.wallet,
          revision: selection.walletRevision,
          maximumInputLamports: selection.maximumInputLamports,
          maximumFeeAndRentLamports: selection.maximumFeeAndRentLamports,
        },
      ],
      strategies: [
        {
          id: selection.planId,
          kind: 'Counter',
          sourceSha256: 'b'.repeat(64),
          maximumInputLamports: selection.maximumInputLamports,
          maximumFeeAndRentLamports: selection.maximumFeeAndRentLamports,
        },
      ],
    },
    reviewSha256: 'c'.repeat(64),
    requiredAcknowledgement: COUNTER_BUY_METADATA_ACK,
    scope: 'read-only-accounting-only',
    ...metadata,
    limitations:
      'Synthetic accounting metadata. No trading authority or reservation. Saved rows are permanent; Counter checks are optimistic.',
  };
  const saved: CounterBudgetSaved = {
    format: 'owned-counter-budget-saved-v1',
    recordKind: 'immutable-budget-terms-only',
    reviewProvenanceStored: false,
    disposition: 'created-or-recovered-terms',
    originalId: selection.budgetId,
    budget: {
      terms: structuredClone(review.terms),
      inputMint: 'So11111111111111111111111111111111111111112',
      state: 'open',
      revision: 0,
      createdAt: new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(),
      heldInputLamports: '0',
      heldFeeAndRentLamports: '0',
      remainingInputLamports: selection.maximumInputLamports,
      remainingFeeAndRentLamports: selection.maximumFeeAndRentLamports,
      uncertainClaims: 0,
      ...authority,
    },
    currentContext: 'rechecked-advisory-only',
    scope: 'historical-accounting-record',
    ...metadata,
    limitations: review.limitations,
  };
  const request: CounterBudgetPreviewRequest = {
    ...f.request,
    budgetId: selection.budgetId,
    budgetRevision: 0,
    strategyId: f.plan.id,
  };
  const { grossSettlementReviewed: _gross, ...basePreview } = f.preview;
  const preview: CounterBudgetPreview = {
    ...basePreview,
    ...request,
    format: 'owned-counter-buy-budget-preview-v1',
    scope: 'read-only-nonreservable-preview',
    inputMint: saved.budget.inputMint,
    observedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 30000).toISOString(),
    sourceRecheckedAt: new Date(now).toISOString(),
    sourceValidUntil: new Date(now + 60000).toISOString(),
    heldInputLamports: '0',
    heldFeeAndRentLamports: '0',
    remainingInputLamports: selection.maximumInputLamports,
    remainingFeeAndRentLamports: selection.maximumFeeAndRentLamports,
    ownerContext: 'rechecked-advisory-only',
    budgetContextRechecked: true,
    ownerContextVerified: false,
    claimStorageEligibilityVerified: false,
    accountingCapacityReserved: false,
    crossBudgetReplayProtectionVerified: false,
    proposalUseReservationVerified: false,
    ...authority,
  };
  return {
    ...f,
    selection,
    review,
    saved,
    budgetRequest: request,
    budgetPreview: preview,
  };
}
