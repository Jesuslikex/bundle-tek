'use client';
import type { LaunchPlanInput } from '@/lib/launch-plan';
import { launchTimingBounds, ZERO_LAUNCH_TIMING } from '@/lib/launch-timing';
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
              max={86400000}
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
