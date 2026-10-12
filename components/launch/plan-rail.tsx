'use client';

import { GitBranch, Rocket, TriangleAlert } from 'lucide-react';
import { useConnectedWallet } from '@solana/kit-plugin-wallet/react';
import { useAppClient } from '@/components/solana-provider';
import { canUseDevnetTools } from '@/lib/workspace-capabilities';
import { launchModeLabel, type LaunchPlanInput } from '@/lib/launch-plan';

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
  const wallet = useConnectedWallet(client);
  const connectedWallet = canUseDevnetTools(plan.chain) ? wallet : null;
  const hasTokenMetadata = Boolean(plan.tokenName && plan.ticker && !(plan.tokenName === 'Untitled Plan' && plan.ticker === 'TOKEN'));
  const gates = [
    ['Venue profile', `${plan.chain} / ${plan.launchpad}`, true],
    ['Token metadata', hasTokenMetadata ? `${plan.tokenName} · $${plan.ticker}` : 'Replace the draft defaults', hasTokenMetadata],
    ['Validated plan', validationError ?? `${launchModeLabel(plan.mode)} · ${plan.holderCount} scenario recipients`, !validationError],
    ['Saved plan', savedAt ? `Saved ${new Date(savedAt).toLocaleString()}` : persistenceState === 'auth' ? 'Sign-in required' : 'Unsaved changes', Boolean(savedAt)],
    ['Devnet wallet', connectedWallet ? `${connectedWallet.account.address.slice(0, 5)}…${connectedWallet.account.address.slice(-5)}` : plan.chain !== 'Solana' ? 'Unavailable for this chain' : 'Not connected', Boolean(connectedWallet)],
    ['Devnet signer', connectedWallet?.signer ? 'Wallet approval available' : 'Locked', Boolean(connectedWallet?.signer)],
  ] as const;
  const passedCount = gates.filter(([, , passed]) => passed).length;

  return <div className="insights-scroll plan-rail">
    <section className="plan-score"><span><Rocket /></span><div><small>PLAN CHECKLIST</small><strong>{savedAt ? 'PLAN SAVED' : 'DRAFT PLAN'}</strong></div><em>{passedCount} / {gates.length} complete</em></section>
    <section className="plan-gates"><h2>Readiness checks</h2>{gates.map(([label, value, passed]) => <div key={label}><i className={passed ? 'passed' : ''}>{passed ? '✓' : '—'}</i><span><strong>{label}</strong><small>{value}</small></span></div>)}</section>
    <section className="architecture-map"><h2><GitBranch /> Product flow</h2><div><span>Venue profile</span><b>→</b><span>Role planner</span><b>→</b><span>Funding review</span><b>→</b><span>Devnet distro</span><b>→</b><span>Ops preview</span></div></section>
    <div className="execution-note"><TriangleAlert /><p><strong>Network boundary.</strong> Private keys stay in your wallet app or encrypted browser vault. Connected-wallet SPL transfers are devnet-only; mainnet launch and trading remain locked.</p></div>
  </div>;
}
