'use client';
import { Input } from '@/components/ui/input';
import {
  DEFAULT_PRINTR_SETTINGS,
  PRINTR_FEE_DESTINATIONS,
  PRINTR_SUPPLIES,
  type PrintrSettings,
} from '@/lib/printr-settings';
import type { VenueSettings } from '@/lib/venue-settings';

export function PrintrSettingsForm({
  settings,
  onChange,
}: {
  settings: VenueSettings;
  onChange: (settings: VenueSettings) => void;
}) {
  const printr = settings.printr ?? DEFAULT_PRINTR_SETTINGS;
  const update = (change: Partial<PrintrSettings>) =>
    onChange({ ...settings, printr: { ...printr, ...change } });
  return (
    <section className="venue-options detailed-venue-settings">
      <h2>
        Printr settings <span>Saved with your project</span>
      </h2>
      <div className="fee-share-editor pump-creator-fee-editor">
        <label>
          Fee destination
          <select
            aria-label="Printr fee destination"
            value={printr.feeDestination}
            onChange={(event) =>
              update({
                feeDestination: event.target
                  .value as PrintrSettings['feeDestination'],
              })
            }
          >
            {PRINTR_FEE_DESTINATIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Maximum supply
          <select
            aria-label="Printr maximum supply"
            value={printr.maxSupply}
            onChange={(event) =>
              update({
                maxSupply: event.target.value as PrintrSettings['maxSupply'],
              })
            }
          >
            {PRINTR_SUPPLIES.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label htmlFor="printr-initial-cap">
          Initial market cap (USD, optional)
          <Input
            id="printr-initial-cap"
            inputMode="decimal"
            placeholder="Venue default"
            value={printr.initialMarketCapUsd}
            onChange={(event) =>
              update({ initialMarketCapUsd: event.target.value })
            }
          />
        </label>
        <label htmlFor="printr-before-fee">
          Dev fee before migration (%)
          <Input
            id="printr-before-fee"
            inputMode="decimal"
            value={printr.beforeMigrationFeePercent}
            onChange={(event) =>
              update({ beforeMigrationFeePercent: event.target.value })
            }
          />
        </label>
        <label htmlFor="printr-after-fee">
          Dev fee after migration (%)
          <Input
            id="printr-after-fee"
            inputMode="decimal"
            value={printr.afterMigrationFeePercent}
            onChange={(event) =>
              update({ afterMigrationFeePercent: event.target.value })
            }
          />
        </label>
        <p>
          Before migration: 0.01% to 1.5%. After migration: 0.01% to 1.4%. Use
          at most two decimal places. Initial market cap must be at least
          $5,000; leave it empty for the venue default curve ratio.
        </p>
      </div>
      <p className="source-note">
        Saving these launch settings does not create a token or activate a fee
        destination.
      </p>
    </section>
  );
}
