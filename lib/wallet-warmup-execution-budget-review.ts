import { z } from 'zod';
import { readWarmupExecutionSource } from './wallet-warmup-execution-source';
import { inspectWarmupExecutionAssets } from './wallet-warmup-execution-assets';
import {
  WARMUP_EXECUTION_POLICY,
  warmupExecutionId as uuid,
  warmupExecutionHash as hash,
  warmupExecutionUnits as units,
  warmupExecutionTimestamp as iso,
} from './wallet-warmup-execution-manifest';
import { bindWarmupExecutionTerms } from './wallet-warmup-execution-terms';
import { walletWarmupSessionDigest as digest } from './wallet-warmup-session-digest';
import { canonicalPumpHolderJson as canonical } from './pump-holder-review';
import { reviewWalletWarmupExecutionPacing } from './wallet-warmup-execution-pacing';
import { SWAP_WRAPPED_SOL } from './swap-token-program-evidence';

export const WARMUP_EXECUTION_BUDGET_RENT_POLICY =
  'one-target-and-one-wsol-token-account-per-action-no-refund-credit-v1';

const positive = units.refine((v) => BigInt(v) > 0n);
const request = z
  .object({
    reviewId: uuid,
    reviewSha256: hash,
    rootId: uuid,
    consentId: uuid,
    sessionExpiresAt: iso,
    // Proposed new limits, not estimates, historical remaining funds or consent.
    feeRentLimits: z
      .array(
        z
          .object({
            actionId: z.string().min(1).max(256),
            maximumLamports: positive,
          })
          .strict(),
      )
      .min(1)
      .max(4800),
  })
  .strict();

export class WarmupExecutionBudgetReviewError extends Error {
  constructor() {
    super(
      'Fresh warmup spending review is unavailable or changed. Request a fresh review.',
    );
    this.name = 'WarmupExecutionBudgetReviewError';
  }
}
const fail = (): never => {
  throw new WarmupExecutionBudgetReviewError();
};

/** Server-internal proposal, never admission. Owner comes from authentication.
 * New per-action gross fee/rent ceilings require separate human review later.
 * Historical net rent, proceeds and refunds never enlarge these ceilings.
 * No caller-supplied evidence, provider metadata, verified flag or consent. */
export async function reviewWarmupExecutionBudget(
  db: D1Database,
  owner: string,
  value: unknown,
  signal: AbortSignal,
  dependencies: { fetcher?: typeof fetch; now?: () => number } = {},
) {
  try {
    signal.throwIfAborted();
    // Detach every proposed identity/limit before asynchronous work.
    const input = request.parse(value);
    if (new Set([input.reviewId, input.rootId, input.consentId]).size !== 3)
      fail();
    const now = dependencies.now ?? Date.now;
    const selection = {
      reviewId: input.reviewId,
      reviewSha256: input.reviewSha256,
    };
    const source = await readWarmupExecutionSource(
      db,
      owner,
      selection,
      signal,
      now,
    );
    const review = source.retainedReview;
    const planned = review.document.actions;
    if (
      input.feeRentLimits.length !== planned.length ||
      input.feeRentLimits.some(
        (limit, index) => limit.actionId !== planned[index].id,
      )
    )
      fail();
    const original = JSON.parse(source.sourceDocument) as {
      buys: { id: string; document: string }[];
    };
    // Current asset facts are obtained here, never accepted as request evidence.
    const asset = await inspectWarmupExecutionAssets(
      db,
      owner,
      selection,
      signal,
      dependencies,
    );
    if (asset.evidence.sourceSnapshotSha256 !== source.sourceSnapshotSha256)
      fail();
    const facts = new Map(
      asset.evidence.tokenAccountRents.map((m) => [m.address, m]),
    );
    const savedLots = [];
    const actions = [];
    const rentAllowances = [];
    const wrapped = facts.get(SWAP_WRAPPED_SOL);
    if (!wrapped) return fail();
    const wallets = new Map<
      string,
      {
        wallet: string;
        revision: number;
        maximumBuyLamports: string;
        maximumFeeRentLamports: string;
      }
    >();
    for (const [index, action] of planned.entries()) {
      const fact = facts.get(action.mint);
      if (!fact) return fail();
      const wallet = wallets.get(action.wallet) ?? {
        wallet: action.wallet,
        revision: action.walletRevision,
        maximumBuyLamports: '0',
        maximumFeeRentLamports: '0',
      };
      if (wallet.revision !== action.walletRevision) return fail();
      const fee = input.feeRentLimits[index].maximumLamports;
      // Conservative independently reviewed allowance, not an assertion that
      // accounts are missing or a complete route/setup/network-fee estimate.
      const tokenAccountRent =
        BigInt(fact.minimumRentLamports) + BigInt(wrapped.minimumRentLamports);
      if (BigInt(fee) < tokenAccountRent) return fail();
      rentAllowances.push({
        actionId: action.id,
        targetTokenAccountRentLamports: fact.minimumRentLamports,
        wrappedSolTokenAccountRentLamports: wrapped.minimumRentLamports,
        conservativeTokenAccountRentAllowanceLamports:
          tokenAccountRent.toString(),
      });
      wallet.maximumFeeRentLamports = (
        BigInt(wallet.maximumFeeRentLamports) + BigInt(fee)
      ).toString();
      const base = {
        id: action.id,
        wallet: action.wallet,
        mint: action.mint,
        tokenProgram: fact.program,
        decimals: fact.decimals,
        scheduledAt: action.scheduledAt,
        maximumFeeRentLamports: fee,
      };
      if (action.side === 'Buy') {
        wallet.maximumBuyLamports = (
          BigInt(wallet.maximumBuyLamports) + BigInt(action.inputLamports)
        ).toString();
        actions.push({
          ...base,
          side: 'Buy' as const,
          inputLamports: action.inputLamports,
        });
      } else if (action.source.kind === 'session-buy') {
        actions.push({
          ...base,
          side: 'Sell' as const,
          source: {
            kind: 'action-buy' as const,
            actionId: action.source.actionId,
          },
        });
      } else {
        const receiptId = action.source.buyReceiptId;
        const receipt = original.buys.find((row) => row.id === receiptId);
        if (!receipt) return fail();
        savedLots.push({
          receiptId: action.source.buyReceiptId,
          wallet: action.wallet,
          mint: action.mint,
          tokenProgram: fact.program,
          decimals: fact.decimals,
          remainingRaw: action.source.remainingRaw,
          sourceSha256: await digest(canonical(receipt)),
        });
        actions.push({
          ...base,
          side: 'Sell' as const,
          source: {
            kind: 'saved-buy' as const,
            receiptId: action.source.buyReceiptId,
          },
        });
      }
      wallets.set(action.wallet, wallet);
    }
    const walletLimits = [...wallets.values()];
    const budget = {
      format: 'wallet-warmup-fresh-execution-budget-v1' as const,
      policy: 'independent-new-fee-rent-limits-no-replenishment-v1' as const,
      ownerId: owner,
      rootId: input.rootId,
      consentId: input.consentId,
      reviewId: review.id,
      reviewSha256: review.reviewSha256,
      sourceSnapshotSha256: source.sourceSnapshotSha256,
      assetEvidenceSha256: asset.evidenceSha256,
      feeRentLimits: input.feeRentLimits,
      tokenAccountRentPolicy: WARMUP_EXECUTION_BUDGET_RENT_POLICY,
      rentAllowances,
      proposalExpiresAt: asset.evidence.expiresAt,
      proposedSessionExpiresAt: input.sessionExpiresAt,
      identitiesMeaning:
        'Proposed root and consent IDs; no publication or uniqueness admission.' as const,
      wallets: walletLimits.map((wallet) => {
        const prior = review.document.wallets.find(
          (row) => row.wallet === wallet.wallet,
        );
        if (
          !prior ||
          prior.walletRevision !== wallet.revision ||
          prior.buySpendLamports !== wallet.maximumBuyLamports
        )
          return fail();
        return {
          ...wallet,
          maximumNewNativeDebitLamports: (
            BigInt(wallet.maximumBuyLamports) +
            BigInt(wallet.maximumFeeRentLamports)
          ).toString(),
          historicalNetworkFeesLamports: prior.recordedNetworkFeesLamports,
          historicalNetRentChangeLamports: prior.recordedRentChangeLamports,
          historicalGrossFeeRent: 'not-established' as const,
          savedPlanFeeReserveLamports: prior.feeReserveLamports,
          savedReviewNetRemainingReserveLamports:
            prior.remainingFeeReserveLamports,
          savedReviewMaximumNativeSpendLamports:
            prior.maximumNativeSpendLamports,
          differenceFromSavedReviewNativeLimitLamports: (
            BigInt(wallet.maximumBuyLamports) +
            BigInt(wallet.maximumFeeRentLamports) -
            BigInt(prior.maximumNativeSpendLamports)
          ).toString(),
        };
      }),
      feeRentMeaning:
        'New gross limits, not an estimate or a remaining historical reserve.' as const,
      refundsAndProceedsReplenishLimits: false as const,
      fundingSufficiencyVerified: false as const,
      feeAndSetupCoverageVerified: false as const,
      humanApprovalVerified: false as const,
      signingAllowed: false as const,
      executionAllowed: false as const,
      automaticExecutionAllowed: false as const,
    };
    const budgetSha256 = await digest(canonical(budget));
    const verifierEvidence = {
      format: 'wallet-warmup-execution-review-evidence-v1' as const,
      assets: asset.evidence,
      assetEvidenceSha256: asset.evidenceSha256,
      freshBudget: structuredClone(budget),
      freshBudgetSha256: budgetSha256,
    };
    const verifierEvidenceSha256 = await digest(canonical(verifierEvidence));
    const bound = await bindWarmupExecutionTerms({
      format: 'wallet-warmup-execution-terms-v1',
      intent: {
        format: 'wallet-warmup-execution-intent-v1',
        id: input.rootId,
        ownerId: owner,
        consentId: input.consentId,
        policy: WARMUP_EXECUTION_POLICY,
        planId: review.planId,
        planRevision: review.planRevision,
        sourceSha256: source.sourceSnapshotSha256,
        createdAt: review.reviewedAt,
        expiresAt: input.sessionExpiresAt,
        wallets: walletLimits,
        savedLots,
        actions,
      },
      review: {
        id: review.id,
        sha256: review.reviewSha256,
        reviewedAt: review.reviewedAt,
        reviewExpiresAt: review.reviewExpiresAt,
      },
      verifierEvidenceSha256,
    });
    const current = await readWarmupExecutionSource(
      db,
      owner,
      selection,
      signal,
      now,
    );
    const checked = now();
    if (
      current.sourceSnapshotSha256 !== source.sourceSnapshotSha256 ||
      !Number.isSafeInteger(checked) ||
      checked < Date.parse(asset.evidence.checkedAt) ||
      checked >= Date.parse(asset.evidence.expiresAt) ||
      !reviewWalletWarmupExecutionPacing(
        {
          actions: actions.map(({ id, scheduledAt }) => ({ id, scheduledAt })),
          sessionExpiresAt: input.sessionExpiresAt,
        },
        checked,
      ).fitsMinimumPacing
    )
      return fail();
    signal.throwIfAborted();
    return {
      ...bound,
      budget,
      budgetSha256,
      verifierEvidence,
      verifierEvidenceSha256,
      status: 'Separate spending approval required' as const,
      scope: 'owned-source-and-fresh-limit-proposal-only' as const,
      signingAllowed: false as const,
      executionAllowed: false as const,
      automaticExecutionAllowed: false as const,
    };
  } catch {
    signal.throwIfAborted();
    return fail();
  }
}
