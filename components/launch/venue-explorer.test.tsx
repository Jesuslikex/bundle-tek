import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, it, expect, vi } from 'vitest';
import { FundingForm } from './funding-form';
import { RobinhoodPlanner } from './robinhood-planner';
import { ChainLaunchForm } from './chain-launch-form';
import { DEFAULT_LAUNCH_PLAN, validateLaunchPlan } from '../../lib/launch-plan';
vi.stubGlobal('React', React);
describe('venue discovery', () => {
  it('offers Robinhood as explicitly planning-only without extending the executable plan contract', () => {
    const html = renderToStaticMarkup(<ChainLaunchForm plan={DEFAULT_LAUNCH_PLAN} onChange={() => {}} onNext={() => {}} />);
    expect(html).toContain('Robinhood');
    expect(html).toContain('Planning only');
    expect(() => validateLaunchPlan({ ...DEFAULT_LAUNCH_PLAN, chain: 'Robinhood', currency: 'ETH' })).toThrow('Unsupported chain');
  });
});

it('renders all eleven observed venues with no wallet actions or invented estimates', () => {
 const html = renderToStaticMarkup(<RobinhoodPlanner venue="hood.fun" onSelect={() => {}} onBack={() => {}} />);
 for (const venue of ['hood.fun', 'pons.family', 'flap.sh', 'stonks.fun', 'pools.trade', 'klik.finance', 'Livo', 'REAL', 'meme.bid', 'Uniswap V2', 'Uniswap V3']) expect(html).toContain(venue);
 expect(html).toContain('No verified adapter');
 expect(html).toContain('Currency not verified');
 expect(html).toContain('No estimate available');
 expect(html).toContain('Return to launch plan');
 expect(html).not.toContain('Connect wallet');
 expect(html).not.toContain(' SOL');
});

it('describes the Pons coordinator without implying signing, broadcast or multi-wallet support', () => {
 const html = renderToStaticMarkup(<RobinhoodPlanner venue="pons.family" onSelect={() => {}} onBack={() => {}} />);
 expect(html).toContain('Pons V2 coordinator');
 expect(html).toContain('single-recipient atomic');
 expect(html).toContain('unsigned');
 expect(html).toContain('Mainnet gate locked');
 expect(html).not.toContain('multi-wallet');
 expect(html).not.toContain('Block-0');
});

it('progressively discloses the funding scenario and blocks non-Solana distribution', () => {
 const html = renderToStaticMarkup(<FundingForm plan={{ ...DEFAULT_LAUNCH_PLAN, chain: 'Base', launchpad: 'Clanker', currency: 'Base' }} estimate={{ scenarioTotal: '0', supplyCost: '0', walletReserve: '0', maximumExposure: '0' }} validationError={null} onChange={() => {}} onNext={() => {}} />);
 expect(html).toContain('<details');
 expect(html).toContain('Scenario limits &amp; role breakdown');
 expect(html).toContain('Switch to Solana for devnet tools');
 expect(html).not.toContain('Connect your devnet wallet');
 expect(html).not.toContain('Front route');
 expect(html).not.toContain('Temporary holders');
});

it('offers address-only read-only inspection with source and no wallet connection', () => {
 const html = renderToStaticMarkup(<RobinhoodPlanner venue="hood.fun" onSelect={() => {}} onBack={() => {}} />);
 expect(html).toContain('Inspect existing token');
 expect(html).toContain('Token contract address');
 expect(html).toContain('Metadata only');
 expect(html).not.toContain('inspection is unavailable');
});
