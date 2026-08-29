'use client';

import { Activity, ArrowDownUp, BarChart3, Bot, Flame, LockKeyhole, Pause, Play, RefreshCw, Target, TimerReset } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { LaunchPlanInput } from '@/lib/launch-plan';

export function LiveOperationsForm({ plan, onOpenSimulation }: { plan: LaunchPlanInput; onOpenSimulation: () => void }) {
  const automations = [
    ['Counter-flow', 'React to measured external flow', ArrowDownUp],
    ['Time-based', 'Fixed or randomized review intervals', TimerReset],
    ['Threshold orders', 'Scenario triggers at market-cap levels', Target],
    ['Cleanup planner', 'Model redistribution rounds', RefreshCw],
  ] as const;
  return <div className="settings-scroll launch-flow-scroll">
    <div className="page-title"><span className="eyebrow"><Activity /> OPERATIONS / LIVE PREVIEW</span><h1>{plan.tokenName || 'Token'} Control Room</h1><p>A unified view for monitoring, response planning, and audit history.<br />Every execution control remains disabled.</p></div>
    <div className="form-body">
      <div className="live-strip"><span><small>${plan.ticker || 'TOKEN'}</small><strong>—</strong><em>PRICE</em></span><span><small>Market cap</small><strong>—</strong><em>NO FEED</em></span><span><small>Liquidity</small><strong>—</strong><em>NO FEED</em></span><span><small>Wallet P&amp;L</small><strong>—</strong><em>LOCKED</em></span></div>
      <div className="chart-placeholder"><BarChart3 /><span><strong>Live indexer not connected</strong><small>Price, trade feed, wallet attribution, and bonding-curve overlays will appear here.</small></span></div>
      <div className="automation-grid">{automations.map(([name, copy, Icon]) => <button type="button" disabled key={name}><Icon /><span><strong>{name}</strong><small>{copy}</small></span><em>PLAN</em></button>)}</div>
      <div className="live-actions"><Button disabled><Play /> Start automation</Button><Button variant="outline" disabled><Pause /> Pause</Button><Button variant="outline" disabled><Flame /> Emergency exit</Button></div>
      <div className="boundary-card danger"><LockKeyhole /><span><strong>Execution lock is enforced</strong><small>No wallet signer, transaction builder, private RPC, or order submitter exists in this deployment.</small></span></div>
      <Button className="flow-next secondary" onClick={onOpenSimulation}>Open simulation engine <Bot /></Button>
    </div>
  </div>;
}
