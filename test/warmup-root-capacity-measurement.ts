import { warmupPublicAssetReviewFixture } from './warmup-public-asset-review-fixture';
import { executionCapacityManifest } from './warmup-execution-capacity-fixture';
import { executionId, executionHash } from './warmup-execution-ledger-fixture';
import { readWarmupExecutionSource } from '../lib/wallet-warmup-execution-source';
import { reviewWarmupExecutionBudget } from '../lib/wallet-warmup-execution-budget-review';
import {
  bindWarmupExecutionRoot,
  bindWarmupExecutionTerms,
  WARMUP_EXECUTION_ACKNOWLEDGEMENT,
} from '../lib/wallet-warmup-execution-terms';
import { SOLANA_MAINNET_GENESIS } from '../lib/wallet-balances';
import {
  SWAP_TOKEN,
  SWAP_TOKEN_2022,
  SWAP_WRAPPED_SOL,
} from '../lib/swap-token-program-evidence';
import { pairRentAccount } from './pair-rent-fixture';
import { canonicalPumpHolderJson as canonical } from '../lib/pump-holder-review';
import { walletWarmupSessionDigest as digest } from '../lib/wallet-warmup-session-digest';
import { env } from '../lib/server-env';
import { WARMUP_SESSION_ROW_BYTES } from '../lib/wallet-warmup-session-digest';
import { address } from '@solana/kit';
import { getExtensionEncoder } from '@solana-program/token-2022';

/** Actual owned-source service path with synthetic accounts, no key or network.
 * The dense 60s schedule is not stretched: this separate fixture chooses3600s
 * explicitly so all20wallets fit the unchanged serial30s policy. */
export async function maximumPlanRootMeasurement() {
  const f = await warmupPublicAssetReviewFixture('maximum-plan');
  const prior = env.SOLANA_INDEXER_RPC_URL;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw Error('Unscoped capacity-fixture network request refused');
  };
  env.SOLANA_INDEXER_RPC_URL = 'https://capacity.invalid/';
  try {
    const source = await readWarmupExecutionSource(
      f.db,
      f.owner,
      f.input,
      new AbortController().signal,
      f.clock,
    );
    let calls = 0,
      reads = 0;
    const fetcher: typeof fetch = async (_url, init) => {
      calls++;
      const request = JSON.parse(init!.body as string);
      let result: unknown;
      if (request.method === 'getGenesisHash') result = SOLANA_MAINNET_GENESIS;
      else if (request.method === 'getSlot') result = 100;
      else if (request.method === 'getMultipleAccounts') {
        reads++;
        const slot = 100 + reads;
        result = {
          context: { slot },
          value: request.params[0].map((a: string) => {
            if (a === 'SysvarRent111111111111111111111111111111111')
              return pairRentAccount(3480n, 2);
            const clock = a === 'SysvarC1ock11111111111111111111111111111111';
            const b = new Uint8Array(
                clock ? 40 : a === SWAP_WRAPPED_SOL ? 82 : 16384,
              ),
              v = new DataView(b.buffer);
            if (clock) {
              v.setBigUint64(0, BigInt(slot), true);
              v.setBigInt64(32, BigInt(Math.floor(f.clock() / 1000)), true);
            } else {
              b[44] = a === SWAP_WRAPPED_SOL ? 9 : 6;
              b[45] = 1;
              if (a !== SWAP_WRAPPED_SOL) {
                b[165] = 1;
                b.set(
                  getExtensionEncoder().encode({
                    __kind: 'TokenMetadata',
                    updateAuthority: null,
                    mint: address(a),
                    name: 'x'.repeat(15000),
                    symbol: 'CAP',
                    uri: '',
                    additionalMetadata: new Map(),
                  }),
                  166,
                );
              }
            }
            return {
              owner: clock
                ? 'Sysvar1111111111111111111111111111111111111'
                : a === SWAP_WRAPPED_SOL
                  ? SWAP_TOKEN
                  : SWAP_TOKEN_2022,
              executable: false,
              data: [btoa(String.fromCharCode(...b)), 'base64'],
            };
          }),
        };
      } else throw Error('Unexpected capacity fixture method');
      return Response.json({ jsonrpc: '2.0', id: 1, result });
    };
    const proposal = await reviewWarmupExecutionBudget(
      f.db,
      f.owner,
      {
        ...f.input,
        rootId: crypto.randomUUID(),
        consentId: crypto.randomUUID(),
        sessionExpiresAt: new Date(
          Date.parse(
            source.retainedReview.document.actions.at(-1)!.scheduledAt,
          ) + 300000,
        ).toISOString(),
        feeRentLimits: source.retainedReview.document.actions.map((a) => ({
          actionId: a.id,
          maximumLamports: '5000000',
        })),
      },
      new AbortController().signal,
      { fetcher, now: f.clock },
    );
    const approval = {
      format: 'wallet-warmup-execution-approval-v1' as const,
      id: proposal.terms.intent.consentId,
      rootId: proposal.terms.intent.id,
      ownerId: f.owner,
      reviewId: source.retainedReview.id,
      termsSha256: proposal.termsSha256,
      approvedAt: new Date(f.clock() + 1).toISOString(),
      sessionExpiresAt: proposal.terms.intent.expiresAt,
      acknowledgement: WARMUP_EXECUTION_ACKNOWLEDGEMENT,
    };
    const bound = await bindWarmupExecutionRoot(proposal.terms, approval);
    const envelope = {
      format: 'test-only-complete-warmup-root-capacity-v1',
      root: bound.root,
      approval,
      verifierEvidence: proposal.verifierEvidence,
      source: {
        reviewDocument: source.reviewDocument,
        sourceDocument: source.sourceDocument,
        sourceSha256: source.sourceSha256,
        sourceSnapshotSha256: source.sourceSnapshotSha256,
      },
    };
    return {
      envelope,
      bound,
      proposal,
      calls,
      source,
      scope: 'maximum-supported-plan-synthetic-source-and-provider' as const,
    };
  } finally {
    globalThis.fetch = originalFetch;
    f.dispose();
    if (prior === undefined) delete env.SOLANA_INDEXER_RPC_URL;
    else env.SOLANA_INDEXER_RPC_URL = prior;
  }
}

/** Model-schema size stress only. It is deliberately NOT an owned source or
 * economically qualified proposal: long IDs/owner bytes exceed source rules.
 * Extra1.5MiB raw parent bytes become about3MiB after JSON string escaping.
 * This is a byte placeholder, not an admitted source document. */
export async function modelCeilingRootMeasurement(
  base: Awaited<ReturnType<typeof maximumPlanRootMeasurement>>,
  ids: 'source-like' | 'escaped' | 'unicode' | 'surrogate',
  kind: 'saved' | 'mixed' | 'paired' = 'mixed',
) {
  const manifest = executionCapacityManifest(kind, ids);
  const { format: _format, consentSha256: _consent, ...body } = manifest;
  const freshBudget = {
    ...structuredClone(base.proposal.budget),
    ownerId: body.ownerId,
    rootId: body.id,
    consentId: body.consentId,
    feeRentLimits: body.actions.map((a) => ({
      actionId: a.id,
      maximumLamports: a.maximumFeeRentLamports,
    })),
    rentAllowances: body.actions.map((a) => ({
      actionId: a.id,
      targetTokenAccountRentLamports: '2039280',
      wrappedSolTokenAccountRentLamports: '2039280',
      conservativeTokenAccountRentAllowanceLamports: '4078560',
    })),
    wallets: body.wallets.map((w) => ({
      ...w,
      maximumNewNativeDebitLamports: (
        BigInt(w.maximumBuyLamports) + BigInt(w.maximumFeeRentLamports)
      ).toString(),
      historicalNetworkFeesLamports: '18446744073709551615',
      historicalNetRentChangeLamports: '-18446744073709551615',
      historicalGrossFeeRent: 'not-established',
      savedPlanFeeReserveLamports: '18446744073709551615',
      savedReviewNetRemainingReserveLamports: '18446744073709551615',
      savedReviewMaximumNativeSpendLamports: '18446744073709551615',
      differenceFromSavedReviewNativeLimitLamports: '-18446744073709551615',
    })),
  };
  const verifierEvidence = {
    ...structuredClone(base.proposal.verifierEvidence),
    freshBudget,
    freshBudgetSha256: await digest(canonical(freshBudget)),
  };
  const terms = {
    format: 'wallet-warmup-execution-terms-v1' as const,
    intent: { ...body, format: 'wallet-warmup-execution-intent-v1' as const },
    review: {
      id: executionId(50),
      sha256: executionHash(50),
      reviewedAt: body.createdAt,
      reviewExpiresAt: new Date(
        Date.parse(body.createdAt) + 60000,
      ).toISOString(),
    },
    verifierEvidenceSha256: await digest(canonical(verifierEvidence)),
  };
  const approval = {
    format: 'wallet-warmup-execution-approval-v1' as const,
    id: body.consentId,
    rootId: body.id,
    ownerId: body.ownerId,
    reviewId: terms.review.id,
    termsSha256: (await bindWarmupExecutionTerms(terms)).termsSha256,
    approvedAt: new Date(Date.parse(body.createdAt) + 1000).toISOString(),
    sessionExpiresAt: body.expiresAt,
    acknowledgement: WARMUP_EXECUTION_ACKNOWLEDGEMENT,
  };
  const bound = await bindWarmupExecutionRoot(terms, approval);
  return {
    envelope: {
      format: 'test-only-model-ceiling-capacity-v1',
      root: bound.root,
      approval,
      verifierEvidence,
      sourceCapacityPlaceholder: '\\'.repeat(WARMUP_SESSION_ROW_BYTES),
    },
    bound,
    scope: 'model-schema-and-parent-byte-stress-not-source-admission' as const,
  };
}
