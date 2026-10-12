'use client';
import type { LaunchPlanInput } from '@/lib/launch-plan';
import { holdersBuyUnit, holdersQuoteDecimals } from '@/lib/launch-buy';
import {
  developerSupplyLimit,
  sequencedSupplyLimits,
} from '@/lib/launch-supply';
import { Input } from '@/components/ui/input';

export function LaunchBuyForm({
  plan,
  onChange,
}: {
  plan: LaunchPlanInput;
  onChange: (change: Partial<LaunchPlanInput>) => void;
}) {
  const unit = holdersBuyUnit(plan);
  const supply = sequencedSupplyLimits(plan);
  const developerMax = developerSupplyLimit(plan);
  const decimals = holdersQuoteDecimals(plan);
  return (
    <section aria-label="Launch buy amounts" className="launch-buy-form">
      <div className="input-grid">
        <label>
          Developer supply (%)
          <Input
            aria-label="Developer Buy percent"
            type="number"
            min={0}
            max={developerMax ?? 100}
            step="any"
            disabled={developerMax === 0}
            value={plan.developerBuy}
            onChange={(e) => onChange({ developerBuy: Number(e.target.value) })}
          />
          <small>
            {developerMax === 0
              ? 'Developer supply buy is unavailable for this venue.'
              : `Excludes holders. ${developerMax === null ? 'Review venue limits before execution.' : `Maximum ${developerMax}%.`}`}
          </small>
        </label>
        <label>
          {unit === 'supply'
            ? 'Holders supply (%)'
            : `Total holders ${plan.mode === 'Manual' ? 'funding' : 'buy'} (${plan.currency})`}
          {unit === 'supply' ? (
            <Input
              aria-label="Holders Buy percent"
              type="number"
              min={0}
              max={supply?.total ?? 100}
              step="any"
              value={plan.holdersBuy}
              onChange={(e) => onChange({ holdersBuy: Number(e.target.value) })}
            />
          ) : (
            <Input
              aria-label="Holders quote amount"
              type="text"
              inputMode="decimal"
              placeholder="0"
              value={plan.holdersBuyQuote ?? ''}
              onChange={(e) =>
                onChange({
                  holdersBuyQuote:
                    e.target.value === '' ? undefined : e.target.value,
                })
              }
            />
          )}
          <small>
            {unit === 'supply'
              ? 'Supply across holders, excluding developer.'
              : `Total across holders in the selected quote token. ${decimals === null ? 'Select a captured quote token to set its amount.' : `Up to ${decimals} decimal places.`}`}
          </small>
        </label>
      </div>
      {supply ? (
        <p className="source-note" aria-live="polite">
          Combined supply buy: {plan.developerBuy + plan.holdersBuy}% /{' '}
          {supply.total}% maximum.
        </p>
      ) : (
        <p className="source-note">
          Quote amounts are separate from developer supply percentages. No
          conversion, fees or wallet reserve is included.{' '}
          {plan.holdersBuyQuote === undefined &&
            'No quote amount is entered. A saved supply percentage is not a quote amount.'}
        </p>
      )}
    </section>
  );
}
