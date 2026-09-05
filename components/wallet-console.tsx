'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { address } from '@solana/kit';
import { useConnect, useConnectedWallet, useDisconnect, useSignMessage, useWalletStatus, useWallets } from '@solana/kit-plugin-wallet/react';
import bs58 from 'bs58';
import { CheckCircle2, ExternalLink, FileSignature, RefreshCw, Shield, WalletCards } from 'lucide-react';
import { useAppClient } from '@/components/solana-provider';
import { Button } from '@/components/ui/button';
import { lamportsToSolNumber } from '@/lib/solana-format';

type ConsoleState = 'idle' | 'working' | 'ready' | 'error';
type AuditEvent = { id: string; eventType: string; transactionSignature?: string | null; createdAt: string };

export function WalletConsole() {
  const client = useAppClient();
  const wallets = useWallets(client);
  const connected = useConnectedWallet(client);
  const walletStatus = useWalletStatus(client);
  const connectAction = useConnect(client);
  const disconnectAction = useDisconnect(client);
  const signMessageAction = useSignMessage(client);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [balance, setBalance] = useState<number | null>(null);
  const [verified, setVerified] = useState(false);
  const [prepared, setPrepared] = useState(false);
  const [signature, setSignature] = useState<string | null>(null);
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [state, setState] = useState<ConsoleState>('idle');
  const [message, setMessage] = useState('Connect a Wallet Standard wallet to begin.');
  const walletAddress = connected?.account.address ?? null;
  const shortAddress = useMemo(() => walletAddress ? `${walletAddress.slice(0, 5)}…${walletAddress.slice(-5)}` : '—', [walletAddress]);

  const refreshAudit = useCallback(async () => {
    if (!walletAddress) return;
    const response = await fetch(`/api/wallet/events?address=${encodeURIComponent(walletAddress)}`, { cache: 'no-store' });
    if (response.ok) setEvents(((await response.json()) as { events: AuditEvent[] }).events);
  }, [walletAddress]);

  const refreshBalance = useCallback(async () => {
    if (!walletAddress) return;
    const result = await client.rpc.getBalance(address(walletAddress), { commitment: 'confirmed' }).send();
    setBalance(lamportsToSolNumber(result.value));
  }, [client, walletAddress]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setVerified(false); setPrepared(false); setSignature(null);
      if (!walletAddress) { setBalance(null); setEvents([]); setMessage('Connect a Wallet Standard wallet to begin.'); return; }
      setMessage('Wallet connected on devnet. Verify ownership with a one-time server challenge.');
      void Promise.all([refreshBalance(), refreshAudit()]).catch(() => setMessage('Wallet connected, but devnet data could not be fully loaded.'));
    }, 0);
    return () => window.clearTimeout(timer);
  }, [walletAddress, refreshBalance, refreshAudit]);

  const verifyOwnership = async () => {
    if (!walletAddress) return;
    setState('working'); setMessage('Creating a five-minute, single-use ownership challenge…');
    try {
      const challengeResponse = await fetch('/api/wallet/challenge', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ address: walletAddress }) });
      const challenge = await challengeResponse.json() as { id?: string; message?: string; error?: string };
      if (!challengeResponse.ok || !challenge.id || !challenge.message) throw new Error(challenge.error ?? 'Challenge creation failed');
      const signed = await signMessageAction.dispatchAsync(new TextEncoder().encode(challenge.message));
      const verifyResponse = await fetch('/api/wallet/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: challenge.id, address: walletAddress, signature: bs58.encode(signed) }) });
      const result = await verifyResponse.json() as { verified?: boolean; verifiedAt?: string; error?: string };
      if (!verifyResponse.ok || !result.verified) throw new Error(result.error ?? 'Server verification failed');
      setVerified(true); setState('ready'); setMessage(`Ownership verified by the server · ${new Date(result.verifiedAt!).toLocaleTimeString()}`);
      await refreshAudit();
    } catch (error) { setState('error'); setMessage(error instanceof Error ? error.message : 'Signature request was rejected.'); }
  };

  const prepare = async () => {
    if (!verified) return;
    setState('working'); setMessage('Checking devnet health and preparing the memo instruction…');
    try {
      await client.rpc.getLatestBlockhash({ commitment: 'confirmed' }).send();
      setPrepared(true); setState('ready');
      setMessage('Ready. Solana Kit will estimate resources and preflight-simulate before broadcast; your wallet shows the final fee.');
    } catch (error) { setState('error'); setMessage(error instanceof Error ? error.message : 'Devnet preparation failed.'); }
  };

  const submit = async () => {
    if (!verified || !prepared || !connected?.signer || state === 'working') return;
    setState('working'); setMessage('Waiting for wallet approval. This submits only a devnet memo and network fee.');
    try {
      const nextSignature = await client.memo.instructions.addMemo({ memo: `PulseForge verified devnet wallet ${new Date().toISOString()}`, signers: [connected.signer] }).sendTransaction();
      const signatureText = nextSignature.context.signature;
      const auditResponse = await fetch('/api/wallet/events', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ address: walletAddress, signature: signatureText }) });
      const audit = await auditResponse.json() as { recorded?: boolean; error?: string };
      if (!auditResponse.ok || !audit.recorded) throw new Error(audit.error ?? 'Transaction confirmed but audit recording failed');
      setSignature(signatureText); setState('ready'); setMessage('Devnet memo confirmed and independently recorded in the D1 audit log.');
      await Promise.all([refreshBalance(), refreshAudit()]);
    } catch (error) { setState('error'); setMessage(error instanceof Error ? error.message : 'Transaction was rejected or failed.'); }
  };

  return <section className="wallet-console">
    <header><span><WalletCards /> Your wallet</span><b>DEVNET</b></header>
    <div className="wallet-next-step"><strong>{signature ? 'Test complete' : !connected ? '1. Connect your wallet' : !verified ? '2. Verify ownership' : !prepared ? '3. Prepare the test' : '4. Review and sign'}</strong><p>{signature ? 'Your memo transaction is recorded. Open the receipt below to inspect it.' : !connected ? 'Select the wallet holding your devnet SOL.' : !verified ? 'Sign a message to prove this wallet is yours. This step has no network fee.' : !prepared ? 'Check the devnet connection before requesting a transaction signature.' : 'The test writes a memo and uses a small devnet network fee.'}</p></div>
    <div className="wallet-connect-row">
      <div className="kit-wallet-picker">{connected ? <Button onClick={() => void disconnectAction.dispatchAsync()} disabled={disconnectAction.isRunning}>Disconnect</Button> : <Button onClick={() => setPickerOpen((open) => !open)} disabled={walletStatus === 'pending' || walletStatus === 'connecting'}>{walletStatus === 'connecting' ? 'Connecting…' : 'Select wallet'}</Button>}{pickerOpen && !connected && <div className="kit-wallet-menu">{wallets.length ? wallets.map((wallet) => <button key={wallet.name} onClick={() => { setPickerOpen(false); void connectAction.dispatchAsync(wallet); }}>{wallet.name}</button>) : <span>No compatible wallet extension detected.</span>}</div>}</div>
      <span><small>{connected?.wallet.name ?? 'No wallet'}</small><strong>{shortAddress}</strong></span>
      <Button variant="outline" onClick={() => void refreshBalance().catch(() => { setState('error'); setMessage('Could not refresh the balance. Try again.'); })} disabled={!connected || state === 'working'} aria-label="Refresh wallet balance"><RefreshCw /></Button>
    </div>
    <div className="wallet-kpis"><span><small>Network</small><strong>Solana devnet</strong></span><span><small>Balance</small><strong>{balance === null ? '—' : `${balance.toFixed(4)} SOL`}</strong></span><span><small>Ownership</small><strong className={verified ? 'safe' : ''}>{verified ? 'SERVER VERIFIED' : 'UNVERIFIED'}</strong></span></div>
    <div className="wallet-actions"><Button variant="outline" onClick={() => void verifyOwnership()} disabled={!connected?.signer || state === 'working'}><FileSignature /> Verify ownership</Button><Button variant="outline" onClick={() => void prepare()} disabled={!verified || state === 'working'}><Shield /> Prepare preflight</Button><Button onClick={() => void submit()} disabled={!prepared || !verified || state === 'working'}><CheckCircle2 /> Sign &amp; submit</Button></div>
    {prepared && <div className="wallet-review"><span>Instruction <b>Memo only</b></span><span>SOL transfer <b>0 SOL</b></span><span>Resource estimate <b>ENABLED</b></span><span>RPC preflight <b>ENABLED</b></span></div>}
    <output aria-live="polite" className={`wallet-message ${state}`}>{message}</output>
    {signature && <a className="wallet-explorer" href={`https://explorer.solana.com/tx/${signature}?cluster=devnet`} target="_blank" rel="noreferrer">View confirmed transaction <ExternalLink /></a>}
    {events.length > 0 && <div className="wallet-audit"><strong>Persistent audit trail</strong>{events.slice(0, 3).map((event) => <span key={event.id}><b>{event.eventType.replaceAll('_', ' ')}</b><small>{new Date(event.createdAt).toLocaleString()}</small></span>)}</div>}
    <small className="wallet-boundary">Challenges expire after five minutes and can be used once. PulseForge never receives or stores private keys.</small>
  </section>;
}
