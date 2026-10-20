import { autoSellStrategyError, type AutoSellStrategy } from './auto-sell';
import {
  autoSellSessionError,
  type AutoSellSessionRules,
} from './auto-sell-session';

export type AutoSellConfiguration = {
  strategies: AutoSellStrategy[];
  session: AutoSellSessionRules;
};

export type AutoSellEditReview = {
  reviewKey: string;
  revision: number;
  before: AutoSellConfiguration;
  after: AutoSellConfiguration;
  accountedRaw: string;
  queuedRaw: string;
  cancelledQueuedRaw: string;
  reactivatedStrategies: string[];
  endsSession: boolean;
};

/** Own every nested value before retaining an approved configuration. */
export function reviewedAutoSellConfiguration(value: AutoSellConfiguration) {
  const copy = structuredClone(value);
  if (
    !Array.isArray(copy.strategies) ||
    copy.strategies.length < 1 ||
    copy.strategies.length > 5
  )
    throw new Error('Choose one to five strategies.');
  const ids = new Set<string>();
  for (const strategy of copy.strategies) {
    if (
      typeof strategy.id !== 'string' ||
      !strategy.id ||
      strategy.id.length > 128 ||
      strategy.id !== strategy.id.trim() ||
      ids.has(strategy.id)
    )
      throw new Error('Every strategy needs a unique identifier.');
    ids.add(strategy.id);
    if (
      typeof strategy.name !== 'string' ||
      !strategy.name.trim() ||
      strategy.name.length > 80
    )
      throw new Error('Choose a strategy name under 81 characters.');
    if (
      !['counter', 'dca', 'limit'].includes(strategy.mode) ||
      !['supply', 'tokens'].includes(strategy.amountUnit) ||
      !['rate', 'min-sol', 'min-token'].includes(strategy.trigger.kind)
    )
      throw new Error('Unknown strategy mode or amount unit.');
    const rowIds = new Set<string>();
    for (const row of strategy.limitOrders) {
      if (
        typeof row.id !== 'string' ||
        !row.id ||
        row.id.length > 128 ||
        rowIds.has(row.id)
      )
        throw new Error('Every limit order needs a unique identifier.');
      rowIds.add(row.id);
    }
    const error = autoSellStrategyError(strategy);
    if (error) throw new Error(`${strategy.name}: ${error}`);
  }
  const error = autoSellSessionError(copy.session);
  if (error) throw new Error(error);
  return copy;
}
