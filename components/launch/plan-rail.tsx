'use client';

import { GitBranch, Rocket, TriangleAlert } from 'lucide-react';
import { useConnectedWallet } from '@solana/kit-plugin-wallet/react';
import { useAppClient } from '@/components/solana-provider';
import type { LaunchPlanInput } from '@/lib/launch-plan';

export function PlanRail({
  plan,
  savedAt,
  persistenceState,
  validationError,
}: {
  plan: LaunchPlanInput;
  savedAt: string | null;
  persistenceState: 'loading' | 'ready' | 'saving' | 'auth' | 'error';
  validationError: string | null;
}) {
  const client = useAppClient();
  const connectedWallet = useConnectedWallet(client);
  const gates = [
    ['Venue profile', `${plan.chain} / ${plan.launchpad}`, true],
    ['Token metadata', plan.tokenName && plan.ticker ? `${plan.tokenName} · $${plan.ticker}` : 'Incomplete', Boolean(plan.tokenName && plan.ticker)],
    ['Validated plan', validationError ?? `${plan.mode} · ${plan.holderCount} holders`, !validationError],
    ['D1 persistence', savedAt ? `Saved ${new Date(savedAt).toLocaleString()}` : persistenceState === 'auth' ? 'Sign-in required' : 'Unsaved changes', Boolean(savedAt)],
    ['Devnet wallet', connectedWallet ? `${connectedWallet.account.address.slice(0, 5)}…${connectedWallet.account.address.slice(-5)}` : 'Not connected', Boolean(connectedWallet)],
    ['Devnet signer', connectedWallet?.signer ? 'Wallet approval available' : 'Locked', Boolean(connectedWallet?.signer)],
  ] as const;
  const passedCount = gates.filter(([, , passed]) => passed).length;

  return <div className="insights-scroll plan-rail">
    <section className="plan-score"><span><Rocket /></span><div><small>LAUNCH READINESS</small><strong>{savedAt ? 'PLAN SAVED' : 'PLAN ONLY'}</strong></div><em>{passedCount} / {gates.length} gates</em></section>
    <section className="plan-gates"><h2>Execution gates</h2>{gates.map(([label, value, passed]) => <div key={label}><i className={passed ? 'passed' : ''}>{passed ? '✓' : '—'}</i><span><strong>{label}</strong><small>{value}</small></span></div>)}</section>
    <section className="architecture-map"><h2><GitBranch /> Orchestration map</h2><div><span>Venue profile</span><b>→</b><span>Role planner</span><b>→</b><span>Funding design</span><b>→</b><span>Execution gate</span><b>→</b><span>Live ops</span></div></section>
    <div className="execution-note"><TriangleAlert /><p><strong>Simulation boundary.</strong> Private keys, deposits, signing, routing, and live execution are intentionally absent.</p></div>
  </div>;
}
