'use client';
import type { LaunchPlanInput } from '@/lib/launch-plan';
import {
  launchTimingBounds,
  ZERO_LAUNCH_TIMING,
  LAUNCH_INITIAL_BUY_DELAY_MAX_MS,
} from '@/lib/launch-timing';
import { holdersBuyUnit } from '@/lib/launch-buy';
import { MEV_SLIDER_MAX, MEV_SLIDER_MIN } from '@/lib/bubble-map-estimate';
import { BubbleMapEstimate } from '@/components/bubble-map-estimate';
import { Input } from '@/components/ui/input';
export function LaunchTimingForm({
  plan,
  onChange,
}: {
  plan: LaunchPlanInput;
  onChange: (change: Partial<LaunchPlanInput>) => void;
}) {
  const bounds = launchTimingBounds(plan);
  const timing = plan.timing ?? ZERO_LAUNCH_TIMING;
  const update = (key: keyof typeof timing, value: string) =>
    onChange({
      timing: { ...timing, [key]: value === '' ? 0 : Number(value) },
    });
  // The captured panel is an MEV-mode readout, which is the sequenced method.
  const mevMode = plan.mode === 'Block-0';
  const optional = (value: string) =>
    value === '' ? undefined : Number(value);
  return (
    <section className="launch-timing-form" aria-label="Launch pacing">
      <h2>
        Launch pacing <span className="section-note">Draft settings</span>
      </h2>
      <div className="input-grid">
        {bounds.maxMs > 0 && (
          <label>
            Buy delay (ms)
            <Input
              aria-label="Buy delay milliseconds"
              type="number"
              min={bounds.minMs}
              max={bounds.maxMs}
              step={1}
              value={timing.buyDelayMs}
              onChange={(e) => update('buyDelayMs', e.target.value)}
            />
            <small>
              {bounds.minMs} to {bounds.maxMs} ms between planned buys. Zero
              adds no pacing delay.
            </small>
          </label>
        )}
        {bounds.initialEnabled && (
          <label>
            Initial buy delay (ms)
            <Input
              aria-label="Initial buy delay milliseconds"
              type="number"
              min={0}
              max={LAUNCH_INITIAL_BUY_DELAY_MAX_MS}
              step={1}
              value={timing.initialBuyDelayMs}
              onChange={(e) => update('initialBuyDelayMs', e.target.value)}
            />
            <small>
              Optional delay before the first buy. Captured suggestion:{' '}
              {bounds.initialSuggestedMs} ms. Local draft limit: 24 hours.
            </small>
          </label>
        )}
      </div>
      {mevMode && (
        <>
          <div className="input-grid">
            <label>
              Detection mode ({MEV_SLIDER_MIN} to {MEV_SLIDER_MAX})
              <Input
                aria-label="Detection mode slider"
                type="number"
                min={MEV_SLIDER_MIN}
                max={MEV_SLIDER_MAX}
                step={0.1}
                value={plan.mevSlider ?? 1}
                onChange={(e) =>
                  onChange({ mevSlider: Number(e.target.value) })
                }
              />
              <small>
                Lower favours avoiding snipers, higher favours avoiding top
                traders.
              </small>
            </label>
            <label htmlFor="plan-supply-cost">
              Supply cost (bps)
              <Input
                id="plan-supply-cost"
                aria-label="Supply cost basis points"
                type="number"
                min={0}
                max={10000}
                step={1}
                value={plan.supplyCostBps ?? ''}
                onChange={(e) =>
                  onChange({ supplyCostBps: optional(e.target.value) })
                }
              />
              <small>
                Most supply holders can lose during cleanup, in basis points.
              </small>
            </label>
            <label htmlFor="plan-cleanup-time">
              Cleanup time (ms)
              <Input
                id="plan-cleanup-time"
                aria-label="Cleanup duration milliseconds"
                type="number"
                min={0}
                max={86400000}
                step={1}
                value={plan.estimatedDurationMs ?? ''}
                onChange={(e) =>
                  onChange({ estimatedDurationMs: optional(e.target.value) })
                }
              />
              <small>Estimated total cleanup duration.</small>
            </label>
            <label htmlFor="plan-max-front-mev">
              Max Front MEV wallets
              <Input
                id="plan-max-front-mev"
                aria-label="Max Front MEV wallets"
                type="number"
                min={0}
                step={1}
                value={plan.maxFrontMevCount ?? ''}
                onChange={(e) =>
                  onChange({ maxFrontMevCount: optional(e.target.value) })
                }
              />
              <small>
                Left empty means uncapped. Taken from the mint when known.
              </small>
            </label>
            <label htmlFor="plan-max-front-mev-post">
              Max Front MEV after migration
              <Input
                id="plan-max-front-mev-post"
                aria-label="Max Front MEV wallets after migration"
                type="number"
                min={0}
                step={1}
                value={plan.maxFrontMevPostMigration ?? ''}
                onChange={(e) =>
                  onChange({
                    maxFrontMevPostMigration: optional(e.target.value),
                  })
                }
              />
              <small>
                Cap once the buy reaches the threshold. An explicit 0 lifts the
                cap after migration.
              </small>
            </label>
            <label htmlFor="plan-migration-threshold">
              Migration threshold
              <Input
                id="plan-migration-threshold"
                aria-label="Migration threshold"
                type="number"
                min={0}
                step={1}
                value={plan.migrationThreshold ?? ''}
                onChange={(e) =>
                  onChange({ migrationThreshold: optional(e.target.value) })
                }
              />
              <small>
                In the same unit as the developer and holder buy percentages.
              </small>
            </label>
          </div>
          <BubbleMapEstimate
            buyDelayMs={timing.buyDelayMs}
            mevSlider={plan.mevSlider ?? 1}
            supplyPercent={
              holdersBuyUnit(plan) === 'supply' ? plan.holdersBuy : null
            }
            supplyCostBps={plan.supplyCostBps}
            estimatedDurationMs={plan.estimatedDurationMs}
          />
        </>
      )}
      <p className="source-note">
        {plan.mode === 'Quick'
          ? 'Quick uses zero buy delay.'
          : plan.mode === 'Manual'
            ? 'Manual has no automatic buy timing.'
            : `${timing.buyDelayMs} ms planned buy delay.`}{' '}
        {bounds.initialEnabled
          ? `${timing.initialBuyDelayMs} ms initial delay.`
          : ''}{' '}
        These values do not run a scheduler or submit transactions.
      </p>
    </section>
  );
}
