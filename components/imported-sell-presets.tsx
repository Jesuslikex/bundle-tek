'use client';
import { useEffect, useState } from 'react';
import { Button } from './ui/button';
import {
  importedSellPercentage,
  IMPORTED_SELL_PERCENTAGES,
  type ImportedBalanceContext,
  importedSupplySellAmount,
  IMPORTED_SUPPLY_SELL_PRESETS,
  type ImportedSellSupply,
} from '@/lib/imported-balance-review';
import type { ImportedSwapBalance } from '@/lib/imported-swap-balance';
export function ImportedSellPresets({
  report,
  context,
  locked,
  onAmountChange,
  supply,
}: {
  report: ImportedSwapBalance;
  context: ImportedBalanceContext;
  locked: boolean;
  onAmountChange: (amount: string) => void;
  supply?: ImportedSellSupply;
}) {
  const [now, setNow] = useState(() => Date.now());
  const expired = Date.parse(report.expiresAt) <= now;
  useEffect(() => {
    const expires = Date.parse(report.expiresAt);
    const timer = window.setTimeout(
      () => setNow(Date.now()),
      Math.max(0, expires - Date.now()),
    );
    return () => window.clearTimeout(timer);
  }, [report.expiresAt]);
  if (context.side !== 'Sell') return null;
  return (
    <section aria-label="Sell balance percentages">
      <p>
        Choose a percentage of the observed unfrozen token units. Amounts round
        down to whole atomic units.
      </p>
      {IMPORTED_SELL_PERCENTAGES.map((percent) => {
        let amount: string | null = null;
        try {
          amount = importedSellPercentage(report, context, percent, now);
        } catch {
          /* Invalid, expired or unsupported observations never produce a preset. */
        }
        return (
          <Button
            key={percent}
            variant="outline"
            disabled={locked || expired || amount === null}
            aria-label={`Set sell amount to ${percent}% of observed unfrozen balance`}
            onClick={() => {
              if (locked || expired) return;
              try {
                onAmountChange(
                  importedSellPercentage(report, context, percent),
                );
              } catch {
                setNow(Date.now());
              }
            }}
          >
            {percent === 100 ? 'MAX' : `${percent}%`}
          </Button>
        );
      })}
      {supply && (
        <section aria-label="Sell supply percentages">
          <p>
            Percentage of saved total supply, observed{' '}
            {new Date(supply.observedAt).toLocaleString()}.
          </p>
          {IMPORTED_SUPPLY_SELL_PRESETS.map((preset) => {
            let amount: string | null = null;
            try {
              amount = importedSupplySellAmount(
                report,
                context,
                supply,
                preset.basisPoints,
                now,
              );
            } catch {
              /* Uncovered or invalid evidence leaves the preset disabled. */
            }
            return (
              <Button
                key={preset.basisPoints}
                type="button"
                variant="outline"
                disabled={locked || expired || amount === null}
                aria-label={`Set sell amount to ${preset.label} of saved total supply`}
                onClick={() => {
                  if (locked || expired) return;
                  try {
                    onAmountChange(
                      importedSupplySellAmount(
                        report,
                        context,
                        supply,
                        preset.basisPoints,
                      ),
                    );
                  } catch {
                    setNow(Date.now());
                  }
                }}
              >
                {preset.label}
              </Button>
            );
          })}
          <p className="text-xs text-muted-foreground">
            Supply may have changed since observation. Presets round down and
            must fit the observed unfrozen balance of this wallet; preparation
            rechecks current holdings.
          </p>
        </section>
      )}
      {expired ? (
        <output>Balance observation expired. Check trade balance again.</output>
      ) : !report.preparationSupported ? (
        <p>Percentage selection is unavailable for unsupported inventory.</p>
      ) : (
        <p>
          Sets the amount only. Selecting a percentage clears prior quotes and
          preparations. Preparation checks fresh balances, fees, route support
          and acquisition capacity before explicit signing approval.
        </p>
      )}
    </section>
  );
}
