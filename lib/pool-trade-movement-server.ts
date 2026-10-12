import { observeTrackedTransaction } from './tracked-wallet-transaction';
import { classifyWalletMovement } from './wallet-movement-classification';
import {
  requirePoolTradeMovement,
  type PoolTradeMovement,
  type PoolTradeMovementContext,
} from './pool-trade-movement';
export async function observePoolTradeMovement(
  context: PoolTradeMovementContext,
  signal: AbortSignal,
) {
  const tx = await observeTrackedTransaction(
    context.trade.sender,
    'mainnet',
    context.trade.transaction,
    signal,
  );
  if (!tx)
    throw new Error(
      'Confirmed transaction is unavailable from the configured RPC.',
    );
  if (
    tx.address !== context.trade.sender ||
    tx.signature !== context.trade.transaction ||
    tx.network !== 'mainnet'
  )
    throw new Error('Transaction identity differs from the saved trade.');
  const changes = tx.tokenChanges.filter((t) => t.mint === context.mint);
  if (
    changes.length > 1 ||
    changes.some((t) => t.decimals !== context.decimals)
  )
    throw new Error('Transaction mint precision differs.');
  const change = tx.tokensComplete ? changes[0] : undefined;
  const classification = classifyWalletMovement(tx, context.mint);
  const result: PoolTradeMovement = {
    format: 'pool-trade-movement-v1',
    executionAllowed: false,
    projectId: context.projectId,
    revision: context.revision,
    pool: context.pool,
    mint: context.mint,
    wallet: tx.address,
    signature: tx.signature,
    tradeId: context.trade.id,
    tapeObservedAt: context.tapeObservedAt,
    slot: tx.slot,
    providerBlock: context.trade.block,
    blockAgrees: tx.slot === context.trade.block,
    blockTime: tx.blockTime,
    commitment: tx.commitment,
    failed: tx.failed,
    walletSigner: tx.walletSigner,
    providerSide: context.trade.side,
    sideAgrees: ['buy', 'sell'].includes(classification.kind)
      ? classification.kind === context.trade.side.toLowerCase()
      : null,
    tokenChange: change
      ? {
          beforeRaw: change.beforeRaw,
          afterRaw: change.afterRaw,
          changeRaw: change.changeRaw,
          decimals: change.decimals,
        }
      : null,
    classification,
    observedAt: tx.observedAt,
    source: tx.source,
  };
  return requirePoolTradeMovement(result, context);
}
