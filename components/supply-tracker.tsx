'use client';

import { useState } from 'react';
import { Activity, CircleGauge, Copy, Crosshair, Database, Search, ShieldCheck, Users, WalletCards } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

type Holder = { rank: number; owner: string; amount: string; supplyPercent: number };
type SupplyResult = {
  mint: string;
  network: string;
  slot: number;
  totalSupply: string;
  bundle: { walletCount: number; amount: string; supplyPercent: number };
  external: { amount: string; supplyPercent: number; topTenPercent: number };
  topExternal: Holder[];
  note: string;
};

const short = (value: string) => `${value.slice(0, 5)}…${value.slice(-5)}`;
const compact = (value: string) => {
  const number = Number(value);
  if (!Number.isFinite(number)) return value;
  return new Intl.NumberFormat('en', { notation: number >= 100_000 ? 'compact' : 'standard', maximumFractionDigits: 2 }).format(number);
};

export function SupplyTracker() {
  const [mint, setMint] = useState('');
  const [walletText, setWalletText] = useState('');
  const [result, setResult] = useState<SupplyResult | null>(null);
  const [status, setStatus] = useState<'idle' | 'loading' | 'error'>('idle');
  const [message, setMessage] = useState('');

  const analyze = async () => {
    const bundleWallets = walletText.split(/[\s,]+/).map((value) => value.trim()).filter(Boolean);
    setStatus('loading'); setMessage('Reading token accounts from Solana mainnet…');
    try {
      const response = await fetch('/api/supply/analyze', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mint, bundleWallets }),
      });
      const payload = await response.json() as SupplyResult & { error?: string };
      if (!response.ok) throw new Error(payload.error ?? 'Supply analysis failed');
      setResult(payload); setStatus('idle'); setMessage(`Confirmed at Solana slot ${payload.slot.toLocaleString()}.`);
    } catch (error) {
      setResult(null); setStatus('error'); setMessage(error instanceof Error ? error.message : 'Supply analysis failed');
    }
  };

  const externalRisk = result ? result.external.topTenPercent >= 50 ? 'HIGH CONCENTRATION' : result.external.topTenPercent >= 25 ? 'WATCH' : 'DISTRIBUTED' : 'WAITING';

  return <section className="supply-tracker">
    <div className="tracker-head">
      <div><span className="eyebrow"><Crosshair /> ON-CHAIN / SUPPLY INTELLIGENCE</span><h1>Supply Tracker</h1><p>See what your bundle controls, then focus on how the remaining supply is distributed across external holders.</p></div>
      <span className="read-only-badge"><ShieldCheck /> READ ONLY</span>
    </div>

    <div className="tracker-layout">
      <div className="tracker-controls">
        <section className="tracker-input-card">
          <div className="tracker-card-title"><Database /><span><strong>Token mint</strong><small>Solana mainnet address</small></span></div>
          <Input value={mint} onChange={(event) => setMint(event.target.value)} placeholder="Paste token mint address" aria-label="Token mint address" />
          <div className="tracker-card-title bundle-title"><WalletCards /><span><strong>Your bundle wallets</strong><small>Optional · one address per line, maximum 12</small></span></div>
          <textarea value={walletText} onChange={(event) => setWalletText(event.target.value)} placeholder={'Wallet 1\nWallet 2\nWallet 3'} aria-label="Bundle wallet addresses" />
          <Button className="tracker-run" onClick={() => void analyze()} disabled={status === 'loading' || !mint.trim()}>{status === 'loading' ? <><Activity className="animate-spin" /> Reading holders</> : <><Search /> Analyze supply</>}</Button>
          <p className={`tracker-message ${status === 'error' ? 'error' : ''}`}>{message || 'No wallet connection, private key, or transaction signing is required.'}</p>
        </section>

        <section className="tracker-method">
          <h2><CircleGauge /> What is measured</h2>
          <div><span>Bundle ownership</span><b>All token accounts owned by your supplied wallets</b></div>
          <div><span>External ownership</span><b>Total supply minus the bundle total</b></div>
          <div><span>Top holders</span><b>Largest external token accounts grouped by owner</b></div>
        </section>
      </div>

      <div className="tracker-results">
        {!result ? <div className="tracker-empty"><Users /><strong>External holders are the main signal</strong><p>Add a mint to reveal outside ownership, whale concentration, and the largest non-bundle wallets.</p><div className="empty-bars"><i /><i /><i /><i /><i /></div></div> : <>
          <div className="tracker-kpis">
            <article className="primary"><small>Everyone else holds</small><strong>{result.external.supplyPercent.toFixed(2)}%</strong><span>{compact(result.external.amount)} tokens</span></article>
            <article><small>Your bundle holds</small><strong>{result.bundle.supplyPercent.toFixed(2)}%</strong><span>{compact(result.bundle.amount)} tokens · {result.bundle.walletCount} wallets</span></article>
            <article><small>Top 10 external</small><strong>{result.external.topTenPercent.toFixed(2)}%</strong><span className={`risk-${externalRisk === 'HIGH CONCENTRATION' ? 'high' : externalRisk === 'WATCH' ? 'watch' : 'safe'}`}>{externalRisk}</span></article>
            <article><small>Total supply</small><strong>{compact(result.totalSupply)}</strong><span>Mainnet · slot {result.slot.toLocaleString()}</span></article>
          </div>

          <section className="ownership-bar-card">
            <div><span>External <b>{result.external.supplyPercent.toFixed(2)}%</b></span><span>Bundle <b>{result.bundle.supplyPercent.toFixed(2)}%</b></span></div>
            <div className="ownership-bar"><i style={{ width: `${result.external.supplyPercent}%` }} /><em style={{ width: `${result.bundle.supplyPercent}%` }} /></div>
          </section>

          <section className="holders-table">
            <header><span><Users /> Top external holders</span><small>Bundle wallets excluded</small></header>
            <div className="holder-columns"><span># / OWNER</span><span>BALANCE</span><span>SUPPLY</span></div>
            {result.topExternal.map((holder) => <div className="holder-row" key={holder.owner}>
              <span><b>{holder.rank}</b><code title={holder.owner}>{short(holder.owner)}</code><button onClick={() => void navigator.clipboard.writeText(holder.owner)} aria-label={`Copy holder ${holder.rank} address`}><Copy /></button></span>
              <strong>{compact(holder.amount)}</strong>
              <em>{holder.supplyPercent.toFixed(3)}%</em>
            </div>)}
            {result.topExternal.length === 0 && <p className="no-holders">No external top-holder accounts were returned.</p>}
          </section>
          <p className="tracker-note">{result.note}</p>
        </>}
      </div>
    </div>
  </section>;
}
