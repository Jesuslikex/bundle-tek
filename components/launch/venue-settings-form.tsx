'use client';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { PrintrSettingsForm } from './printr-settings-form';
import type { LaunchPlanInput } from '@/lib/launch-plan';
import {
  updatePumpfun,
  pumpCreatorFeeEligible,
  percentToBasisPoints,
  type VenueSettings,
} from '@/lib/venue-settings';
export function VenueSettingsForm({
  plan,
  settings,
  onChange,
}: {
  plan: LaunchPlanInput;
  settings: VenueSettings;
  onChange: (settings: VenueSettings) => void;
}) {
  const isPump = plan.chain === 'Solana' && plan.launchpad === 'PumpFun';
  const isFlap = ['Flap', 'flap.sh'].includes(plan.launchpad);
  if (plan.chain === 'Solana' && plan.launchpad === 'Printr')
    return <PrintrSettingsForm settings={settings} onChange={onChange} />;
  if (!isPump && !isFlap) return null;
  const pump = settings.pumpfun;
  const update = (change: Partial<typeof pump>) =>
    onChange({ ...settings, pumpfun: updatePumpfun(pump, change) });
  return (
    <section className="venue-options detailed-venue-settings">
      <h2>
        {plan.launchpad} settings <span>Saved with your project</span>
      </h2>
      {isPump ? (
        <>
          {pumpCreatorFeeEligible(plan) ? (
            <div className="fee-share-editor pump-creator-fee-editor">
              <label>
                Creator fee mode
                <select
                  aria-label="PumpFun creator fee mode"
                  value={
                    pump.creatorFeePercent === undefined ? 'default' : 'custom'
                  }
                  onChange={(e) =>
                    update({
                      creatorFeePercent:
                        e.target.value === 'custom' ? '1' : undefined,
                    })
                  }
                >
                  <option value="default">PumpFun default</option>
                  <option value="custom">Custom creator fee</option>
                </select>
              </label>
              {pump.creatorFeePercent !== undefined && (
                <label htmlFor="pump-creator-fee">
                  Creator fee (%)
                  <Input
                    id="pump-creator-fee"
                    inputMode="decimal"
                    value={pump.creatorFeePercent}
                    onChange={(e) =>
                      update({ creatorFeePercent: e.target.value })
                    }
                  />
                </label>
              )}
              <p>
                Custom fees range from 0.01% to 3%, with at most two decimal
                places. Default leaves the rate to PumpFun. Fee sharing divides
                creator fees separately.
              </p>
            </div>
          ) : (
            <p>
              Custom creator fees need a captured PumpFun quote other than SOL
              or canonical USDC.
            </p>
          )}
          {(
            [
              {
                key: 'holderRewards',
                name: 'Holder rewards',
                description:
                  'Enabling this clears offchain creation and fee sharing.',
              },
              {
                key: 'offchainCreation',
                name: 'Offchain creation',
                description: 'Enabling this disables holder rewards.',
              },
              {
                key: 'feeSharing',
                name: 'Creator fee sharing',
                description:
                  'Allocate 100% of creator fees to public recipient addresses.',
              },
            ] as const
          ).map(({ key, name, description }) => (
            <label key={key} className="option-switch" htmlFor={`pump-${key}`}>
              <span>
                <strong>{name}</strong>
                <small>{description}</small>
              </span>
              <Switch
                id={`pump-${key}`}
                aria-label={name}
                checked={pump[key]}
                onCheckedChange={(value) => update({ [key]: value })}
              />
            </label>
          ))}
          {pump.feeSharing && (
            <div className="fee-share-editor">
              <p>
                Percentages are shares of creator fees, not a token tax. Up to
                10 public-address recipients.
              </p>
              {pump.feeShares.map((share, index) => (
                <div className="fee-share-row" key={index}>
                  <label htmlFor={`fee-address-${index}`}>
                    Recipient {index + 1}
                    <Input
                      id={`fee-address-${index}`}
                      value={share.address}
                      placeholder="Solana public address"
                      onChange={(e) =>
                        update({
                          feeShares: pump.feeShares.map((s, i) =>
                            i === index ? { ...s, address: e.target.value } : s,
                          ),
                        })
                      }
                    />
                  </label>
                  <label htmlFor={`fee-share-${index}`}>
                    Share (%)
                    <Input
                      id={`fee-share-${index}`}
                      type="number"
                      step="0.01"
                      min="0.01"
                      max="100"
                      value={share.shareBps / 100}
                      onChange={(e) =>
                        update({
                          feeShares: pump.feeShares.map((s, i) =>
                            i === index
                              ? {
                                  ...s,
                                  shareBps: percentToBasisPoints(
                                    e.target.value,
                                  ),
                                }
                              : s,
                          ),
                        })
                      }
                    />
                  </label>
                  <Button
                    variant="outline"
                    aria-label={`Remove fee recipient ${index + 1}`}
                    onClick={() =>
                      update({
                        feeShares: pump.feeShares.filter((_, i) => i !== index),
                      })
                    }
                  >
                    Remove
                  </Button>
                </div>
              ))}
              <div className="fee-share-summary">
                <span>
                  Total:{' '}
                  {(
                    pump.feeShares.reduce((sum, s) => sum + s.shareBps, 0) / 100
                  ).toFixed(2)}
                  %
                </span>
                <Button
                  variant="outline"
                  disabled={pump.feeShares.length >= 10}
                  onClick={() =>
                    update({
                      feeShares: [
                        ...pump.feeShares,
                        {
                          address: '',
                          shareBps: pump.feeShares.length ? 0 : 10000,
                        },
                      ],
                    })
                  }
                >
                  Add fee recipient
                </Button>
              </div>
            </div>
          )}
        </>
      ) : (
        <div className="flap-tax-grid">
          {(['buyTaxPercent', 'sellTaxPercent'] as const).map((key) => (
            <label key={key} htmlFor={`flap-${key}`}>
              {key === 'buyTaxPercent' ? 'Buy tax (%)' : 'Sell tax (%)'}
              <Input
                id={`flap-${key}`}
                type="number"
                min={0}
                max={10}
                step="0.01"
                value={settings.flap[key]}
                onChange={(e) =>
                  onChange({
                    ...settings,
                    flap: { ...settings.flap, [key]: Number(e.target.value) },
                  })
                }
              />
            </label>
          ))}
          <p>
            Each tax can be 0 to 10%. At least one must be greater than zero.
          </p>
        </div>
      )}
      <p className="source-note">
        These are launch configuration fields. Saving a draft does not deploy a
        token.
      </p>
    </section>
  );
}
