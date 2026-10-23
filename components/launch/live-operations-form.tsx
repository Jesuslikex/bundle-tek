'use client';

import { Activity, BarChart3, Bot, LockKeyhole } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { LaunchPlanInput } from '@/lib/launch-plan';
import { LiquidityPoolPanel } from '@/components/liquidity-pool-panel';
import { PonsLaunchPanel } from '@/components/pons-launch-panel';
import { ClankerLaunchPanel } from '@/components/clanker-launch-panel';

export function LiveOperationsForm({
  plan,
  onOpenSimulation,
}: {
  plan: LaunchPlanInput;
  onOpenSimulation: () => void;
}) {
  const hasTransactionPanel =
    (plan.chain === 'Base' &&
      (plan.launchpad === 'Clanker' || plan.launchpad === 'Bankr')) ||
    (plan.chain === 'Robinhood' && plan.launchpad === 'pons.family') ||
    ((plan.chain === 'Ethereum' || plan.chain === 'Robinhood') &&
      plan.launchpad === 'Uniswap V2');
  return (
    <div className="settings-scroll launch-flow-scroll">
      <div className="page-title">
        <span className="eyebrow">
          <Activity /> OPERATIONS / PREVIEW
        </span>
        <h1>{plan.tokenName || 'Token'} Operations Preview</h1>
        <p>
          {hasTransactionPanel ? 'Use the available venue tools below. ' : ''}
          This market preview has no connected feed.
          <br />
          {hasTransactionPanel
            ? 'Transaction tools require separate review and wallet confirmation.'
            : 'No transaction tool is available for this selection on this screen.'}
        </p>
      </div>
      <div className="form-body">
        <div className="live-strip">
          <span>
            <small>${plan.ticker || 'TOKEN'}</small>
            <strong>—</strong>
            <em>PRICE</em>
          </span>
          <span>
            <small>Market cap</small>
            <strong>—</strong>
            <em>NO FEED</em>
          </span>
          <span>
            <small>Liquidity</small>
            <strong>—</strong>
            <em>NO FEED</em>
          </span>
          <span>
            <small>Wallet P&amp;L</small>
            <strong>—</strong>
            <em>NO FEED</em>
          </span>
        </div>
        <div className="chart-placeholder">
          <BarChart3 />
          <span>
            <strong>No market feed connected</strong>
            <small>
              Price, trades, wallet attribution, and bonding-curve data are not
              loaded in this preview.
            </small>
          </span>
        </div>
        <div className="boundary-card danger">
          <LockKeyhole />
          <span>
            <strong>
              {hasTransactionPanel
                ? 'Transactions require separate approval'
                : 'Market preview only'}
            </strong>
            <small>
              {hasTransactionPanel
                ? 'The market tiles above are placeholders. Supported transaction panels below require their own review and wallet confirmation. No strategy starts automatically.'
                : 'No transaction tool is available for this chain and launchpad on this screen.'}
            </small>
          </span>
        </div>
        {plan.chain === 'Robinhood' && plan.launchpad === 'pons.family' && (
          <PonsLaunchPanel name={plan.tokenName} symbol={plan.ticker} />
        )}
        {plan.chain === 'Base' &&
          (plan.launchpad === 'Clanker' || plan.launchpad === 'Bankr') && (
            <ClankerLaunchPanel
              key={plan.launchpad}
              name={plan.tokenName}
              symbol={plan.ticker}
              venue={plan.launchpad}
            />
          )}
        {(plan.chain === 'Ethereum' || plan.chain === 'Robinhood') &&
          plan.launchpad === 'Uniswap V2' && (
            <LiquidityPoolPanel chain={plan.chain} />
          )}
        <Button className="flow-next secondary" onClick={onOpenSimulation}>
          Open simulation engine <Bot />
        </Button>
      </div>
    </div>
  );
}
