'use client';

import { useEffect, useMemo, useState } from 'react';
import { address } from '@solana/kit';
import { useConnect, useConnectedWallet, useDisconnect, useWalletStatus, useWallets } from '@solana/kit-plugin-wallet/react';
import { CheckCircle2, Download, ExternalLink, FileSignature, FileWarning, Layers3, LockKeyhole, Play, RefreshCw, Shield, Users, WalletCards, Boxes } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useAppClient } from '@/components/solana-provider';
import { buildDistributionPlan, toBaseUnits, type DistributionPlan } from '@/lib/distribution-plan';

const SAMPLE = `# address, amount, optional label
11111111111111111111111111111111, 125000, Treasury reserve
So11111111111111111111111111111111111111112, 50000, Community rewards
Vote111111111111111111111111111111111111111, 25000, Liquidity allocation`;

type TransferReceipt = { address: string; amount: number; signature: string; confirmedAt: string };

function DistributionExecution({ plan }: { plan: DistributionPlan | null }) {
  const client = useAppClient();
  const wallets = useWallets(client);
  const connected = useConnectedWallet(client);
  const walletStatus = useWalletStatus(client);
  const connectAction = useConnect(client);
  const disconnectAction = useDisconnect(client);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [mintAddress, setMintAddress] = useState('');
  const [decimals, setDecimals] = useState<number | null>(null);
  const [sourceBalance, setSourceBalance] = useState<bigint | null>(null);
  const [prepared, setPrepared] = useState(false);
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState('Connect a devnet wallet and enter its SPL token mint.');
  const [receipts, setReceipts] = useState<TransferReceipt[]>([]);
  const walletAddress = connected?.account.address ?? null;
  const planIdentity = plan?.recipients.map((recipient) => `${recipient.address}:${recipient.amount}`).join('|') ?? '';
  const executionKey = walletAddress && mintAddress && planIdentity ? `pulseforge:distro:${walletAddress}:${mintAddress}:${planIdentity}` : null;
  const pending = plan?.recipients.find((recipient) => !receipts.some((receipt) => receipt.address === recipient.address && receipt.amount === recipient.amount)) ?? null;

  useEffect(() => {
    setPrepared(false); setDecimals(null); setSourceBalance(null);
    if (!executionKey) { setReceipts([]); return; }
    try { setReceipts(JSON.parse(window.localStorage.getItem(executionKey) ?? '[]') as TransferReceipt[]); }
    catch { setReceipts([]); }
  }, [executionKey]);

  const prepare = async () => {
    if (!connected?.signer || !mintAddress || !plan) return;
    setWorking(true); setMessage('Reading the devnet mint and verifying the connected wallet balance…');
    try {
      const mint = await client.token.accounts.mint.fetch(address(mintAddress));
      const mintDecimals = mint.data.decimals;
      const [sourceAta] = await client.associatedToken.pdas.associatedToken({ owner: address(walletAddress!), mint: mint.address, tokenProgram: mint.programAddress });
      const source = await client.token.accounts.token.fetch(sourceAta);
      const required = plan.recipients.reduce((sum, recipient) => sum + toBaseUnits(recipient.amount, mintDecimals), 0n);
      if (source.data.mint !== mint.address) throw new Error('Connected wallet token account does not match this mint.');
      if (source.data.amount < required) throw new Error('Connected wallet does not hold enough tokens for this manifest.');
      await client.rpc.getLatestBlockhash({ commitment: 'confirmed' }).send();
      setDecimals(mintDecimals); setSourceBalance(source.data.amount); setPrepared(true);
      setMessage(`Preflight ready · ${plan.recipients.length} recipients · wallet approval required for every transfer.`);
    } catch (error) {
      setPrepared(false); setMessage(error instanceof Error ? error.message : 'Devnet preflight failed.');
    } finally { setWorking(false); }
  };

  const sendNext = async () => {
    if (!connected?.signer || !pending || decimals === null || !prepared || !plan) return;
    setWorking(true); setMessage(`Waiting for wallet approval to send ${pending.amount.toLocaleString()} tokens…`);
    try {
      const result = await client.token.instructions.transferToATA({
        payer: connected.signer,
        mint: address(mintAddress),
        recipient: address(pending.address),
        authority: connected.signer,
        amount: toBaseUnits(pending.amount, decimals),
        decimals,
      }).sendTransaction();
      const receipt = { address: pending.address, amount: pending.amount, signature: result.context.signature, confirmedAt: new Date().toISOString() };
      setReceipts((current) => {
        const next = [...current, receipt];
        if (executionKey) window.localStorage.setItem(executionKey, JSON.stringify(next));
        return next;
      });
      setMessage('Transfer confirmed on devnet. The next recipient remains separately approval-gated.');
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Transfer was rejected or failed.'); }
    finally { setWorking(false); }
  };

  return <section className="execution-console">
    <header><span><WalletCards /> Devnet SPL execution</span><b>WALLET APPROVAL · ONE TRANSFER AT A TIME</b></header>
    <div className="execution-connect"><div className="kit-wallet-picker">{connected ? <Button variant="outline" onClick={() => void disconnectAction.dispatchAsync()}>Disconnect</Button> : <Button onClick={() => setPickerOpen((open) => !open)} disabled={walletStatus === 'connecting'}>{walletStatus === 'connecting' ? 'Connecting…' : 'Select wallet'}</Button>}{pickerOpen && !connected && <div className="kit-wallet-menu">{wallets.length ? wallets.map((wallet) => <button key={wallet.name} onClick={() => { setPickerOpen(false); void connectAction.dispatchAsync(wallet); }}>{wallet.name}</button>) : <span>No compatible wallet extension detected.</span>}</div>}</div><span><small>{connected?.wallet.name ?? 'No wallet connected'}</small><strong>{walletAddress ? `${walletAddress.slice(0, 6)}…${walletAddress.slice(-6)}` : 'Solana devnet'}</strong></span></div>
    <label className="execution-mint"><span>Devnet SPL token mint</span><Input value={mintAddress} onChange={(event) => setMintAddress(event.target.value.trim())} placeholder="Enter mint address" /></label>
    <div className="execution-status"><span><small>Mint decimals</small><strong>{decimals ?? '—'}</strong></span><span><small>Source balance</small><strong>{sourceBalance === null || decimals === null ? '—' : (Number(sourceBalance) / 10 ** decimals).toLocaleString()}</strong></span><span><small>Confirmed</small><strong>{receipts.length} / {plan?.recipients.length ?? 0}</strong></span></div>
    <p className="execution-message">{message}</p>
    <div className="execution-actions"><Button variant="outline" onClick={() => void prepare()} disabled={!connected?.signer || !mintAddress || !plan || working}><RefreshCw /> Run preflight</Button><Button onClick={() => void sendNext()} disabled={!prepared || !pending || working}>{pending ? <><FileSignature /> Approve next transfer</> : <><CheckCircle2 /> Distribution complete</>}</Button></div>
    {pending && prepared && <div className="next-transfer"><span><small>NEXT RECIPIENT</small><strong>{pending.label || `${pending.address.slice(0, 8)}…${pending.address.slice(-8)}`}</strong></span><b>{pending.amount.toLocaleString()} tokens</b></div>}
    {receipts.length > 0 && <div className="execution-receipts"><strong>Confirmed receipts</strong>{receipts.slice(-4).reverse().map((receipt) => <a key={receipt.signature} href={`https://explorer.solana.com/tx/${receipt.signature}?cluster=devnet`} target="_blank" rel="noreferrer"><span>{receipt.address.slice(0, 6)}…{receipt.address.slice(-6)}</span><b>{receipt.amount.toLocaleString()}</b><ExternalLink /></a>)}</div>}
    <small className="execution-boundary"><Shield /> Mainnet is unavailable. Each transaction creates the recipient ATA if needed, preflight-simulates, requests wallet approval, and waits for devnet confirmation.</small>
  </section>;
}

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
    <header className="distribution-head"><div><span className="eyebrow"><Boxes /> DISTRIBUTION / DEVNET WORKBENCH</span><h1>Recipient Manifest</h1><p>Turn a raw allocation list into validated, wallet-approved token delivery.</p></div><span className="read-only-badge"><LockKeyhole /> MAINNET LOCKED</span></header>
    <div className="distribution-layout">
      <section className="distribution-editor">
        <div className="distribution-fields"><label><span>Token supply</span><Input type="number" min={1} value={tokenSupply} onChange={(event) => setTokenSupply(Number(event.target.value))} /></label><label><span>Protected reserve</span><span className="number-wrap"><Input type="number" min={0} max={99.99} value={reservePercent} onChange={(event) => setReservePercent(Number(event.target.value))} /><b>%</b></span></label><label><span>Recipients per batch</span><Input type="number" min={1} max={12} value={batchSize} onChange={(event) => setBatchSize(Number(event.target.value))} /></label></div>
        <label className="manifest-field"><span>Recipient manifest <small>ADDRESS, AMOUNT, OPTIONAL LABEL</small></span><textarea value={manifest} onChange={(event) => setManifest(event.target.value)} spellCheck={false} aria-label="Recipient manifest" /></label>
        <div className={`manifest-state ${result.error ? 'error' : 'ready'}`}>{result.error ? <><FileWarning /> <span><strong>Manifest blocked</strong><small>{result.error}</small></span></> : <><CheckCircle2 /> <span><strong>Manifest validated</strong><small>Addresses, amounts, reserve, duplicates, and batch limits passed.</small></span></>}</div>
        <div className="distribution-actions"><Button variant="outline" onClick={() => setManifest('')}>Clear manifest</Button><Button onClick={exportManifest} disabled={!result.plan}><Download /> Export audit manifest</Button></div>
        <DistributionExecution plan={result.plan} />
      </section>
      <aside className="distribution-review">
        <div className="distribution-kpis"><article><Users /><span><small>Recipients</small><strong>{result.plan?.recipients.length ?? '—'}</strong></span></article><article><Layers3 /><span><small>Transaction batches</small><strong>{result.plan?.batches.length ?? '—'}</strong></span></article><article><Shield /><span><small>Protected reserve</small><strong>{reservePercent}%</strong></span></article></div>
        <section className="allocation-card"><header><span>Allocation review</span><b>{result.plan ? `${result.plan.allocationPercent.toFixed(2)}%` : 'BLOCKED'}</b></header><div className="allocation-track"><i style={{ width: `${Math.min(100, result.plan?.allocationPercent ?? 0)}%` }} /></div><p><span>Planned distribution</span><b>{result.plan?.totalAmount.toLocaleString() ?? '—'}</b></p><p><span>Maximum distributable</span><b>{result.plan?.distributableAmount.toLocaleString() ?? '—'}</b></p></section>
        {result.plan?.warnings.length ? <section className="distribution-warnings"><strong>Automatic corrections</strong>{result.plan.warnings.map((warning) => <p key={warning}>{warning}</p>)}</section> : null}
        <section className="batch-preview"><header><span>Batch preview</span><b>MAX {Math.max(1, Math.min(12, batchSize))} / TX</b></header>{result.plan?.batches.slice(0, 4).map((batch, index) => <div key={index}><span><b>Batch {String(index + 1).padStart(2, '0')}</b><small>{batch.length} recipient{batch.length === 1 ? '' : 's'}</small></span><em>{batch.reduce((sum, recipient) => sum + recipient.amount, 0).toLocaleString()} tokens</em></div>)}{result.plan && result.plan.batches.length > 4 && <p>+ {result.plan.batches.length - 4} more batches in exported manifest</p>}</section>
        <div className="distribution-boundary"><LockKeyhole /><p><strong>Execution is approval-gated.</strong> Only the blue devnet console can move tokens, one confirmed wallet-approved transfer at a time. Exporting a manifest never sends funds.</p></div>
      </aside>
    </div>
  </div>;
}
