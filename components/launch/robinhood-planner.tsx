'use client';

import { useState } from 'react';
import { Input } from '@/components/ui/input';
import { formatTokenSupply, type RobinhoodToken } from '@/lib/robinhood-token';
import {
  ArrowLeft,
  ArrowUpRight,
  LockKeyhole,
  Network,
  Search,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { VENUES_BY_CHAIN } from '@/lib/launch-plan';

export const ROBINHOOD_VENUES = VENUES_BY_CHAIN.Robinhood;

export function RobinhoodPlanner({
  venue,
  onSelect,
  onBack,
}: {
  venue: string;
  onSelect: (venue: string) => void;
  onBack: () => void;
}) {
  const ponsSelected = venue === 'pons.family';
  const [address, setAddress] = useState('');
  const [token, setToken] = useState<RobinhoodToken | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const inspect = async () => {
    setToken(null);
    setError('');
    setLoading(true);
    try {
      const response = await fetch(
        `/api/robinhood/token?address=${encodeURIComponent(address)}`,
        { cache: 'no-store', signal: AbortSignal.timeout(15_000) },
      );
      const data = (await response.json()) as {
        token?: RobinhoodToken;
        error?: string;
      };
      if (!response.ok || !data.token)
        throw new Error(data.error ?? 'Inspection unavailable.');
      setToken(data.token);
    } catch (error) {
      setError(
        error instanceof Error ? error.message : 'Inspection unavailable.',
      );
    } finally {
      setLoading(false);
    }
  };
  return (
    <>
      <section className="settings-panel">
        <div className="settings-scroll launch-flow-scroll">
          <div className="page-title">
            <span className="eyebrow">
              <Network /> VENUE EXPLORER / ROBINHOOD
            </span>
            <h1>Robinhood venues</h1>
            <p>
              {ponsSelected
                ? 'Pons V2 coordination is included as a locked, unsigned backend workflow. No browser launch adapter or signer is connected.'
                : 'Choose a venue to research or inspect an existing token. Launches are not connected.'}
            </p>
            <span className="capability-pill">
              {ponsSelected
                ? 'Pons V2 coordinator · Mainnet gate locked'
                : 'Planning only · read-only workspace'}
            </span>
          </div>
          <div className="form-body">
            <div className="flow-section-title">
              <Search /> Choose a venue{' '}
              <span className="section-note">
                {ROBINHOOD_VENUES.length} reference listings
              </span>
            </div>
            <div
              className="venue-grid robinhood-venues"
              aria-label="Robinhood observed venues"
            >
              {ROBINHOOD_VENUES.map((name, index) => (
                <button
                  type="button"
                  key={name}
                  aria-pressed={venue === name}
                  className={venue === name ? 'active' : ''}
                  onClick={() => onSelect(name)}
                >
                  <span className="venue-monogram" aria-hidden="true">
                    {name.slice(0, 1).toUpperCase()}
                    <small>{String(index + 1).padStart(2, '0')}</small>
                  </span>
                  <span>
                    <strong>{name}</strong>
                  </span>
                  <ArrowUpRight aria-hidden="true" />
                </button>
              ))}
            </div>
            {ponsSelected ? (
              <details className="progressive-section evidence-disclosure">
                <summary>Pons V2 coordinator · locked by default</summary>
                <p>
                  Persistent owner-isolated jobs support a single-recipient
                  atomic launch-and-opening-buy simulation, idempotent requests,
                  unsigned handoff preparation and receipt tracking. The
                  coordinator has no signer, private keys, transaction
                  broadcast, wallet allocation or inclusion guarantee.
                </p>
              </details>
            ) : (
              <details className="progressive-section evidence-disclosure">
                <summary>No verified adapter · what this means</summary>
                <p>
                  Venue names come from the reference interface, not an
                  integration check. Their deployment, liquidity and official
                  affiliation are not verified. The documented network uses ETH
                  (chain ID 4663); venue quote currencies remain unverified. No
                  wallet, launch or trading adapter is connected.
                </p>
              </details>
            )}
            <p className="source-note">
              <a
                href="https://docs.robinhood.com/chain/connecting"
                target="_blank"
                rel="noreferrer"
              >
                Official network documentation ↗
              </a>
            </p>
            <section
              className="token-inspector"
              aria-labelledby="inspect-title"
            >
              <h2 id="inspect-title">Inspect existing token</h2>
              <p>
                Metadata only · Robinhood mainnet · no wallet required.
                Inspecting an address does not import it into a launch plan or
                verify a venue listing.
              </p>
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void inspect();
                }}
              >
                <label htmlFor="robinhood-address">
                  Token contract address
                </label>
                <Input
                  id="robinhood-address"
                  value={address}
                  disabled={loading}
                  onChange={(event) => {
                    setAddress(event.target.value);
                    setToken(null);
                    setError('');
                  }}
                  placeholder="0x…"
                  autoComplete="off"
                  spellCheck={false}
                  required
                  pattern="0x[0-9a-fA-F]{40}"
                  maxLength={42}
                  aria-describedby="inspection-source"
                />
                <Button
                  type="submit"
                  disabled={loading || !/^0x[0-9a-fA-F]{40}$/.test(address)}
                >
                  {loading ? 'Reading public RPC…' : 'Inspect token'}
                </Button>
              </form>
              <p id="inspection-source" className="source-note">
                Source: official public Robinhood RPC. Rate limits or
                non-standard contracts may prevent inspection.
              </p>
              <output className="inspection-output" aria-live="polite">
                {error && <p className="inspection-error">{error}</p>}
                {token && (
                  <section className="token-result">
                    <span className="capability-pill">
                      ON-CHAIN METADATA · READ ONLY
                    </span>
                    <h3>
                      {token.name} <small>{token.symbol}</small>
                    </h3>
                    <dl>
                      <div>
                        <dt>Network</dt>
                        <dd>Robinhood mainnet · {token.chainId}</dd>
                      </div>
                      <div>
                        <dt>Decimals</dt>
                        <dd>{token.decimals}</dd>
                      </div>
                      <div>
                        <dt>Total supply</dt>
                        <dd>
                          {formatTokenSupply(
                            token.totalSupplyRaw,
                            token.decimals,
                          )}
                        </dd>
                      </div>
                      <div>
                        <dt>Contract</dt>
                        <dd>{token.address}</dd>
                      </div>
                    </dl>
                    <details className="progressive-section">
                      <summary>Technical details</summary>
                      <p>Block (hex): {token.block}</p>
                      <p>Raw supply: {token.totalSupplyRaw}</p>
                    </details>
                    <p>
                      Contract-reported metadata, not an endorsement or security
                      review. Price, liquidity, holders and venue membership are
                      not verified.
                    </p>
                    <a
                      href={`https://robinhoodchain.blockscout.com/address/${token.address}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      View contract in official explorer ↗
                    </a>
                  </section>
                )}
              </output>
            </section>
            <Button className="flow-next" onClick={onBack}>
              <ArrowLeft /> Return to launch plan
            </Button>
            <p className="next-action-note">
              Your existing launch draft is preserved. This venue selection
              stays in this session only and is not saved with it.
            </p>
          </div>
        </div>
      </section>
      <aside className="insights">
        <div className="insights-scroll plan-rail">
          <section className="plan-score">
            <span>
              <Network />
            </span>
            <div>
              <small>ROBINHOOD / EXPLORATION</small>
              <strong>{venue}</strong>
            </div>
            <em>Planning only</em>
          </section>
          <section className="plan-gates">
            <h2>Integration readiness</h2>
            {(ponsSelected
              ? [
                  ['Coordinator', 'Persistent D1 jobs · gate locked'],
                  ['Atomic scope', 'Single recipient launch + opening buy'],
                  ['Handoff', 'Unsigned only · nonce not reserved'],
                  [
                    'Receipt lifecycle',
                    'Tracked after an exact matching transaction',
                  ],
                  ['Wallet & broadcast', 'Not connected'],
                ]
              : [
                  ['Venue', 'Observed, not integrated'],
                  ['Network', 'Mainnet 4663 · ETH (documented)'],
                  ['Quote currency', 'Currency not verified'],
                  ['Funding', 'No estimate available'],
                  ['Wallet & distribution', 'Unavailable for Robinhood'],
                ]
            ).map(([label, text]) => (
              <div key={label}>
                <i>—</i>
                <span>
                  <strong>{label}</strong>
                  <small>{text}</small>
                </span>
              </div>
            ))}
          </section>
          <div className="execution-note">
            <LockKeyhole />
            <p>
              {ponsSelected ? (
                <>
                  <strong>Mainnet gate locked.</strong> The deployed workflow
                  can persist and simulate intents only when explicitly enabled;
                  this release cannot sign, broadcast or move funds.
                </>
              ) : (
                <>
                  <strong>Next: inspect a token.</strong> Selection is
                  read-only. Funding, distribution, launch submission and
                  trading remain unavailable. A connected Solana wallet does not
                  change Robinhood readiness.
                </>
              )}
            </p>
          </div>
        </div>
      </aside>
    </>
  );
}
