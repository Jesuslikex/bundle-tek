'use client';

import { Activity, BarChart3, Bot, LockKeyhole } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { LaunchPlanInput } from '@/lib/launch-plan';
import { LiquidityPoolPanel } from '@/components/liquidity-pool-panel';
import { PonsLaunchPanel } from '@/components/pons-launch-panel';
import { ClankerLaunchPanel } from '@/components/clanker-launch-panel';

export function LiveOperationsForm({ plan, onOpenSimulation }: { plan: LaunchPlanInput; onOpenSimulation: () => void }) {
  return <div className="settings-scroll launch-flow-scroll">
    <div className="page-title"><span className="eyebrow"><Activity /> OPERATIONS / PREVIEW</span><h1>{plan.tokenName || 'Token'} Operations Preview</h1><p>This area shows the monitoring surface planned for a connected market feed.<br />It does not currently monitor or control a live market.</p></div>
    <div className="form-body">
      <div className="live-strip"><span><small>${plan.ticker || 'TOKEN'}</small><strong>—</strong><em>PRICE</em></span><span><small>Market cap</small><strong>—</strong><em>NO FEED</em></span><span><small>Liquidity</small><strong>—</strong><em>NO FEED</em></span><span><small>Wallet P&amp;L</small><strong>—</strong><em>LOCKED</em></span></div>
      <div className="chart-placeholder"><BarChart3 /><span><strong>No market feed connected</strong><small>Price, trades, wallet attribution, and bonding-curve data are unavailable in this build.</small></span></div>
      <div className="boundary-card danger"><LockKeyhole /><span><strong>Mainnet market execution is locked</strong><small>Devnet wallet verification and SPL distribution are separate tools; no trade or launch order submitter exists.</small></span></div>
      {plan.chain === 'Robinhood' && plan.launchpad === 'pons.family' && <PonsLaunchPanel name={plan.tokenName} symbol={plan.ticker} />}
      {plan.chain === 'Base' && (plan.launchpad === 'Clanker' || plan.launchpad === 'Bankr') && <ClankerLaunchPanel key={plan.launchpad} name={plan.tokenName} symbol={plan.ticker} venue={plan.launchpad} />}
      {(plan.chain === 'Ethereum' || plan.chain === 'Robinhood') && plan.launchpad === 'Uniswap V2' && <LiquidityPoolPanel chain={plan.chain} />}
      <Button className="flow-next secondary" onClick={onOpenSimulation}>Open simulation engine <Bot /></Button>
    </div>
  </div>;
}
