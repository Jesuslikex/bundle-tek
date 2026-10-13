import {
  decodeConditionalOrder,
  type ConditionalOrder,
} from './conditional-order';
import {
  conditionalLevelStatuses,
  type ConditionalLevelStatus,
} from './conditional-level-status';
import { sampledSavedConditions } from './conditional-level-review';
import type { ImportedTokenProject } from './imported-token-project';
import type { SavedTokenMarket } from './token-market';
import type { WorkspaceWallet } from './wallet-workspace';

export function conditionalTriggerQueue(input: {
  orders: ConditionalOrder[];
  statuses: ConditionalLevelStatus[];
  wallets: WorkspaceWallet[];
  project: ImportedTokenProject;
  pair: string;
  observation: SavedTokenMarket;
  now: number;
}) {
  const { project, pair, observation, now } = input;
  if (
    input.orders.length > 100 ||
    input.wallets.length > 500 ||
    !Number.isFinite(now)
  )
    throw new Error('Conditional queue context unavailable. Reload orders.');
  const orders = input.orders.map(decodeConditionalOrder);
  if (new Set(orders.map((o) => o.id)).size !== orders.length)
    throw new Error(
      'Conditional queue contains duplicate orders. Reload orders.',
    );
  const statuses = new Set(
    conditionalLevelStatuses(input.statuses, orders).map(
      (s) => `${s.orderId}:${s.level}`,
    ),
  );
  const candidates: Array<{
    order: ConditionalOrder;
    level: number;
    wallet: WorkspaceWallet;
    targetUsd: string;
    amount: string;
  }> = [];
  let unavailableOrders = 0,
    checkedLevels = 0,
    reservedLevels = 0;
  for (const order of orders) {
    if (order.state !== 'draft') continue;
    const wallets = input.wallets.filter(
      (w) =>
        w.chain === 'Solana' &&
        w.address === order.terms.wallet &&
        !w.archived &&
        w.revision === order.terms.walletRevision,
    );
    if (
      wallets.length !== 1 ||
      project.archived ||
      order.terms.projectId !== project.id ||
      order.terms.projectRevision !== project.revision ||
      order.terms.pair !== pair ||
      order.terms.mint !== project.document.token.address
    ) {
      unavailableOrders++;
      continue;
    }
    const reviews = sampledSavedConditions(
      order,
      project,
      pair,
      observation,
      now,
    );
    for (const [i, level] of order.terms.levels.entries()) {
      if (statuses.has(`${order.id}:${level.level}`)) {
        reservedLevels++;
        continue;
      }
      checkedLevels++;
      if (reviews[i].met)
        candidates.push({
          order,
          level: level.level,
          wallet: wallets[0],
          targetUsd: level.targetUsd,
          amount: level.amount,
        });
    }
  }
  return { candidates, unavailableOrders, checkedLevels, reservedLevels };
}
