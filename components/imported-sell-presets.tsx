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
import {
  presetPercentLabel,
  tradePresetKeyboard,
} from '@/lib/trade-amount-preferences';
import { TradePresetKeyboardPanel } from './trade-preset-keyboard';
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
  const keyboard = tradePresetKeyboard(presets.preferences);
  const option = (basisPoints: number, index: number, supplyMode: boolean) => {
    const label = presetPercentLabel(basisPoints);
    const calculate = (at?: number) =>
      supplyMode && supply
        ? importedSupplyBasisPointAmount(
            report,
            context,
            supply,
            basisPoints,
            at,
          )
        : importedBalanceBasisPointAmount(report, context, basisPoints, at);
    let amount: string | null = null;
    try {
      amount = calculate(now);
    } catch {
      /* Invalid evidence stays unavailable. */
    }
    return {
      basisPoints,
      label,
      key: (supplyMode ? keyboard.sellSupply : keyboard.sellBalance)[index],
      disabled: locked || expired || amount === null,
      select: () => {
        if (locked || expired) return;
        try {
          onAmountChange(calculate());
        } catch {
          setNow(Date.now());
        }
      },
    };
  };
  const balanceOptions = presets.preferences.sellBalanceBps.map((bps, i) =>
    option(bps, i, false),
  );
  const supplyOptions = supply
    ? presets.preferences.sellSupplyBps.map((bps, i) => option(bps, i, true))
    : [];
  return (
    <section aria-label="Sell balance percentages">
      <TradePresetKeyboardPanel
        label="Sell preset keyboard panel"
        scope={JSON.stringify([
          context,
          report.observedAt,
          report.expiresAt,
          supply,
          presets.ownerId,
          presets.view?.revision,
          presets.preferences,
        ])}
        blocked={
          locked ||
          expired ||
          presets.busy ||
          Boolean(presets.error) ||
          !report.preparationSupported
        }
        actions={[
          ...balanceOptions.map((o) => ({ ...o, label: `${o.label} balance` })),
          ...supplyOptions.map((o) => ({
            ...o,
            label: `${o.label} saved supply`,
          })),
        ]}
      >
        <p>
          Choose a percentage of the observed unfrozen token units. Amounts
          round down to whole atomic units.
        </p>
        {balanceOptions.map(({ basisPoints, label, disabled, select }) => {
          return (
            <Button
              key={basisPoints}
              type="button"
              variant="outline"
              disabled={disabled}
              aria-label={`Set sell amount to ${label} of observed unfrozen balance`}
              onClick={select}
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
            {supplyOptions.map(({ basisPoints, label, disabled, select }) => {
              return (
                <Button
                  key={basisPoints}
                  type="button"
                  variant="outline"
                  disabled={disabled}
                  aria-label={`Set sell amount to ${label} of saved total supply`}
                  onClick={select}
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
      </TradePresetKeyboardPanel>
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
