import bs58 from 'bs58';
import { WRAPPED_SOL } from '../lib/warmup-swap-quote';
import {
  initialCounterLedger,
  evaluateCounterTrade,
  type CounterRules,
} from '../lib/counter-trade';
import type { CounterPlan } from '../lib/counter-trade-store';
import type {
  PoolTradeMovement,
  PoolTradeMovementContext,
} from '../lib/pool-trade-movement';
import { directMovementFixture } from './direct-movement-fixture';
import { classifyWalletMovement } from '../lib/wallet-movement-classification';
export function counterBuyFixture(sourceWallet?: string) {
  const tx = directMovementFixture(0, 0);
  if (sourceWallet) {
    const original = tx.address;
    Object.assign(
      tx,
      JSON.parse(
        JSON.stringify(tx, (_key, value: unknown) =>
          value === original ? sourceWallet : value,
        ),
      ) as typeof tx,
    );
  }
  const token = tx.tokenChanges[0],
    signature = bs58.encode(new Uint8Array(64).fill(1));
  const context: PoolTradeMovementContext = {
    projectId: '00000000-0000-4000-8000-000000000001',
    revision: 1,
    mint: token.mint,
    decimals: token.decimals,
    pool: tx.tokenChanges[0].mint,
    tapeObservedAt: '2026-10-13T12:00:00.000Z',
    trade: {
      id: 'trade-1',
      transaction: signature,
      sender: tx.address,
      block: tx.slot,
      side: 'Sell',
      timestamp: '2026-10-13T12:00:00.000Z',
      tokenAmount: '1',
      quoteAmount: '1',
      priceUsd: '1',
      volumeUsd: '1',
    },
  };
  const movement: PoolTradeMovement = {
    format: 'pool-trade-movement-v1',
    executionAllowed: false,
    projectId: context.projectId,
    revision: 1,
    pool: context.pool,
    mint: context.mint,
    wallet: tx.address,
    signature,
    tradeId: context.trade.id,
    tapeObservedAt: context.tapeObservedAt,
    slot: tx.slot,
    providerBlock: tx.slot,
    blockAgrees: true,
    blockTime: tx.blockTime,
    commitment: 'confirmed',
    failed: false,
    walletSigner: true,
    providerSide: 'Sell',
    sideAgrees: true,
    tokenChange: {
      beforeRaw: token.beforeRaw,
      afterRaw: token.afterRaw,
      changeRaw: token.changeRaw,
      decimals: token.decimals,
    },
    classification: classifyWalletMovement(tx, token.mint),
    observedAt: '2026-10-13T12:00:01.000Z',
    source: 'fixture.test',
  };
  const rules: CounterRules = {
    format: 'counter-evaluator-v1',
    responseSide: 'Buy',
    replicationPercent: '100',
    trigger: { kind: 'rate', percent: '100' },
    minimumResponseTokenRaw: '1',
    ignoredWallets: [],
  };
  const evaluated = evaluateCounterTrade(
    rules,
    initialCounterLedger(rules, context),
    movement,
    context,
  );
  const plan: CounterPlan = {
    format: 'counter-plan-v1',
    executionAllowed: false,
    id: '00000000-0000-4000-8000-000000000002',
    projectId: context.projectId,
    revision: 2,
    state: 'active',
    projectDocument: '{}',
    rules,
    ledger: evaluated.ledger,
    createdAt: '2026-10-13T12:00:00.000Z',
    updatedAt: '2026-10-13T12:00:01.000Z',
  };
  const response = {
    inputMint: WRAPPED_SOL,
    outputMint: token.mint,
    inAmount: '1000',
    outAmount: evaluated.decision.proposalTokenRaw,
    otherAmountThreshold: '1005',
    swapMode: 'ExactOut',
    slippageBps: 50,
    contextSlot: 100,
    platformFee: null,
    routePlan: [
      {
        swapInfo: {
          label: 'Whirlpool',
          ammKey: tx.address,
          inputMint: WRAPPED_SOL,
          outputMint: token.mint,
          inAmount: '1000',
          outAmount: evaluated.decision.proposalTokenRaw,
        },
      },
    ],
    transaction: 'PRIVATE-TRANSACTION',
    requestId: 'PRIVATE-REQUEST',
  };
  return { plan, response, identity: evaluated.decision.identity };
}
