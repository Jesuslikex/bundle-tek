'use client';
import { useState } from 'react';
import { formatEther, type Hex } from 'viem';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { connectEvmWallet, walletError } from '@/lib/evm-wallet';
import {
  ponsIntent,
  randomSalt,
  walletTransaction,
  type PonsDraft,
  type UnsignedEnvelope,
} from '@/lib/pons/client';

type Provider = {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
};
type Job = {
  id: string;
  state: string;
  revision: number;
  handoff: { usable: boolean; reason: string };
  result: {
    ok?: boolean;
    error?: string;
    launchFeeWei?: string;
    expiresAt?: number;
    output?: { tokensOut?: string; token?: string };
    unsignedTransaction?: UnsignedEnvelope;
    receipt?: { hash?: string };
  } | null;
};

async function api(path: string, body?: unknown, key?: string) {
  const response = await fetch(`/api/pons/jobs${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    cache: 'no-store',
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(key ? { 'idempotency-key': key } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const value = (await response.json().catch(() => ({}))) as {
    job?: Job;
    error?: string;
  };
  if (response.status === 423)
    throw new Error('Pons launching is switched off on this server.');
  if (!response.ok || !value.job)
    throw new Error(value.error || `Pons request failed (${response.status}).`);
  return value.job;
}

const eth = (wei: string) => formatEther(BigInt(wei));
const gasCost = (t: UnsignedEnvelope) =>
  formatEther(BigInt(t.gas) * BigInt(t.gasPrice));

const LABELS: [keyof PonsDraft, string][] = [
  ['description', 'Description'],
  ['logo', 'Logo URL'],
  ['website', 'Website'],
  ['twitter', 'X / Twitter'],
  ['telegram', 'Telegram'],
  ['buyEth', 'Initial buy (ETH)'],
  ['maxTotalEth', 'Max total incl. launch fee (ETH)'],
  ['maxGasEth', 'Max gas cost (ETH)'],
  ['minTokensOut', 'Minimum tokens out (raw units)'],
];

export function PonsLaunchPanel({
  name,
  symbol,
}: {
  name: string;
  symbol: string;
}) {
  const [draft, setDraft] = useState<PonsDraft>({
    name,
    symbol,
    description: '',
    logo: '',
    website: '',
    twitter: '',
    telegram: '',
    buyEth: '',
    maxTotalEth: '',
    maxGasEth: '0.01',
    minTokensOut: '1',
    creatorTaxBps: 0,
  });
  const [account, setAccount] = useState('');
  const [job, setJob] = useState<Job | null>(null);
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const provider = () =>
    (globalThis as { ethereum?: Provider }).ethereum ?? null;
  async function guarded(task: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await task();
    } catch (e) {
      setError(walletError(e));
    } finally {
      setBusy(false);
    }
  }
  async function prepare() {
    const wallet = provider();
    if (!wallet) throw new Error('No browser wallet found.');
    const address = await connectEvmWallet(wallet as never, 'Robinhood');
    setAccount(address);
    setAck(false);
    const intent = ponsIntent(draft, address, randomSalt());
    const created = await api('', intent, crypto.randomUUID());
    const simulated = await api(`/${created.id}/simulate`, {
      revision: created.revision,
    });
    setJob(simulated);
    if (simulated.state !== 'simulated')
      throw new Error(
        `Simulation failed: ${simulated.result?.error ?? simulated.state}.`,
      );
    setJob(
      await api(`/${simulated.id}/handoff`, { revision: simulated.revision }),
    );
  }
  async function send() {
    if (!job?.result?.unsignedTransaction) return;
    // Recheck the envelope on the server right before the wallet sees it.
    const fresh = await api(`/${job.id}/handoff`, { revision: job.revision });
    setJob(fresh);
    if (!fresh.handoff.usable || !fresh.result?.unsignedTransaction)
      throw new Error('Terms changed or expired. Prepare again.');
    const hash = await provider()!.request({
      method: 'eth_sendTransaction',
      params: [walletTransaction(fresh.result.unsignedTransaction, account)],
    });
    if (typeof hash !== 'string' || !/^0x[0-9a-f]{64}$/i.test(hash))
      throw new Error('Wallet returned an unexpected transaction hash.');
    setAck(false);
    setJob(
      await api(`/${fresh.id}/receipt`, {
        revision: fresh.revision,
        txHash: hash as Hex,
      }),
    );
  }
  async function refresh() {
    if (!job?.result?.receipt?.hash) return;
    setJob(
      await api(`/${job.id}/receipt`, {
        revision: job.revision,
        txHash: job.result.receipt.hash,
      }),
    );
  }
  const tx = job?.result?.unsignedTransaction;
  const sent = Boolean(job?.result?.receipt);
  return (
    <section aria-label="Pons launch" className="min-w-0 space-y-2">
      <h3>Launch on pons.family (Robinhood)</h3>
      <p className="text-xs text-muted-foreground">
        Creates the token and your initial buy in one transaction. The server
        only simulates and checks it; your browser wallet shows the exact
        transaction and you confirm it. Pons only lets approved wallets launch.
      </p>
      <div className="grid gap-2 sm:grid-cols-2">
        <Input
          aria-label="Token name"
          placeholder="Name"
          value={draft.name}
          onChange={(e) => setDraft({ ...draft, name: e.target.value })}
        />
        <Input
          aria-label="Symbol"
          placeholder="Symbol"
          value={draft.symbol}
          onChange={(e) => setDraft({ ...draft, symbol: e.target.value })}
        />
        {LABELS.map(([key, label]) => (
          <Input
            key={key}
            aria-label={label}
            placeholder={label}
            value={String(draft[key])}
            onChange={(e) => {
              setDraft({ ...draft, [key]: e.target.value });
              setJob(null);
            }}
          />
        ))}
      </div>
      <Button
        type="button"
        variant="outline"
        disabled={busy || sent}
        onClick={() => void guarded(prepare)}
      >
        Simulate launch
      </Button>
      {tx && !sent && (
        <div className="space-y-2">
          <p>
            Sends {eth(tx.value)} ETH (launch fee{' '}
            {eth(job?.result?.launchFeeWei ?? '0')} ETH) from {tx.from}.
            Expected tokens: {job?.result?.output?.tokensOut ?? '—'}. Max gas{' '}
            {gasCost(tx)} ETH. Expires{' '}
            {new Date(job?.result?.expiresAt ?? 0).toLocaleTimeString()}.
          </p>
          <label className="block">
            <input
              type="checkbox"
              checked={ack}
              onChange={(e) => setAck(e.target.checked)}
            />{' '}
            I reviewed this launch and want my wallet to send it.
          </label>
          <Button
            type="button"
            disabled={busy || !ack || !job?.handoff.usable}
            onClick={() => void guarded(send)}
          >
            Send with my wallet
          </Button>
        </div>
      )}
      {sent && (
        <p>
          Launch {job?.state} · {job?.result?.receipt?.hash}{' '}
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => void guarded(refresh)}
          >
            Refresh status
          </Button>
        </p>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
