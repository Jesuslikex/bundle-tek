'use client';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { ImportedToken, TokenSource } from '@/lib/token-import';
import { formatTokenSupply } from '@/lib/robinhood-token';
import { EVM_NETWORKS } from '@/lib/evm-network';
import { TokenLinkedMetadataReview } from './token-linked-metadata-review';
import type {
  CloneMetadataFields,
  LinkedTokenMetadata,
} from '@/lib/token-linked-metadata';

export function TokenCloneLookup({
  onApply,
  onApplyMetadata,
}: {
  onApply: (token: ImportedToken) => void;
  onApplyMetadata: (
    token: ImportedToken,
    fields: CloneMetadataFields,
    metadata: LinkedTokenMetadata,
  ) => void;
}) {
  const [chain, setChain] = useState<TokenSource['chain']>('Solana');
  const [address, setAddress] = useState('');
  const [token, setToken] = useState<ImportedToken | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  function reset() {
    pending.current?.abort();
    pending.current = null;
    setToken(null);
    setError('');
    setLoading(false);
  }
  async function inspect() {
    reset();
    const controller = new AbortController();
    pending.current = controller;
    setLoading(true);
    try {
      const response = await fetch(
        `/api/tokens/inspect?${new URLSearchParams({ chain, address: address.trim() })}`,
        { signal: controller.signal },
      );
      const body = (await response.json()) as {
        token?: ImportedToken;
        error?: string;
      };
      if (!response.ok || !body.token)
        throw new Error(body.error || 'Token lookup failed.');
      if (pending.current === controller) setToken(body.token);
    } catch (error) {
      if (!controller.signal.aborted && pending.current === controller)
        setError((error as Error).message);
    } finally {
      if (pending.current === controller) {
        setLoading(false);
        pending.current = null;
      }
    }
  }
  const copyable =
    token &&
    token.name.length >= 2 &&
    token.name.length <= 32 &&
    /^[A-Z0-9]{1,13}$/.test(token.symbol.toUpperCase());
  return (
    <section
      className="token-inspector token-clone-lookup"
      aria-labelledby="clone-heading"
    >
      <h2 id="clone-heading">Clone token details</h2>
      <p>
        Look up an existing token, review its identity, then copy it into this
        draft.
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void inspect();
        }}
      >
        <label htmlFor="clone-chain">Source network</label>
        <select
          id="clone-chain"
          value={chain}
          onChange={(event) => {
            reset();
            setChain(event.target.value as TokenSource['chain']);
            setAddress('');
          }}
        >
          <option>Solana</option>
          {Object.keys(EVM_NETWORKS).map((network) => (
            <option key={network}>{network}</option>
          ))}
        </select>
        <label htmlFor="clone-address">Token address</label>
        <Input
          id="clone-address"
          value={address}
          onChange={(event) => {
            reset();
            setAddress(event.target.value);
          }}
          placeholder={chain === 'Solana' ? 'Mint address' : '0x…'}
          maxLength={44}
          autoComplete="off"
          spellCheck={false}
        />
        <Button type="submit" disabled={loading || !address.trim()}>
          {loading ? 'Looking up token…' : 'Look up token'}
        </Button>
      </form>
      <div aria-live="polite">
        {error && (
          <p role="alert" className="inspection-error">
            {error}
          </p>
        )}
        {token && (
          <div className="token-result">
            <h3>
              {token.name} <small>${token.symbol}</small>
            </h3>
            <p>
              {token.chain} mainnet ·{' '}
              {formatTokenSupply(token.totalSupplyRaw, token.decimals)} tokens ·{' '}
              {token.decimals} decimals
            </p>
            <code>{token.address}</code>
            <p className="source-note">
              Read from {token.source} at{' '}
              {new Date(token.observedAt).toLocaleString()}.
              {token.blockNumber !== undefined && (
                <> Block {token.blockNumber}.</>
              )}
              {token.contextSlot !== undefined && (
                <> Slot {token.contextSlot}.</>
              )}
              {token.metadataKind && <> {token.metadataKind} identity.</>}
            </p>
            <Button
              type="button"
              disabled={!copyable}
              onClick={() => onApply(token)}
            >
              Use these token details
            </Button>
            {!copyable && (
              <p className="inspection-error">
                This identity does not fit the launch form. Enter a name of 2 to
                32 characters and an alphanumeric symbol manually.
              </p>
            )}
            <TokenLinkedMetadataReview
              key={`${token.chain}:${token.address}:${token.observedAt}`}
              token={token}
              onApply={(fields, metadata) =>
                onApplyMetadata(token, fields, metadata)
              }
            />
          </div>
        )}
      </div>
      <p className="source-note">
        Name and symbol use the on-chain identity. Linked details require a
        separate read and field selection. Supply and launch configuration stay
        separate.
      </p>
    </section>
  );
}
