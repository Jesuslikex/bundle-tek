'use client';

import { ChevronDown, CircleDollarSign, LockKeyhole, Network, Rocket } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  CHAINS,
  CURRENCIES_BY_CHAIN,
  VENUES_BY_CHAIN,
  type LaunchChain,
  type LaunchPlanInput,
} from '@/lib/launch-plan';

export function ChainLaunchForm({
  plan,
  onChange,
  onNext,
}: {
  plan: LaunchPlanInput;
  onChange: (change: Partial<LaunchPlanInput>) => void;
  onNext: () => void;
}) {
  const chooseChain = (chain: LaunchChain) => onChange({
    chain,
    launchpad: VENUES_BY_CHAIN[chain][0],
    currency: CURRENCIES_BY_CHAIN[chain][0],
  });

  return <div className="settings-scroll launch-flow-scroll">
    <div className="page-title"><span className="eyebrow"><Network /> LAUNCH PLAN / STEP 01</span><h1>Chain &amp; Launchpad</h1><p>Choose the execution profile and planned venue.<br />Every later constraint derives from this selection.</p></div>
    <div className="form-body">
      <div className="flow-section-title"><Network /> Blockchain profile</div>
      <div className="chain-grid">{CHAINS.map((chain) => <button type="button" key={chain} onClick={() => chooseChain(chain)} className={plan.chain === chain ? 'active' : ''}><span className={`chain-orb ${chain.toLowerCase()}`}>{chain.slice(0, 1)}</span><span><strong>{chain}</strong><small>{VENUES_BY_CHAIN[chain].length} planned venues</small></span><b>{plan.chain === chain ? 'SELECTED' : 'PLANNED'}</b></button>)}</div>
      <div className="flow-section-title"><Rocket /> Planned venue</div>
      <div className="venue-grid">{VENUES_BY_CHAIN[plan.chain].map((venue) => <button type="button" key={venue} onClick={() => onChange({ launchpad: venue })} className={plan.launchpad === venue ? 'active' : ''}><Rocket /><span><strong>{venue}</strong><small>{plan.chain} venue profile</small></span></button>)}</div>
      <div className="flow-section-title"><CircleDollarSign /> Quote currency</div>
      <div className="currency-row">{CURRENCIES_BY_CHAIN[plan.chain].map((currency) => <button type="button" key={currency} onClick={() => onChange({ currency })} className={plan.currency === currency ? 'active' : ''}>{currency}<small>{currency === 'USDC' ? 'stable quote' : 'native quote'}</small></button>)}</div>
      <div className="boundary-card"><LockKeyhole /><span><strong>Venue profile selected, launch adapter unavailable</strong><small>Solana wallet verification is available in Funding; mint creation and launch submission remain locked.</small></span></div>
      <Button className="flow-next" onClick={onNext}>Configure token <ChevronDown /></Button>
    </div>
  </div>;
}
