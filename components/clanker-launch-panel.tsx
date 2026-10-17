'use client';
import { useState } from 'react';
import { createPublicClient, http, type Address, type Hex } from 'viem';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { EVM_NETWORKS } from '@/lib/evm-network';
import { connectEvmWallet, walletError } from '@/lib/evm-wallet';
import {
  clankerDeployCall,
  walletRequestParams,
  type WalletCall,
} from '@/lib/clanker/launch';

type Provider = {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
};
let baseClient: ReturnType<typeof createPublicClient> | null = null;
const client = () =>
  (baseClient ??= createPublicClient({
    transport: http(EVM_NETWORKS.Base.endpoint),
  }));

export function ClankerLaunchPanel({
  name = '',
  symbol = '',
}: {
  name?: string;
  symbol?: string;
}) {
  const [draft, setDraft] = useState({ name, symbol, image: '' });
  const [call, setCall] = useState<WalletCall | null>(null);
  const [gas, setGas] = useState<bigint | null>(null);
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [hash, setHash] = useState<Hex | null>(null);
  const [status, setStatus] = useState('');
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
    const p = provider();
    if (!p) throw new Error('No browser wallet found.');
    const account = (await connectEvmWallet(p as never, 'Base')) as Address;
    const next = await clankerDeployCall({ ...draft, admin: account });
    // Simulate on Base before the wallet is ever asked to sign.
    await client().call({
      account: next.from,
      to: next.to,
      data: next.data,
      value: next.value,
    });
    setGas(
      await client().estimateGas({
        account: next.from,
        to: next.to,
        data: next.data,
        value: next.value,
      }),
    );
    setCall(next);
    setAck(false);
  }

  async function send() {
    const p = provider();
    if (!p || !call) return;
    await connectEvmWallet(p as never, 'Base').then((a) => {
      if (a.toLowerCase() !== call.from.toLowerCase())
        throw new Error('Wallet account changed. Simulate again.');
    });
    const sent = (await p.request({
      method: 'eth_sendTransaction',
      params: walletRequestParams(call),
    })) as Hex;
    setHash(sent);
    setStatus('pending');
  }

  async function refresh() {
    if (!hash) return;
    const r = await client()
      .getTransactionReceipt({ hash })
      .catch(() => null);
    setStatus(r ? r.status : 'pending');
  }

  return (
    <section aria-label="Clanker launch" className="min-w-0 space-y-2">
      <h3>Launch on Clanker (Base)</h3>
      <p className="text-xs text-muted-foreground">
        Builds the deploy with the official Clanker SDK, checks it targets the
        official Clanker v4 factory, simulates it on Base, then your browser
        wallet shows the transaction and you confirm it. Your wallet becomes the
        token admin.
      </p>
      <div className="grid gap-2 sm:grid-cols-3">
        {(['name', 'symbol', 'image'] as const).map((key) => (
          <Input
            key={key}
            aria-label={key === 'image' ? 'Image link' : `Token ${key}`}
            placeholder={key === 'image' ? 'Image link (optional)' : key}
            value={draft[key]}
            onChange={(e) => {
              setDraft({ ...draft, [key]: e.target.value });
              setCall(null);
            }}
          />
        ))}
      </div>
      <Button
        type="button"
        variant="outline"
        disabled={busy || Boolean(hash)}
        onClick={() => void guarded(prepare)}
      >
        Simulate launch
      </Button>
      {call && !hash && (
        <div className="space-y-2">
          <p>
            Deploys {draft.symbol} from {call.from} with 0 ETH. Estimated gas{' '}
            {gas?.toString() ?? '—'} units.
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
            disabled={busy || !ack}
            onClick={() => void guarded(send)}
          >
            Send with my wallet
          </Button>
        </div>
      )}
      {hash && (
        <p>
          Launch {status} · {hash}{' '}
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
