'use client';

import { useState } from 'react';
import { ArrowRight, ExternalLink, Network } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Switch } from '@/components/ui/switch';
import {
  CHAINS,
  VENUES_BY_CHAIN,
  currenciesForVenue,
  type LaunchChain,
  type LaunchPlanInput,
} from '@/lib/launch-plan';
import {
  DEFAULT_VENUE_OPTIONS,
  type VenueOptions,
} from '@/lib/workspace-project';

export function ChainLaunchForm({
  plan,
  onChange,
  onNext,
  onExploreRobinhood,
  options = DEFAULT_VENUE_OPTIONS,
  onOptionsChange,
  validationError,
}: {
  plan: LaunchPlanInput;
  onChange: (change: Partial<LaunchPlanInput>) => void;
  onNext: () => void;
  onExploreRobinhood?: () => void;
  options?: VenueOptions;
  onOptionsChange?: (change: Partial<VenueOptions>) => void;
  validationError?: string | null;
}) {
  const [quoteSearch, setQuoteSearch] = useState('');
  const chooseChain = (chain: LaunchChain) => {
    setQuoteSearch('');
    const launchpad = VENUES_BY_CHAIN[chain][0];
    onChange({
      chain,
      launchpad,
      currency: currenciesForVenue(chain, launchpad)[0],
    });
  };
  const chooseVenue = (launchpad: string) => {
    setQuoteSearch('');
    onChange({
      launchpad,
      currency: currenciesForVenue(plan.chain, launchpad)[0],
    });
  };
  const currencies = currenciesForVenue(plan.chain, plan.launchpad);
  const filteredCurrencies = currencies.filter((c) =>
    c.toLowerCase().includes(quoteSearch.toLowerCase()),
  );
  return (
    <div className="settings-scroll launch-flow-scroll">
      <div className="page-title">
        <span className="eyebrow">CREATE LAUNCH / 01</span>
        <h1>Create a new launch</h1>
        <p>Choose a chain and launchpad, then configure your token.</p>
      </div>
      <div className="form-body">
        {validationError && (
          <p role="alert" className="draft-error">
            {validationError}
          </p>
        )}
        <h2 className="flow-section-title">
          Blockchain <span className="section-note">Planning profiles</span>
        </h2>
        <RadioGroup
          value={plan.chain}
          onValueChange={(value) => chooseChain(value as LaunchChain)}
          aria-label="Blockchain"
          className="reference-chain-grid"
        >
          {CHAINS.map((chain) => (
            <label
              key={chain}
              className={`selection-card chain-choice ${plan.chain === chain ? 'selected' : ''}`}
              data-chain={chain}
            >
              <RadioGroupItem
                value={chain}
                aria-label={chain === 'BNB' ? 'BNB Smart Chain' : chain}
              />
              <span
                className={`chain-symbol chain-${chain.toLowerCase()}`}
                aria-hidden="true"
              >
                {chain === 'Solana'
                  ? '≋'
                  : chain === 'Ethereum'
                    ? 'Ξ'
                    : chain.slice(0, 1)}
              </span>
              <span>
                <strong>{chain === 'BNB' ? 'BNB Smart Chain' : chain}</strong>
                <small>{VENUES_BY_CHAIN[chain].length} launchpads</small>
              </span>
            </label>
          ))}
        </RadioGroup>
        <h2 className="flow-section-title">
          Launchpad <span className="section-note">{plan.chain}</span>
        </h2>
        <RadioGroup
          value={plan.launchpad}
          onValueChange={(value) => chooseVenue(String(value))}
          aria-label="Launchpad"
          className="reference-venue-grid"
        >
          {VENUES_BY_CHAIN[plan.chain].map((venue) => (
            <label
              className={`selection-card venue-choice ${plan.launchpad === venue ? 'selected' : ''}`}
              key={venue}
            >
              <RadioGroupItem value={venue} aria-label={venue} />
              <span className="venue-initial" aria-hidden="true">
                {venue[0].toUpperCase()}
              </span>
              <strong>{venue}</strong>
            </label>
          ))}
        </RadioGroup>
        <h2 className="flow-section-title">
          {plan.launchpad === 'long.xyz'
            ? 'Stock-token quote'
            : 'Quote currency'}{' '}
          <span className="section-note">Draft selection</span>
        </h2>
        {currencies.length > 8 && (
          <Input
            aria-label="Search quote currencies"
            placeholder="Search symbol…"
            value={quoteSearch}
            onChange={(e) => setQuoteSearch(e.target.value)}
          />
        )}
        <RadioGroup
          className="reference-currencies"
          value={plan.currency}
          onValueChange={(value) => onChange({ currency: String(value) })}
          aria-label="Quote currency"
        >
          {filteredCurrencies.map((currency) => (
            <label
              className={`selection-card ${plan.currency === currency ? 'selected' : ''}`}
              key={currency}
            >
              <RadioGroupItem value={currency} aria-label={currency} />
              <strong>{currency}</strong>
            </label>
          ))}
        </RadioGroup>
        {!filteredCurrencies.length && (
          <output className="source-note">
            No matching symbols. Clear the search to see all choices.
          </output>
        )}
        {currencies.length > 8 && (
          <p className="source-note">
            Selected: {plan.currency}. Symbols reflect the reference catalog;
            contract identity and trading availability need integration
            verification.
          </p>
        )}
        {plan.chain === 'Robinhood' &&
          ['pons.family', 'hood.fun'].includes(plan.launchpad) && (
            <section className="venue-options">
              <h2>
                {plan.launchpad} <span>Draft options</span>
              </h2>
              {plan.launchpad === 'hood.fun' ? (
                <>
                  <label htmlFor="supply">Total supply</label>
                  <Input
                    id="supply"
                    inputMode="numeric"
                    value={options.totalSupply}
                    onChange={(e) =>
                      onOptionsChange?.({ totalSupply: e.target.value })
                    }
                  />
                  <label htmlFor="community-coin" className="option-switch">
                    <span>
                      <strong>Community coin</strong>
                      <small>Plan holder-directed trading fees.</small>
                    </span>
                    <Switch
                      id="community-coin"
                      aria-label="Community coin"
                      checked={options.communityCoin}
                      onCheckedChange={(communityCoin) =>
                        onOptionsChange?.({ communityCoin })
                      }
                    />
                  </label>
                </>
              ) : (
                <>
                  <p className="version-label">
                    V2 <span>Creator fee recipient: deployer</span>
                  </p>
                  <label htmlFor="creator-tax">Creator tax · 0–10%</label>
                  <Input
                    id="creator-tax"
                    type="number"
                    min={0}
                    max={10}
                    step={0.1}
                    value={options.creatorTax}
                    onChange={(e) =>
                      onOptionsChange?.({ creatorTax: Number(e.target.value) })
                    }
                  />
                  <label htmlFor="venue-buyback" className="option-switch">
                    <span>
                      <strong>Buyback</strong>
                      <small>Record a buyback preference in this draft.</small>
                    </span>
                    <Switch
                      id="venue-buyback"
                      aria-label="Buyback"
                      checked={options.buyback}
                      onCheckedChange={(buyback) =>
                        onOptionsChange?.({ buyback })
                      }
                    />
                  </label>
                </>
              )}
            </section>
          )}
        <p className="support-note">
          <Network /> Planning only. Venue selection does not activate a launch
          adapter.
        </p>
        <Button className="flow-next" onClick={onNext}>
          Configure token <ArrowRight />
        </Button>
        {plan.chain === 'Robinhood' && (
          <button className="text-link" onClick={onExploreRobinhood}>
            Open Robinhood token inspector <ExternalLink size={14} />
          </button>
        )}
      </div>
    </div>
  );
}
