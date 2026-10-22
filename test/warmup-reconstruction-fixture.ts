import { warmupExecutionSourceFixture } from './warmup-execution-source-fixture';
import { warmupPublicAssetReviewFixture } from './warmup-public-asset-review-fixture';
import { readWarmupExecutionSource } from '../lib/wallet-warmup-execution-source';
import { reviewWarmupExecutionBudget } from '../lib/wallet-warmup-execution-budget-review';
import {
  bindWarmupExecutionRoot,
  WARMUP_EXECUTION_ACKNOWLEDGEMENT,
} from '../lib/wallet-warmup-execution-terms';
import { SOLANA_MAINNET_GENESIS } from '../lib/wallet-balances';
import {
  SWAP_TOKEN,
  SWAP_TOKEN_2022,
  SWAP_WRAPPED_SOL,
} from '../lib/swap-token-program-evidence';
import { pairRentAccount } from './pair-rent-fixture';
import { env } from '../lib/server-env';

/** Synthetic owned rows and account responses only, no real key/provider/human
 * approval. Caller disposes the fixture. Maximum mode has20wallets/10mints. */
export async function warmupReconstructionFixture(
  history: 'none' | 'buy' | 'sold' = 'none',
  maximum = false,
) {
  const actual = maximum ? null : await warmupExecutionSourceFixture(history);
  const sourceFixture =
    actual ?? (await warmupPublicAssetReviewFixture('maximum-plan'));
  const prior = env.SOLANA_INDEXER_RPC_URL;
  env.SOLANA_INDEXER_RPC_URL = 'https://reconstruction.invalid/';
  const dispose = () => {
    if (actual) actual.sqlite.close();
    else
      (
        sourceFixture as Awaited<
          ReturnType<typeof warmupPublicAssetReviewFixture>
        >
      ).dispose();
  };
  try {
    const f = sourceFixture;
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
      const req = JSON.parse(init!.body as string);
      let result: unknown;
      if (req.method === 'getGenesisHash') result = SOLANA_MAINNET_GENESIS;
      else if (req.method === 'getSlot') result = 100;
      else if (req.method === 'getMultipleAccounts') {
        reads++;
        const slot = 100 + reads;
        result = {
          context: { slot },
          value: req.params[0].map((a: string) => {
            if (a === 'SysvarRent111111111111111111111111111111111')
              return pairRentAccount(3480n, 2);
            const clock = a === 'SysvarC1ock11111111111111111111111111111111',
              b = new Uint8Array(clock ? 40 : 82),
              v = new DataView(b.buffer);
            if (clock) {
              v.setBigUint64(0, BigInt(slot), true);
              v.setBigInt64(32, BigInt(Math.floor(f.clock() / 1000)), true);
            } else {
              b[44] = a === SWAP_WRAPPED_SOL ? 9 : 6;
              b[45] = 1;
            }
            return {
              owner: clock
                ? 'Sysvar1111111111111111111111111111111111111'
                : maximum && a !== SWAP_WRAPPED_SOL
                  ? SWAP_TOKEN_2022
                  : SWAP_TOKEN,
              executable: false,
              data: [btoa(String.fromCharCode(...b)), 'base64'],
            };
          }),
        };
      } else throw Error('Unexpected synthetic reconstruction method');
      return Response.json({ jsonrpc: '2.0', id: 1, result });
    };
    const proposed = await reviewWarmupExecutionBudget(
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
      id: proposed.terms.intent.consentId,
      rootId: proposed.terms.intent.id,
      ownerId: f.owner,
      reviewId: source.retainedReview.id,
      termsSha256: proposed.termsSha256,
      approvedAt: new Date(f.clock() + 1).toISOString(),
      sessionExpiresAt: proposed.terms.intent.expiresAt,
      acknowledgement: WARMUP_EXECUTION_ACKNOWLEDGEMENT,
    };
    const bound = await bindWarmupExecutionRoot(proposed.terms, approval);
    return {
      db: f.db,
      owner: f.owner,
      input: f.input,
      clock: f.clock,
      source,
      proposed,
      actual,
      dispose,
      record: {
        root: bound.root,
        approval: bound.approval,
        verifierEvidence: proposed.verifierEvidence,
      },
      expected: {
        id: bound.root.terms.intent.id,
        consentId: bound.approval.id,
        reviewId: bound.approval.reviewId,
        rootSha256: bound.rootSha256,
      },
      providerCalls: () => calls,
    };
  } catch (e) {
    dispose();
    throw e;
  } finally {
    if (prior === undefined) delete env.SOLANA_INDEXER_RPC_URL;
    else env.SOLANA_INDEXER_RPC_URL = prior;
  }
}
