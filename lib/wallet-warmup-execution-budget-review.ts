import { z } from 'zod';
import {
  readWarmupExecutionSource,
  readRetainedWarmupExecutionSource,
} from './wallet-warmup-execution-source';
import { inspectWarmupExecutionAssets } from './wallet-warmup-execution-assets';
import {
  WARMUP_EXECUTION_POLICY,
  warmupExecutionId as uuid,
  warmupExecutionHash as hash,
  warmupExecutionUnits as units,
  warmupExecutionTimestamp as iso,
} from './wallet-warmup-execution-manifest';
import {
  bindWarmupExecutionTerms,
  readWarmupExecutionRootBinding,
} from './wallet-warmup-execution-terms';
import {
  warmupExecutionAssetEvidenceSchema,
  replayWarmupExecutionAssets,
} from './wallet-warmup-execution-assets-replay';
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

// Historical totals can sum multiple25-digit receipt values. They are not u64 spend authority.
const originalUnits = z.string().regex(/^(0|[1-9]\d{0,28})$/);
const signedOriginal = z.string().regex(/^(0|-?[1-9]\d{0,28})$/);
const actionKey = z.string().min(1).max(256);
const freshBudgetSchema = z
  .object({
    format: z.literal('wallet-warmup-fresh-execution-budget-v1'),
    policy: z.literal('independent-new-fee-rent-limits-no-replenishment-v1'),
    ownerId: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/),
    rootId: uuid,
    consentId: uuid,
    reviewId: uuid,
    reviewSha256: hash,
    sourceSnapshotSha256: hash,
    assetEvidenceSha256: hash,
    feeRentLimits: request.shape.feeRentLimits,
    tokenAccountRentPolicy: z.literal(WARMUP_EXECUTION_BUDGET_RENT_POLICY),
    rentAllowances: z
      .array(
        z
          .object({
            actionId: actionKey,
            targetTokenAccountRentLamports: positive,
            wrappedSolTokenAccountRentLamports: positive,
            conservativeTokenAccountRentAllowanceLamports: positive,
          })
          .strict(),
      )
      .min(1)
      .max(4800),
    proposalExpiresAt: iso,
    proposedSessionExpiresAt: iso,
    identitiesMeaning: z.literal(
      'Proposed root and consent IDs; no publication or uniqueness admission.',
    ),
    wallets: z
      .array(
        z
          .object({
            wallet: z.string().min(32).max(44),
            revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
            maximumBuyLamports: units,
            maximumFeeRentLamports: units,
            maximumNewNativeDebitLamports: units,
            historicalNetworkFeesLamports: originalUnits,
            historicalNetRentChangeLamports: signedOriginal,
            historicalGrossFeeRent: z.literal('not-established'),
            savedPlanFeeReserveLamports: originalUnits,
            savedReviewNetRemainingReserveLamports: originalUnits,
            savedReviewMaximumNativeSpendLamports: originalUnits,
            differenceFromSavedReviewNativeLimitLamports: signedOriginal,
          })
          .strict(),
      )
      .min(1)
      .max(20),
    feeRentMeaning: z.literal(
      'New gross limits, not an estimate or a remaining historical reserve.',
    ),
    refundsAndProceedsReplenishLimits: z.literal(false),
    fundingSufficiencyVerified: z.literal(false),
    feeAndSetupCoverageVerified: z.literal(false),
    humanApprovalVerified: z.literal(false),
    signingAllowed: z.literal(false),
    executionAllowed: z.literal(false),
    automaticExecutionAllowed: z.literal(false),
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
    const derived = await deriveBudgetTerms(source, asset, input, signal);
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
          actions: derived.terms.intent.actions.map(({ id, scheduledAt }) => ({
            id,
            scheduledAt,
          })),
          sessionExpiresAt: input.sessionExpiresAt,
        },
        checked,
      ).fitsMinimumPacing
    )
      return fail();
    signal.throwIfAborted();
    return {
      ...derived,
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

type BudgetSource = Pick<
  Awaited<ReturnType<typeof readWarmupExecutionSource>>,
  'ownerId' | 'retainedReview' | 'sourceDocument' | 'sourceSnapshotSha256'
>;
type BudgetAsset = Awaited<ReturnType<typeof inspectWarmupExecutionAssets>>;
/** Deterministic reconstruction, not admission. Only internal owned readers
 * and decoded assets reach this helper; currentness is checked by fresh caller. */
async function deriveBudgetTerms(
  source: BudgetSource,
  asset: BudgetAsset,
  input: z.infer<typeof request>,
  signal: AbortSignal,
) {
  const owner = source.ownerId,
    review = source.retainedReview,
    planned = review.document.actions;
  if (
    new Set([input.rootId, input.consentId, input.reviewId]).size !== 3 ||
    input.reviewId !== review.id ||
    input.reviewSha256 !== review.reviewSha256 ||
    asset.evidence.sourceSnapshotSha256 !== source.sourceSnapshotSha256 ||
    input.feeRentLimits.length !== planned.length ||
    input.feeRentLimits.some((limit, i) => limit.actionId !== planned[i].id)
  )
    return fail();
  const original = JSON.parse(source.sourceDocument) as {
    buys: { id: string; document: string }[];
  };
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
      const recorded = JSON.parse(receipt.document) as {
        tokenProgram?: unknown;
        decimals?: unknown;
        mint?: unknown;
        wallet?: unknown;
      };
      if (
        recorded.tokenProgram !== fact.program ||
        recorded.decimals !== fact.decimals ||
        recorded.decimals !== action.source.decimals ||
        recorded.mint !== action.mint ||
        recorded.wallet !== action.wallet
      )
        return fail();
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
  const budget = freshBudgetSchema.parse({
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
        savedReviewMaximumNativeSpendLamports: prior.maximumNativeSpendLamports,
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
  });
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

  signal.throwIfAborted();
  return {
    ...bound,
    budget,
    budgetSha256,
    verifierEvidence,
    verifierEvidenceSha256,
  };
}

const rootRecordSchema = z
  .object({
    root: z.unknown(),
    approval: z.unknown(),
    verifierEvidence: z
      .object({
        format: z.literal('wallet-warmup-execution-review-evidence-v1'),
        assets: warmupExecutionAssetEvidenceSchema,
        assetEvidenceSha256: hash,
        freshBudget: freshBudgetSchema,
        freshBudgetSha256: hash,
      })
      .strict(),
  })
  .strict();
const rootExpected = z
  .object({ id: uuid, consentId: uuid, reviewId: uuid, rootSha256: hash })
  .strict();
export class WarmupExecutionReconstructionError extends Error {
  constructor() {
    super('Retained execution root differs from its owned original review.');
    this.name = 'WarmupExecutionReconstructionError';
  }
}
/** Historical source/economics reconstruction only. Expected root identity/hash
 * must come from admitted owned storage, NEVER from this incoming record. Owner
 * must be authenticated independently. No approval publication, human proof,
 * currentness, provider read, clock renewal or execution authority exists here. */
export async function reconstructWarmupExecutionRoot(
  db: D1Database,
  owner: string,
  value: unknown,
  rawExpected: unknown,
  signal: AbortSignal,
) {
  try {
    signal.throwIfAborted();
    const input = rootRecordSchema.parse(value),
      expected = rootExpected.parse(rawExpected);
    // The binding reader snapshots root and approval synchronously before its
    // first await; the strict evidence/budget parser already detached every leaf.
    const bound = await readWarmupExecutionRootBinding(
      input.root,
      input.approval,
      { ...expected, ownerId: owner },
    );
    signal.throwIfAborted();
    const source = await readRetainedWarmupExecutionSource(
      db,
      owner,
      {
        reviewId: expected.reviewId,
        reviewSha256: bound.root.terms.review.sha256,
      },
      signal,
    );
    if (
      (await digest(canonical(input.verifierEvidence))) !==
      bound.root.terms.verifierEvidenceSha256
    )
      return fail();
    signal.throwIfAborted();
    // Independent admitted root hash -> verifier hash -> original packet
    // fields. These are pinned recorded values, not a current configured host
    // or fresh RPC-provenance assertion. Never move this alias before the pin.
    const pinnedVerifier = input.verifierEvidence;
    const asset = await replayWarmupExecutionAssets(
      {
        evidence: pinnedVerifier.assets,
        evidenceSha256: pinnedVerifier.assetEvidenceSha256,
      },
      {
        ownerId: owner,
        reviewId: source.retainedReview.id,
        reviewSha256: source.retainedReview.reviewSha256,
        sourceSnapshotSha256: source.sourceSnapshotSha256,
        evidenceSha256: pinnedVerifier.assetEvidenceSha256,
        provider: pinnedVerifier.assets.provider,
        mints: [
          ...new Set(source.retainedReview.document.actions.map((a) => a.mint)),
        ],
        reviewedAt: source.retainedReview.reviewedAt,
        reviewExpiresAt: source.retainedReview.reviewExpiresAt,
        expiresAt: pinnedVerifier.assets.expiresAt,
      },
      signal,
    );
    const approved = Date.parse(bound.approval.approvedAt);
    // Necessary historical bounds only. Future approval admission must also
    // enforce its stored proposal-publication time and authenticated human act.
    if (
      approved < Date.parse(asset.evidence.checkedAt) ||
      approved >= Date.parse(asset.evidence.expiresAt)
    )
      return fail();
    const intent = bound.root.terms.intent;
    const proposed = request.parse({
      reviewId: source.retainedReview.id,
      reviewSha256: source.retainedReview.reviewSha256,
      rootId: intent.id,
      consentId: intent.consentId,
      sessionExpiresAt: intent.expiresAt,
      feeRentLimits: intent.actions.map((a) => ({
        actionId: a.id,
        maximumLamports: a.maximumFeeRentLamports,
      })),
    });
    const rebuilt = await deriveBudgetTerms(source, asset, proposed, signal);
    if (
      canonical(rebuilt.terms) !== canonical(bound.root.terms) ||
      rebuilt.termsSha256 !== bound.root.termsSha256 ||
      canonical(rebuilt.verifierEvidence) !==
        canonical(input.verifierEvidence) ||
      rebuilt.verifierEvidenceSha256 !== bound.root.terms.verifierEvidenceSha256
    )
      return fail();
    const after = await readRetainedWarmupExecutionSource(
      db,
      owner,
      {
        reviewId: expected.reviewId,
        reviewSha256: source.retainedReview.reviewSha256,
      },
      signal,
    );
    if (after.sourceSnapshotSha256 !== source.sourceSnapshotSha256)
      return fail();
    signal.throwIfAborted();
    return {
      ...bound,
      budget: rebuilt.budget,
      budgetSha256: rebuilt.budgetSha256,
      verifierEvidence: rebuilt.verifierEvidence,
      verifierEvidenceSha256: rebuilt.verifierEvidenceSha256,
      sourceSnapshotSha256: source.sourceSnapshotSha256,
      scope: 'historical-owned-parent-reconstruction-only' as const,
      humanApprovalVerified: false as const,
      currentSourceVerified: false as const,
      networkObservationReverified: false as const,
      signingAllowed: false as const,
      executionAllowed: false as const,
      automaticExecutionAllowed: false as const,
    };
  } catch {
    signal.throwIfAborted();
    throw new WarmupExecutionReconstructionError();
  }
}
