'use client';
import { quoteCatalog } from '@/lib/quote-catalog';

import { useState } from 'react';
import { ArrowRight, ExternalLink, Network } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Switch } from '@/components/ui/switch';
import {
  CHAINS,
  VENUES_BY_CHAIN,
  CURRENT_VENUES_BY_CHAIN,
  currenciesForVenue,
  type LaunchChain,
  type LaunchPlanInput,
} from '@/lib/launch-plan';
import {
  DEFAULT_VENUE_OPTIONS,
  type VenueOptions,
} from '@/lib/workspace-project';
import { DEFAULT_VENUE_SETTINGS } from '@/lib/venue-settings';
import { VenueSettingsForm } from './venue-settings-form';

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
  const [quoteLimit, setQuoteLimit] = useState(40);
  const chooseChain = (chain: LaunchChain) => {
    setQuoteSearch('');
    setQuoteLimit(40);
    const launchpad = CURRENT_VENUES_BY_CHAIN[chain][0];
    onOptionsChange?.({
      settings: structuredClone(DEFAULT_VENUE_SETTINGS),
      wallets: undefined,
    });
    onChange({
      chain,
      launchpad,
      currency: currenciesForVenue(chain, launchpad)[0],
      quoteAddress: quoteCatalog(chain, launchpad).assets[0]?.address,
    });
  };
  const chooseVenue = (launchpad: string) => {
    onOptionsChange?.({ settings: structuredClone(DEFAULT_VENUE_SETTINGS) });
    setQuoteSearch('');
    setQuoteLimit(40);
    onChange({
      launchpad,
      currency: currenciesForVenue(plan.chain, launchpad)[0],
      quoteAddress: quoteCatalog(plan.chain, launchpad).assets[0]?.address,
    });
  };
  const currencies = currenciesForVenue(plan.chain, plan.launchpad);
  const catalog = quoteCatalog(plan.chain, plan.launchpad);
  const choices = catalog.captured
    ? catalog.assets
    : currencies.map((symbol) => ({ symbol, address: '', decimals: null }));
  const selected = plan.quoteAddress
    ? choices.find((a) => a.address === plan.quoteAddress)
    : choices.filter((a) => a.symbol === plan.currency).length === 1
      ? choices.find((a) => a.symbol === plan.currency)
      : undefined;
  const filtered = choices.filter((a) =>
    (a.symbol + ' ' + a.address)
      .toLowerCase()
      .includes(quoteSearch.toLowerCase()),
  );
  const shortAddress = (address: string) =>
    address ? address.slice(0, 6) + '…' + address.slice(-4) : 'Symbol only';
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
                <small>
                  {CURRENT_VENUES_BY_CHAIN[chain].length} launchpad
                  {CURRENT_VENUES_BY_CHAIN[chain].length === 1 ? '' : 's'}
                </small>
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
          {[
            ...CURRENT_VENUES_BY_CHAIN[plan.chain],
            ...(!CURRENT_VENUES_BY_CHAIN[plan.chain].includes(plan.launchpad) &&
            VENUES_BY_CHAIN[plan.chain].includes(plan.launchpad)
              ? [plan.launchpad]
              : []),
          ].map((venue) => (
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
        {!CURRENT_VENUES_BY_CHAIN[plan.chain].includes(plan.launchpad) && (
          <p className="source-note">
            {plan.launchpad} is a legacy saved profile. It remains available for
            this draft.
          </p>
        )}
        <VenueSettingsForm
          plan={plan}
          settings={options.settings ?? DEFAULT_VENUE_SETTINGS}
          onChange={(settings) => onOptionsChange?.({ settings })}
        />
        <h2 className="flow-section-title">
          {plan.launchpad === 'long.xyz'
            ? 'Stock-token quote'
            : 'Quote currency'}{' '}
          <span className="section-note">Draft selection</span>
        </h2>
        {choices.length > 8 && (
          <Input
            aria-label="Search quote currencies"
            placeholder="Search symbol or address…"
            value={quoteSearch}
            onChange={(e) => {
              setQuoteSearch(e.target.value);
              setQuoteLimit(40);
            }}
          />
        )}
        <RadioGroup
          className="reference-currencies"
          value={selected ? selected.address || selected.symbol : ''}
          onValueChange={(value) => {
            const asset = choices.find(
              (a) => (a.address || a.symbol) === value,
            );
            if (!asset) return;
            onOptionsChange?.({
              settings: {
                ...options.settings,
                pumpfun: {
                  ...options.settings.pumpfun,
                  creatorFeePercent: undefined,
                },
              },
            });
            onChange({
              currency: asset.symbol,
              quoteAddress: asset.address || undefined,
            });
          }}
          aria-label="Quote currency"
        >
          {filtered.slice(0, quoteLimit).map((asset) => (
            <label
              className={`selection-card ${selected === asset ? 'selected' : ''}`}
              key={asset.address || asset.symbol}
              htmlFor={'quote-' + (asset.address || asset.symbol)}
            >
              <RadioGroupItem
                value={asset.address || asset.symbol}
                id={'quote-' + (asset.address || asset.symbol)}
                aria-label={
                  asset.symbol + (asset.address ? ' ' + asset.address : '')
                }
              />
              <span>
                <strong>{asset.symbol}</strong>
                <small style={{ display: 'block' }}>
                  {shortAddress(asset.address)}
                </small>
              </span>
            </label>
          ))}
        </RadioGroup>
        {!filtered.length && (
          <output className="source-note">
            No matching tokens. Clear the search to see all choices.
          </output>
        )}
        {filtered.length > quoteLimit && (
          <Button
            type="button"
            variant="outline"
            onClick={() => setQuoteLimit((n) => n + 40)}
          >
            Show more tokens ({filtered.length - quoteLimit} remaining)
          </Button>
        )}
        <p className="source-note" style={{ overflowWrap: 'anywhere' }}>
          Selected: {plan.currency}
          {selected?.address
            ? ` · ${selected.decimals} decimals · ${selected.address}`
            : ' · exact token address not selected'}
          . Captured catalog choices are planning references. Funding drafts use
          their own currency selection.
        </p>
        {!catalog.captured && (
          <p className="source-note">
            This launchpad has no captured quote-token profile. The currency
            choice is unverified.
          </p>
        )}
        {catalog.unresolved.length > 0 && (
          <p className="source-note">
            {catalog.unresolved.length} catalog address has no token metadata
            and is unavailable for selection.
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
