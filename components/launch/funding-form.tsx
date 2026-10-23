'use client';

import { ChevronDown, Landmark, Shield, WalletCards } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type {
  LaunchPlanInput,
  SimulationSafetyPolicy,
} from '@/lib/launch-plan';
import { WalletConsole } from '@/components/wallet-console';
import { FundingPlanner } from './funding-planner';
import type { LaunchWalletAssignments } from '@/lib/launch-wallets';

type Estimate = {
  scenarioTotal: string;
  supplyCost: string;
  walletReserve: string;
  maximumExposure: string;
};

export function FundingForm({
  plan,
  estimate,
  validationError,
  onChange,
  onNext,
  launchWallets,
}: {
  plan: LaunchPlanInput;
  estimate: Estimate;
  validationError: string | null;
  onChange: (change: Partial<LaunchPlanInput>) => void;
  onNext: () => void;
  launchWallets?: LaunchWalletAssignments;
}) {
  const updateSafety = (change: Partial<SimulationSafetyPolicy>) =>
    onChange({
      simulationSafety: { ...plan.simulationSafety, ...change },
    });
  const safetyFields: Array<{
    key: keyof Pick<
      SimulationSafetyPolicy,
      | 'maxIllustrativeTurnover'
      | 'maxScenarioExposure'
      | 'minimumInventoryReservePercent'
      | 'stopLossPercent'
      | 'maximumDurationMinutes'
    >;
    label: string;
    suffix: string;
    min: number;
    max: number;
  }> = [
    {
      key: 'maxIllustrativeTurnover',
      label: 'Maximum illustrative turnover',
      suffix: plan.currency,
      min: 1,
      max: 1_000_000,
    },
    {
      key: 'maxScenarioExposure',
      label: 'Maximum scenario exposure',
      suffix: plan.currency,
      min: 1,
      max: 1_000_000,
    },
    {
      key: 'minimumInventoryReservePercent',
      label: 'Minimum inventory reserve',
      suffix: '%',
      min: 0,
      max: 100,
    },
    {
      key: 'stopLossPercent',
      label: 'Stop-loss threshold',
      suffix: '%',
      min: 1,
      max: 100,
    },
    {
      key: 'maximumDurationMinutes',
      label: 'Maximum simulation duration',
      suffix: 'MIN',
      min: 1,
      max: 1_440,
    },
  ];
  const roles = [
    [
      'Deployer',
      `${launchWallets?.deployer ? 1 : 0} / 1`,
      'public-address selection',
    ],
    [
      'Scenario recipients',
      `${launchWallets?.recipients.length ?? 0} / ${plan.holderCount}`,
      'public-address selection',
    ],
  ] as const;
  return (
    <div className="settings-scroll launch-flow-scroll">
      <div className="page-title">
        <span className="eyebrow">
          <Landmark /> LAUNCH PLAN / STEP 04
        </span>
        <h1>Wallet &amp; funding</h1>
        <p>
          {plan.chain === 'Solana'
            ? 'Devnet tools and individually reviewed mainnet funding are available below. Mainnet transfers need a saved plan and separate wallet approval; nothing is sent automatically.'
            : `${plan.chain} funding is a planning profile on this screen. Supported wallet and launch actions have their own reviews in Operations.`}
        </p>
      </div>
      <div className="form-body">
        <FundingPlanner plan={plan} launchWallets={launchWallets} />
        {plan.chain === 'Solana' ? (
          <WalletConsole />
        ) : (
          <div className="boundary-card">
            <WalletCards />
            <span>
              <strong>{plan.chain} funding is planning-only here</strong>
              <small>
                Supported launch wallet actions have their own reviews in
                Operations. This page&apos;s wallet verification tool uses
                Solana devnet.
              </small>
            </span>
          </div>
        )}
        <h2 className="funding-section-title">Funding scenario</h2>
        <div className="funding-banner">
          <span>
            <small>
              {validationError
                ? 'PLAN VALIDATION REQUIRED'
                : 'ILLUSTRATIVE FUNDING SCENARIO'}
            </small>
            <strong>
              {validationError
                ? '—'
                : `${estimate.scenarioTotal} ${plan.chain === 'Solana' ? 'SOL' : plan.currency}`}
            </strong>
          </span>
          <em>{validationError ? 'INVALID PLAN' : 'NO LIVE QUOTE'}</em>
        </div>
        <details className="progressive-section">
          <summary>Scenario limits &amp; role breakdown</summary>
          <section className="safety-policy-card">
            <header>
              <span>
                <Shield /> Simulation Safety Policy
              </span>
              <b>ENFORCED ON SAVE</b>
            </header>
            <div className="safety-policy-grid">
              {safetyFields.map(({ key, label, suffix, min, max }) => (
                <label key={key}>
                  <span>{label}</span>
                  <span className="number-wrap">
                    <Input
                      type="number"
                      min={min}
                      max={max}
                      value={plan.simulationSafety[key]}
                      onChange={(event) =>
                        updateSafety({ [key]: Number(event.target.value) })
                      }
                    />
                    <b>{suffix}</b>
                  </span>
                </label>
              ))}
            </div>
            <div className="safety-invariants">
              <span>
                <i>✓</i> Scenario limits do not authorize transactions
              </span>
              <span>
                <i>✓</i> Artificial volume prohibited
              </span>
              <span>
                <i>✓</i> Holder farming prohibited
              </span>
            </div>
          </section>
          <div className="role-table">
            <header>
              <span>ROLE</span>
              <span>WALLETS</span>
              <span>STATE</span>
            </header>
            {roles.map(([role, count, state]) => (
              <div key={role}>
                <span>
                  <WalletCards />
                  {role}
                </span>
                <b>{count}</b>
                <em className="muted">{state}</em>
              </div>
            ))}
          </div>
        </details>
        <Button
          className="flow-next"
          disabled={plan.chain !== 'Solana'}
          onClick={onNext}
        >
          {plan.chain === 'Solana'
            ? 'Build devnet distribution manifest'
            : 'Switch to Solana for devnet tools'}{' '}
          <ChevronDown />
        </Button>
      </div>
    </div>
  );
}
