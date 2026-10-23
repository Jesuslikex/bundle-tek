import {
  AUTO_SELL_MODE_NAMES,
  autoSellMaximumLabel,
  formatDuration,
  marketCapLabel,
  type AutoSellStrategy,
} from './auto-sell';
import type { AutoSellConfiguration } from './auto-sell-edit';

export type AutoSellSettingChange = {
  label: string;
  before: string;
  after: string;
};
function strategyFields(
  strategy: AutoSellStrategy,
  old?: AutoSellStrategy,
): Record<string, string> {
  const unit = strategy.amountUnit === 'tokens' ? 'tokens' : '% supply';
  const fields: Record<string, string> = {
    Name: strategy.name,
    Mode: AUTO_SELL_MODE_NAMES[strategy.mode],
    'Market cap range': marketCapLabel(strategy),
    'Strategy maximum': autoSellMaximumLabel(strategy),
    'Strategy duration': strategy.endDurationSeconds
      ? formatDuration(strategy.endDurationSeconds)
      : 'No time limit',
  };
  if (strategy.mode === 'counter')
    Object.assign(fields, {
      Replication: `${strategy.replicationPercent}%`,
      Trigger:
        strategy.trigger.kind === 'rate'
          ? `${strategy.trigger.percent}% probability`
          : `${strategy.trigger.amount} ${strategy.trigger.kind === 'min-sol' ? 'SOL' : 'tokens'} minimum observed trade`,
      'Minimum per sell': strategy.minSupplyPercentPerSell
        ? `${strategy.minSupplyPercentPerSell}% supply`
        : 'No minimum buffer',
      Whitelist:
        strategy.whitelist.join('\n') ||
        'None (your own wallets remain excluded)',
    });
  if (strategy.mode === 'dca')
    Object.assign(fields, {
      'DCA amount': strategy.dcaRandomized
        ? `${strategy.dcaMinAmount}–${strategy.dcaMaxAmount} ${unit} (randomized)`
        : `${strategy.dcaAmount} ${unit} (fixed)`,
      'DCA interval': formatDuration(strategy.dcaIntervalSeconds),
    });
  if (strategy.mode === 'limit')
    fields['Limit orders'] = strategy.limitOrders
      .map(
        (row, index) =>
          `${index + 1}. ${row.amount} ${unit} at $${row.marketCapUsd}${old && !old.limitOrders.some((prior) => prior.id === row.id) ? ' (new order)' : ''}`,
      )
      .join('\n');
  return fields;
}

/** Human-readable differences; a replacement order remains visible even at the same price/size. */
export function autoSellEditChanges(
  before: AutoSellConfiguration,
  after: AutoSellConfiguration,
): AutoSellSettingChange[] {
  const changes: AutoSellSettingChange[] = [];
  const add = (label: string, old: string, next: string) => {
    if (old !== next) changes.push({ label, before: old, after: next });
  };
  add(
    'Session maximum',
    autoSellMaximumLabel(before.session),
    autoSellMaximumLabel(after.session),
  );
  add(
    'Session duration',
    before.session.endDurationSeconds
      ? formatDuration(before.session.endDurationSeconds)
      : 'No time limit',
    after.session.endDurationSeconds
      ? formatDuration(after.session.endDurationSeconds)
      : 'No time limit',
  );
  const ids = [
    ...new Set(
      [...before.strategies, ...after.strategies].map(
        (strategy) => strategy.id,
      ),
    ),
  ];
  for (const id of ids) {
    const old = before.strategies.find((strategy) => strategy.id === id),
      next = after.strategies.find((strategy) => strategy.id === id);
    const previous = old ? strategyFields(old) : {},
      updated = next ? strategyFields(next, old) : {};
    for (const field of new Set([
      ...Object.keys(previous),
      ...Object.keys(updated),
    ]))
      add(
        `${next?.name ?? old!.name} · ${field}`,
        previous[field] ?? (old ? 'Not used' : 'Not present'),
        updated[field] ?? (next ? 'Not used' : 'Removed'),
      );
  }
  // Reordering changes evaluation priority even if every individual field matches.
  const oldOrder = before.strategies.map((strategy) => strategy.id),
    newOrder = after.strategies.map((strategy) => strategy.id);
  if (
    oldOrder.length === newOrder.length &&
    oldOrder.every((id) => newOrder.includes(id)) &&
    JSON.stringify(oldOrder) !== JSON.stringify(newOrder)
  )
    add(
      'Strategy priority',
      before.strategies.map((strategy) => strategy.name).join(' → '),
      after.strategies.map((strategy) => strategy.name).join(' → '),
    );
  return changes;
}
