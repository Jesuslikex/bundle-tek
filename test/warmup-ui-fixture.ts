// Display/workflow fixtures only. Packet/signature markers are not valid transactions.
import type { SavedWarmup } from '../lib/wallet-warmup-storage';
import { buildWarmupPlan } from '../lib/wallet-warmup';
import bs58 from 'bs58';
import { warmupLotPerformance } from '../lib/warmup-lot-performance';
import type { SolanaSwapPreparation } from '../lib/warmup-swap-quote';
import type { WarmupSigningReview } from '../lib/warmup-signing';
import type { SavedWarmupBuyReceipt } from '../lib/warmup-buy-receipt';
import { warmupBuyLink } from '../lib/warmup-buy-link';
import {
  warmupCycleProgress,
  type ProgressBuy,
  type ProgressSell,
} from '../lib/warmup-cycle-progress';

export function warmupUiFixture() {
  const wallet = '11111111111111111111111111111111',
    mint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  const native = 'So11111111111111111111111111111111111111112';
  const plan = {
    id: '6ef53658-0746-4567-9e63-af3d4428d144',
    revision: 1,
    archived: false,
    updatedAt: new Date().toISOString(),
    document: {
      name: 'Synthetic browser QA',
      chain: 'Solana',
      addresses: [wallet],
      walletRevisions: [{ address: wallet, revision: 1 }],
      tokens: [mint],
      amount: '0.001',
      feeReserve: '0.01',
      cycles: 1,
      intervalMinutes: 15,
      startAt: new Date().toISOString(),
    },
  } as unknown as SavedWarmup;
  let saved = false;
  let bought = false,
    sold = false,
    blocked = false,
    htmlError = false;
  let currentSide: 'Buy' | 'Sell' = 'Buy';
  const calls: { path: string; action?: string; method: string }[] = [];
  const expiresAt = new Date(Date.now() + 300000).toISOString();
  const preparationId = (side: string) =>
    side === 'Buy'
      ? 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
      : 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const order = (side: 'Buy' | 'Sell') =>
    ({
      side,
      inputMint: side === 'Buy' ? native : mint,
      outputMint: side === 'Buy' ? mint : native,
      inAmount: '1000000',
      minimumOutAmount: '900000',
      executionAllowed: false,
      expiresAt,
      preparation: {
        wallet,
        // Real base64 so the approval panel's self-consistency hash check runs
        // for real instead of throwing on a placeholder string.
        sha256:
          side === 'Buy'
            ? '9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a'
            : '55e5509f8052998294266ee5b50cb592938191fb5d67f73cac2e60b0276b1bdd',
        transaction: side === 'Buy' ? 'AQIDBA==' : 'BQYHCA==',
        executionAllowed: false,
        instructionsVerified: false,
      },
    }) as unknown as SolanaSwapPreparation;
  const buyReceipt = {
    id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    preparationId: preparationId('Buy'),
    planId: plan.id,
    planRevision: 1,
    walletRevision: 1,
    cycle: 1,
    remainingRaw: '1000000',
    createdAt: new Date().toISOString(),
    document: {
      wallet,
      mint,
      signature: 'FIXTURE_SIGNATURE_Buy',
      signatureVerified: true,
      commitment: 'finalized',
      network: 'mainnet',
      executionAllowed: false,
      instructionsVerified: false,
      acquiredRaw: '1000000',
      decimals: 6,
      slot: 100,
      tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
      preparationSha256: order('Buy').preparation.sha256,
      nativeChangeRaw: '-1005000',
      observedAt: new Date().toISOString(),
      source: 'Synthetic fixture',
      networkFeeLamports: '5000',
    },
  } as unknown as SavedWarmupBuyReceipt;
  const link = () =>
    warmupBuyLink(buyReceipt, {
      planId: plan.id,
      planRevision: 1,
      cycle: 1,
      wallet,
      walletRevision: 1,
      mint,
    });
  const review = (side: 'Buy' | 'Sell') =>
    ({
      id: preparationId(side),
      preparationId: preparationId(side),
      wallet,
      sha256: order(side).preparation.sha256,
      transaction: order(side).preparation.transaction,
      inputRaw: '1000000',
      minimumOutputRaw: '900000',
      inputMint: order(side).inputMint,
      outputMint: order(side).outputMint,
      network: 'mainnet',
      expiresAt,
      maximumFeeLamports: '5000',
      settlement: {
        version: 1,
        wrappedFromNativeRaw: '1000000',
        maximumRentLamports: '2039280',
        maximumNativeDebitLamports: '3044280',
        closesWrappedAccount: true,
        preexistingWrappedRefundRaw: '0',
        lookupTables: [],
      },
      ...(side === 'Sell' ? { buyReceipt: link() } : {}),
    }) as unknown as WarmupSigningReview;
  const progress = () => {
    const buys = bought
      ? [
          {
            id: buyReceipt.id,
            planRevision: 1,
            walletRevision: 1,
            cycle: 1,
            wallet,
            mint,
            acquiredRaw: '1000000',
            remainingRaw: sold ? '0' : '1000000',
            decimals: 6,
            verified: 1,
            commitment: 'finalized',
            network: 'mainnet',
          } satisfies ProgressBuy,
        ]
      : [];
    const sells = sold
      ? [
          {
            buyId: buyReceipt.id,
            consumedRaw: '1000000',
            verified: 1,
            commitment: 'finalized',
            network: 'mainnet',
          } satisfies ProgressSell,
        ]
      : [];
    return {
      ...warmupCycleProgress(
        plan,
        buys,
        sells,
        blocked
          ? [{ id: preparationId('Buy'), wallet, state: 'awaiting_signature' }]
          : [],
        false,
      ),
      performance: warmupLotPerformance(
        buys.map((buy) => ({
          ...buy,
          document: {
            signature: bs58.encode(new Uint8Array(64).fill(5)),
            wallet,
            mint,
            decimals: 6,
            tokenProgram: buyReceipt.document.tokenProgram,
            slot: 100,
            preparationSha256: order('Buy').preparation.sha256,
            nativeSettlementRaw: '-1000000',
            networkFeeLamports: '5000',
            rentChangeRaw: '0',
          },
        })),
        sells.map((sell) => ({
          ...sell,
          id: 'fixture-sell',
          document: {
            signature: bs58.encode(new Uint8Array(64).fill(6)),
            wallet,
            mint,
            decimals: 6,
            tokenProgram: buyReceipt.document.tokenProgram,
            slot: 101,
            preparationSha256: order('Sell').preparation.sha256,
            nativeSettlementRaw: '900000',
            networkFeeLamports: '5000',
            rentChangeRaw: '0',
          },
        })),
        buys.map((buy) => buy.id),
      ),
    };
  };
  const preparation = (side: 'Buy' | 'Sell') => ({
    id: plan.id,
    revision: 1,
    cycle: 1,
    walletRevision: 1,
    order: order(side),
    simulation: {
      wallet,
      sha256: order(side).preparation.sha256,
      executionAllowed: false,
      instructionsVerified: false,
      succeeded: true,
      tokensComplete: false,
      networkFeeLamports: '5000',
      nativeChangeRaw: '-1005000',
      simulationSlot: 100,
      source: 'Synthetic fixture',
      limitations: 'No provider request or valid transaction.',
    },
    history: {
      id: preparationId(side),
      planId: plan.id,
      planRevision: 1,
      cycle: 1,
      walletRevision: 1,
      document: {
        wallet,
        transaction: { sha256: order(side).preparation.sha256 },
        executionAllowed: false,
        instructionsVerified: false,
        ...(side === 'Sell' ? { buyReceipt: link() } : {}),
      },
    },
    reviewWaitMs: 0,
    ...(side === 'Sell'
      ? {
          buyLink: link(),
          inventory: {
            wallet,
            mint,
            executionAllowed: false,
            expiresAt,
            decimals: 6,
            requestedRaw: '1000000',
            amountCovered: true,
            preparationSupported: true,
            totalRaw: '1000000',
            unfrozenRaw: '1000000',
            frozenRaw: '0',
            unfrozenAmount: '1',
            tokenProgram: buyReceipt.document.tokenProgram,
            mintSlot: 100,
            observedAt: new Date().toISOString(),
            minSlot: 100,
            maxSlot: 100,
            source: 'Synthetic fixture',
          },
        }
      : {}),
  });
  const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
    const path =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url,
      method = init?.method ?? 'GET';
    if (init?.body && typeof init.body !== 'string')
      throw new Error('Only fixture JSON requests are supported.');
    const body =
      typeof init?.body === 'string' && init.body
        ? (JSON.parse(init.body) as {
            action?: string;
            side?: 'Buy' | 'Sell';
            id?: string;
            document?: SavedWarmup['document'];
          })
        : {};
    calls.push({ path, method, action: body.action });
    if (htmlError)
      return new Response('<html>Fixture outage</html>', { status: 502 });
    if (path === '/api/wallet-workspace/warmup/plans') {
      if (method === 'GET')
        return Response.json({ plans: saved ? [plan] : [] });
      if (body.action === 'save' && body.id && body.document) {
        Object.assign(plan, {
          id: body.id,
          revision: saved ? plan.revision + 1 : 1,
          document: {
            ...body.document,
            totalBudget: buildWarmupPlan(body.document).totalBudget,
          },
        });
        saved = true;
        return Response.json({ plan });
      }
    }
    if (path === '/api/wallet-workspace/warmup')
      return Response.json({
        chain: 'Solana',
        results: [
          {
            address: wallet,
            observation: {
              address: wallet,
              chain: 'Solana',
              nativeBalance: '0.02',
              currency: 'SOL',
              outgoingTransactions: null,
              sampleCount: 2,
              successfulSampleCount: 2,
              oldestObservedAt: null,
              latestObservedAt: null,
              coverage:
                'Synthetic bounded history sample; no real wallet observation.',
              observedAt: new Date().toISOString(),
              block: '100',
              source: 'fixture.test',
            },
          },
        ],
      });
    if (path.includes('/cycle-progress')) return Response.json(progress());
    if (path.endsWith('/prepare')) {
      currentSide = body.side ?? 'Buy';
      return Response.json(preparation(currentSide));
    }
    if (path.includes('/buy-receipts') && method === 'GET')
      return Response.json({
        planId: plan.id,
        executionAllowed: false,
        receipts: bought && !sold ? [buyReceipt] : [],
        nextCursor: null,
      });
    if (path.includes('/buy-receipts') || path.includes('/sell-receipts')) {
      if (path.includes('/buy-receipts')) bought = true;
      else sold = true;
      return Response.json({
        receipt: {
          ...buyReceipt,
          preparationId: preparationId(currentSide),
          document: {
            ...buyReceipt.document,
            signature: `FIXTURE_SIGNATURE_${currentSide}`,
          },
        },
      });
    }
    if (path.includes('/signing')) {
      if (method === 'GET')
        return Response.json({
          planId: plan.id,
          intents: blocked
            ? [
                {
                  id: preparationId('Buy'),
                  preparationId: preparationId('Buy'),
                  planId: plan.id,
                  planRevision: 1,
                  wallet,
                  cycle: 1,
                  side: 'Buy',
                  state: 'awaiting_signature',
                  signature: null,
                  document: review('Buy'),
                  createdAt: plan.updatedAt,
                  updatedAt: plan.updatedAt,
                },
              ]
            : [],
          nextCursor: null,
        });
      if (body.action === 'review')
        return Response.json({ review: review(currentSide) });
      if (body.action === 'cancel') {
        blocked = false;
        return Response.json({ state: 'cancelled' });
      }
      if (body.action === 'register' || body.action === 'submit')
        return Response.json({
          state: body.action === 'register' ? 'signed' : 'submitted',
          signature: `FIXTURE_SIGNATURE_${currentSide}`,
        });
    }
    return Response.json(
      { error: 'No real network or unrecognized fixture request permitted.' },
      { status: 403 },
    );
  };
  return {
    plan,
    wallet,
    order,
    review,
    preparation,
    progress,
    fetcher,
    calls,
    scenario(value: 'new' | 'recovery' | 'html') {
      bought = false;
      sold = false;
      blocked = value === 'recovery';
      htmlError = value === 'html';
    },
  };
}
