'use client';
import { useEffect, useState } from 'react';
import { Button } from './ui/button';
import {
  importedBalanceBasisPointAmount,
  type ImportedBalanceContext,
  importedSupplyBasisPointAmount,
  type ImportedSellSupply,
} from '@/lib/imported-balance-review';
import type { ImportedSwapBalance } from '@/lib/imported-swap-balance';
import {
  useTradeAmountPresets,
  TradeAmountPresetSettings,
} from './trade-amount-presets';
import { presetPercentLabel } from '@/lib/trade-amount-preferences';
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
  const presets = useTradeAmountPresets();
  const expired = Date.parse(report.expiresAt) <= now;
  useEffect(() => {
    const expires = Date.parse(report.expiresAt);
    const refresh = window.setTimeout(() => setNow(Date.now()), 0);
    const timer = window.setTimeout(
      () => setNow(Date.now()),
      Math.max(0, expires - Date.now()),
    );
    return () => {
      window.clearTimeout(refresh);
      window.clearTimeout(timer);
    };
  }, [report.observedAt, report.expiresAt]);
  if (context.side !== 'Sell') return null;
  return (
    <section aria-label="Sell balance percentages">
      <p>
        Choose a percentage of the observed unfrozen token units. Amounts round
        down to whole atomic units.
      </p>
      {presets.preferences.sellBalanceBps.map((basisPoints) => {
        const label = presetPercentLabel(basisPoints);
        let amount: string | null = null;
        try {
          amount = importedBalanceBasisPointAmount(
            report,
            context,
            basisPoints,
            now,
          );
        } catch {
          /* Invalid, expired or unsupported observations never produce a preset. */
        }
        return (
          <Button
            key={basisPoints}
            type="button"
            variant="outline"
            disabled={locked || expired || amount === null}
            aria-label={`Set sell amount to ${label} of observed unfrozen balance`}
            onClick={() => {
              if (locked || expired) return;
              try {
                onAmountChange(
                  importedBalanceBasisPointAmount(report, context, basisPoints),
                );
              } catch {
                setNow(Date.now());
              }
            }}
          >
            {basisPoints === 10000 ? 'MAX' : label}
          </Button>
        );
      })}
      {supply && (
        <section aria-label="Sell supply percentages">
          <p>
            Percentage of saved total supply, observed{' '}
            {new Date(supply.observedAt).toLocaleString()}.
          </p>
          {presets.preferences.sellSupplyBps.map((basisPoints) => {
            const label = presetPercentLabel(basisPoints);
            let amount: string | null = null;
            try {
              amount = importedSupplyBasisPointAmount(
                report,
                context,
                supply,
                basisPoints,
                now,
              );
            } catch {
              /* Uncovered or invalid evidence leaves the preset disabled. */
            }
            return (
              <Button
                key={basisPoints}
                type="button"
                variant="outline"
                disabled={locked || expired || amount === null}
                aria-label={`Set sell amount to ${label} of saved total supply`}
                onClick={() => {
                  if (locked || expired) return;
                  try {
                    onAmountChange(
                      importedSupplyBasisPointAmount(
                        report,
                        context,
                        supply,
                        basisPoints,
                      ),
                    );
                  } catch {
                    setNow(Date.now());
                  }
                }}
              >
                {label}
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
      <TradeAmountPresetSettings store={presets} />
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
