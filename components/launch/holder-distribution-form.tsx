'use client';
import type { LaunchPlanInput } from '@/lib/launch-plan';
import type { LaunchWalletAssignments } from '@/lib/launch-wallets';
import { previewHolderDistribution } from '@/lib/launch-distribution';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

export function HolderDistributionForm({
  plan,
  selection,
  onChange,
}: {
  plan: LaunchPlanInput;
  selection?: LaunchWalletAssignments;
  onChange: (change: Partial<LaunchPlanInput>) => void;
}) {
  const config = plan.holdersDistribution;
  let preview: ReturnType<typeof previewHolderDistribution> = null,
    error = '';
  try {
    preview = previewHolderDistribution(plan);
  } catch (reason) {
    error =
      reason instanceof Error ? reason.message : 'Distribution unavailable.';
  }
  const seed = () => crypto.randomUUID().replaceAll('-', '');
  const zeroCount =
    preview?.items.filter((item) => item.amount === '0').length ?? 0;
  return (
    <section
      className="holder-distribution-form"
      aria-label="Holder buy distribution"
    >
      <h2>
        Holder buy distribution{' '}
        <span className="section-note">Saved planning preview</span>
      </h2>
      {!config ? (
        <>
          <p>
            Configure how the total holders amount is split across the planned
            wallets.
          </p>
          <Button
            variant="outline"
            onClick={() =>
              onChange({
                holdersDistribution: {
                  kind: 'random',
                  deviationPercent: 50,
                  seed: seed(),
                },
              })
            }
          >
            Configure holder distribution
          </Button>
        </>
      ) : (
        <>
          <div className="wallet-roster-actions">
            <label>
              Distribution mode
              <select
                aria-label="Holder distribution mode"
                value={config.kind}
                onChange={(event) =>
                  onChange({
                    holdersDistribution: {
                      ...config,
                      kind: event.target.value as
                        | 'random'
                        | 'single'
                        | 'custom',
                      ...(event.target.value === 'custom'
                        ? {
                            weights:
                              config.weights ??
                              preview?.items.map((item) => item.amount) ??
                              Array.from(
                                { length: plan.holderCount },
                                () => '1',
                              ),
                          }
                        : {}),
                    },
                  })
                }
              >
                <option value="random">Deviation-based split</option>
                <option value="single">One wallet receives all</option>
                <option value="custom">Custom holder weights</option>
              </select>
            </label>
            <label htmlFor="holder-distribution-deviation">
              Deviation from average (%)
              <Input
                id="holder-distribution-deviation"
                aria-label="Holder distribution deviation"
                type="number"
                min={0}
                max={1000000}
                step="any"
                disabled={config.kind !== 'random'}
                value={config.deviationPercent}
                onChange={(event) =>
                  onChange({
                    holdersDistribution: {
                      ...config,
                      deviationPercent: Number(event.target.value),
                    },
                  })
                }
              />
            </label>
          </div>
          <p>
            {config.kind === 'custom'
              ? 'Each weight sets a relative share in holder slot order. The entered total is split exactly in those proportions.'
              : config.kind === 'single'
                ? 'One holder slot receives the entire amount. Other slots receive zero.'
                : config.deviationPercent === 0
                  ? 'Equal split. Rounding remainders go to the earliest holder slots.'
                  : config.deviationPercent > 100
                    ? 'Power-law weights. Higher deviation concentrates more of the total in fewer slots.'
                    : 'Random weights around the average, normalized to the entered total.'}
          </p>
          {config.kind === 'custom' && (
            <label htmlFor="holder-custom-weights">
              Custom weights, one per holder slot
              <textarea
                id="holder-custom-weights"
                aria-label="Custom holder weights"
                rows={Math.min(8, plan.holderCount)}
                value={(config.weights ?? []).join('\n')}
                onChange={(event) =>
                  onChange({
                    holdersDistribution: {
                      ...config,
                      weights: event.target.value.split(/\r?\n/),
                    },
                  })
                }
              />
              <small>
                Use plain non-negative decimals. For example, 1 and 3 allocate
                one quarter and three quarters of the total. Weights stay
                attached to slot order.
              </small>
            </label>
          )}
          <div className="wallet-roster-actions">
            {config.kind === 'custom' && (
              <Button
                variant="outline"
                onClick={() =>
                  onChange({
                    holdersDistribution: {
                      ...config,
                      weights: Array.from(
                        { length: plan.holderCount },
                        () => '1',
                      ),
                    },
                  })
                }
              >
                Reset custom weights to equal
              </Button>
            )}
            <Button
              disabled={config.kind === 'custom'}
              variant="outline"
              onClick={() =>
                onChange({ holdersDistribution: { ...config, seed: seed() } })
              }
            >
              Reshuffle distribution
            </Button>
            <Button
              variant="outline"
              onClick={() =>
                onChange({
                  holdersDistribution: {
                    ...config,
                    kind: 'random',
                    deviationPercent: 0,
                  },
                })
              }
            >
              Equal split
            </Button>
            <Button
              variant="outline"
              onClick={() => onChange({ holdersDistribution: undefined })}
            >
              Remove distribution
            </Button>
          </div>
          {error && <output className="source-note">{error}</output>}
          {preview && (
            <>
              <p className="distribution-total">
                Total:{' '}
                <strong>
                  {preview.total} {preview.unit}
                </strong>{' '}
                across {preview.items.length} holder slots.
              </p>
              {zeroCount > 0 && (
                <p className="source-note">
                  {zeroCount} slots receive zero. Review the amount, precision
                  and distribution before funding.
                </p>
              )}
              <div className="holder-distribution-table">
                <table>
                  <thead>
                    <tr>
                      <th>Holder slot</th>
                      <th>Public address</th>
                      <th>Allocation ({preview.unit})</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.items.map((item) => (
                      <tr key={item.index}>
                        <td>{item.index + 1}</td>
                        <td>
                          {selection?.chain === plan.chain &&
                          selection.recipients[item.index] ? (
                            <code>
                              {selection.recipients[item.index].address}
                            </code>
                          ) : (
                            <span className="muted">Unassigned</span>
                          )}
                        </td>
                        <td>{item.amount}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
          <p className="source-note">
            Saved weights and the seed keep this preview stable. Reshuffle
            changes random modes explicitly. Selected recipients map in their
            retained order; unassigned slots are not generated wallets. These
            allocations do not fund wallets or submit buys.
          </p>
        </>
      )}
    </section>
  );
}
