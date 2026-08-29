'use client';

import { ChevronDown, Database, Landmark, Shield, WalletCards } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { LaunchPlanInput, SimulationSafetyPolicy } from '@/lib/launch-plan';
import { WalletConsole } from '@/components/wallet-console';

type Estimate = { scenarioTotal: string; supplyCost: string; walletReserve: string; maximumExposure: string };

export function FundingForm({
  plan,
  estimate,
  validationError,
  onChange,
  onNext,
}: {
  plan: LaunchPlanInput;
  estimate: Estimate;
  validationError: string | null;
  onChange: (change: Partial<LaunchPlanInput>) => void;
  onNext: () => void;
}) {
  const updateSafety = (change: Partial<SimulationSafetyPolicy>) => onChange({
    simulationSafety: { ...plan.simulationSafety, ...change },
  });
  const safetyFields: Array<{
    key: keyof Pick<SimulationSafetyPolicy, "maxIllustrativeTurnover" | "maxScenarioExposure" | "minimumInventoryReservePercent" | "stopLossPercent" | "maximumDurationMinutes">;
    label: string; suffix: string; min: number; max: number;
  }> = [
    { key: "maxIllustrativeTurnover", label: "Maximum illustrative turnover", suffix: "SOL", min: 1, max: 1_000_000 },
    { key: "maxScenarioExposure", label: "Maximum scenario exposure", suffix: "SOL", min: 1, max: 1_000_000 },
    { key: "minimumInventoryReservePercent", label: "Minimum inventory reserve", suffix: "%", min: 0, max: 100 },
    { key: "stopLossPercent", label: "Stop-loss threshold", suffix: "%", min: 1, max: 100 },
    { key: "maximumDurationMinutes", label: "Maximum simulation duration", suffix: "MIN", min: 1, max: 1_440 },
  ];
  const roles = [
    ['Deployer', 1, 'required'],
    ['Holders', plan.holderCount, 'planned'],
    ['Front route', plan.mode === 'Block-0' ? 5 : 0, plan.mode === 'Block-0' ? 'planned' : 'unused'],
    ['Back route', plan.mode === 'Block-0' ? 17 : 0, plan.mode === 'Block-0' ? 'planned' : 'unused'],
    ['Temporary holders', plan.mode === 'Block-0' ? 24 : 0, plan.mode === 'Block-0' ? 'planned' : 'unused'],
  ] as const;
  return <div className="settings-scroll launch-flow-scroll">
    <div className="page-title"><span className="eyebrow"><Landmark /> LAUNCH PLAN / STEP 04</span><h1>Funding &amp; Wallet Roles</h1><p>Translate allocation into a reviewable funding graph.<br />No private keys or deposits are accepted by this build.</p></div>
    <div className="form-body">
      <div className="funding-banner"><span><small>{validationError ? 'PLAN VALIDATION REQUIRED' : 'ILLUSTRATIVE FUNDING SCENARIO'}</small><strong>{validationError ? '—' : `${estimate.scenarioTotal} ${plan.chain === 'Solana' ? 'SOL' : plan.currency}`}</strong></span><em>{validationError ? 'INVALID PLAN' : 'NO LIVE QUOTE'}</em></div>
      <section className="safety-policy-card">
        <header><span><Shield /> Simulation Safety Policy</span><b>ENFORCED ON SAVE</b></header>
        <div className="safety-policy-grid">{safetyFields.map(({ key, label, suffix, min, max }) => <label key={key}><span>{label}</span><span className="number-wrap"><Input type="number" min={min} max={max} value={plan.simulationSafety[key]} onChange={(event) => updateSafety({ [key]: Number(event.target.value) })} /><b>{suffix}</b></span></label>)}</div>
        <div className="safety-invariants"><span><i>✓</i> Execution permanently disabled</span><span><i>✓</i> Artificial volume prohibited</span><span><i>✓</i> Holder farming prohibited</span></div>
      </section>
      {plan.chain === 'Solana' ? <WalletConsole /> : <div className="boundary-card"><WalletCards /><span><strong>{plan.chain} wallet integration is planned</strong><small>The first reviewed wallet and transaction pipeline is restricted to Solana devnet.</small></span></div>}
      <div className="role-table"><header><span>ROLE</span><span>WALLETS</span><span>STATE</span></header>{roles.map(([role, count, state]) => <div key={role}><span><WalletCards />{role}</span><b>{count}</b><em className={state === 'unused' ? 'muted' : ''}>{state}</em></div>)}</div>
      <div className="funding-options"><button type="button" disabled><Database /><span><strong>Direct funder</strong><small>One audited funding source</small></span><b>NOT CONNECTED</b></button><button type="button" disabled><Landmark /><span><strong>Husher integration design</strong><small>Quote → one-time deposit → settlement</small></span><b>ACCESS REQUIRED</b></button></div>
      <div className="provider-contract"><header><span><Landmark /> Husher integration contract</span><b>DESIGN</b></header><div><span>Quote</span><small>Provider, route, fees, minimum, expiry</small></div><div><span>Order</span><small>One-time deposit address and destination set</small></div><div><span>Status</span><small>Awaiting deposit → exchanging → settled / failed</small></div><div><span>Reconcile</span><small>Input amount, output amount, transaction evidence</small></div><p>Husher documents selective partner API access; technical endpoints are not public yet.</p></div>
      <div className="guard-card"><Shield /><span><strong>External-flow guard</strong><small>Planned control: pause simulated buys when outside activity exceeds a reviewed threshold.</small></span><em>DESIGN ONLY</em></div>
      <Button className="flow-next" onClick={onNext}>Preview live operations <ChevronDown /></Button>
    </div>
  </div>;
}
