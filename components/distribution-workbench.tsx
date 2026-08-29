'use client';

import { useMemo, useState } from 'react';
import { Boxes, CheckCircle2, Download, FileWarning, Layers3, LockKeyhole, Shield, Users } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { buildDistributionPlan } from '@/lib/distribution-plan';

const SAMPLE = `# address, amount, optional label
11111111111111111111111111111111, 125000, Treasury reserve
So11111111111111111111111111111111111111112, 50000, Community rewards
Vote111111111111111111111111111111111111111, 25000, Liquidity allocation`;

export function DistributionWorkbench() {
  const [manifest, setManifest] = useState(SAMPLE);
  const [tokenSupply, setTokenSupply] = useState(1_000_000);
  const [reservePercent, setReservePercent] = useState(70);
  const [batchSize, setBatchSize] = useState(8);
  const result = useMemo(() => {
    try {
      return { plan: buildDistributionPlan({ manifest, tokenSupply, reservePercent, batchSize }), error: null };
    } catch (error) {
      return { plan: null, error: error instanceof Error ? error.message : 'Invalid distribution plan.' };
    }
  }, [manifest, tokenSupply, reservePercent, batchSize]);

  const exportManifest = () => {
    if (!result.plan) return;
    const payload = {
      version: 1,
      network: 'solana-devnet',
      execution: 'locked',
      createdAt: new Date().toISOString(),
      tokenSupply,
      reservePercent,
      totalAmount: result.plan.totalAmount,
      batches: result.plan.batches.map((recipients, index) => ({ batch: index + 1, recipients })),
    };
    const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `pulseforge-distribution-${Date.now()}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return <div className="distribution-scroll">
    <header className="distribution-head"><div><span className="eyebrow"><Boxes /> DISTRIBUTION / DEVNET WORKBENCH</span><h1>Recipient Manifest</h1><p>Turn a raw allocation list into validated, reviewable transaction batches.</p></div><span className="read-only-badge"><LockKeyhole /> EXECUTION LOCKED</span></header>
    <div className="distribution-layout">
      <section className="distribution-editor">
        <div className="distribution-fields"><label><span>Token supply</span><Input type="number" min={1} value={tokenSupply} onChange={(event) => setTokenSupply(Number(event.target.value))} /></label><label><span>Protected reserve</span><span className="number-wrap"><Input type="number" min={0} max={99.99} value={reservePercent} onChange={(event) => setReservePercent(Number(event.target.value))} /><b>%</b></span></label><label><span>Recipients per batch</span><Input type="number" min={1} max={12} value={batchSize} onChange={(event) => setBatchSize(Number(event.target.value))} /></label></div>
        <label className="manifest-field"><span>Recipient manifest <small>ADDRESS, AMOUNT, OPTIONAL LABEL</small></span><textarea value={manifest} onChange={(event) => setManifest(event.target.value)} spellCheck={false} aria-label="Recipient manifest" /></label>
        <div className={`manifest-state ${result.error ? 'error' : 'ready'}`}>{result.error ? <><FileWarning /> <span><strong>Manifest blocked</strong><small>{result.error}</small></span></> : <><CheckCircle2 /> <span><strong>Manifest validated</strong><small>Addresses, amounts, reserve, duplicates, and batch limits passed.</small></span></>}</div>
        <div className="distribution-actions"><Button variant="outline" onClick={() => setManifest('')}>Clear manifest</Button><Button onClick={exportManifest} disabled={!result.plan}><Download /> Export audit manifest</Button></div>
      </section>
      <aside className="distribution-review">
        <div className="distribution-kpis"><article><Users /><span><small>Recipients</small><strong>{result.plan?.recipients.length ?? '—'}</strong></span></article><article><Layers3 /><span><small>Transaction batches</small><strong>{result.plan?.batches.length ?? '—'}</strong></span></article><article><Shield /><span><small>Protected reserve</small><strong>{reservePercent}%</strong></span></article></div>
        <section className="allocation-card"><header><span>Allocation review</span><b>{result.plan ? `${result.plan.allocationPercent.toFixed(2)}%` : 'BLOCKED'}</b></header><div className="allocation-track"><i style={{ width: `${Math.min(100, result.plan?.allocationPercent ?? 0)}%` }} /></div><p><span>Planned distribution</span><b>{result.plan?.totalAmount.toLocaleString() ?? '—'}</b></p><p><span>Maximum distributable</span><b>{result.plan?.distributableAmount.toLocaleString() ?? '—'}</b></p></section>
        {result.plan?.warnings.length ? <section className="distribution-warnings"><strong>Automatic corrections</strong>{result.plan.warnings.map((warning) => <p key={warning}>{warning}</p>)}</section> : null}
        <section className="batch-preview"><header><span>Batch preview</span><b>MAX {Math.max(1, Math.min(12, batchSize))} / TX</b></header>{result.plan?.batches.slice(0, 4).map((batch, index) => <div key={index}><span><b>Batch {String(index + 1).padStart(2, '0')}</b><small>{batch.length} recipient{batch.length === 1 ? '' : 's'}</small></span><em>{batch.reduce((sum, recipient) => sum + recipient.amount, 0).toLocaleString()} tokens</em></div>)}{result.plan && result.plan.batches.length > 4 && <p>+ {result.plan.batches.length - 4} more batches in exported manifest</p>}</section>
        <div className="distribution-boundary"><LockKeyhole /><p><strong>No funds move yet.</strong> This workbench produces a validated devnet execution manifest. Token-account creation, transaction simulation, wallet approval, and broadcast are the next gated layer.</p></div>
      </aside>
    </div>
  </div>;
}

