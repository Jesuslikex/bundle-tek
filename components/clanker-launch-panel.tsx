'use client';
import { useState } from 'react';
import {
  createPublicClient,
  formatEther,
  http,
  type Address,
  type Hex,
} from 'viem';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { EVM_NETWORKS } from '@/lib/evm-network';
import { connectEvmWallet, walletError } from '@/lib/evm-wallet';
import {
  BANKR_INTERFACE_ADDRESS,
  clankerDeployCall,
  walletRequestParams,
  type ClankerInterface,
  type ClankerLaunchSummary,
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

const FIELDS = [
  ['name', 'Token name', 'name'],
  ['symbol', 'Token symbol', 'symbol'],
  ['image', 'Image link', 'Image link (optional)'],
  ['devBuyEth', 'Dev buy ETH', 'Dev buy ETH (optional)'],
  ['vaultPercent', 'Vault percent of supply', 'Vault % (optional)'],
  ['vaultDays', 'Vault lockup days', 'Lockup days (min 7)'],
] as const;

export function ClankerLaunchPanel({
  name = '',
  symbol = '',
  venue: initialVenue = 'Clanker',
}: {
  name?: string;
  symbol?: string;
  venue?: ClankerInterface;
}) {
  const [draft, setDraft] = useState({
    name,
    symbol,
    image: '',
    devBuyEth: '',
    vaultPercent: '',
    vaultDays: '30',
  });
  const [venue, setVenue] = useState<ClankerInterface>(initialVenue);
  const [call, setCall] = useState<
    (WalletCall & { summary: ClankerLaunchSummary }) | null
  >(null);
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
    const next = await clankerDeployCall({ ...draft, venue, admin: account });
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
      <h3>Launch on {venue} (Base)</h3>
      <p className="text-xs text-muted-foreground">
        Builds the deploy with the official Clanker SDK, checks it targets the
        official Clanker v4 factory and matches this review, simulates it on
        Base, then your browser wallet shows the transaction and you confirm it.
        Your wallet becomes the token admin.
        {venue === 'Bankr' &&
          ' Bankr launches are Clanker deploys tagged for Bankr, with 20% of trading fees going to Bankr as its own docs specify.'}
      </p>
      <fieldset className="flex gap-3" disabled={busy || Boolean(hash)}>
        <legend className="sr-only">Launch interface</legend>
        {(['Clanker', 'Bankr'] as const).map((v) => (
          <label key={v} className="flex items-center gap-1">
            <input
              type="radio"
              name="clanker-launch-interface"
              value={v}
              checked={venue === v}
              onChange={() => {
                setVenue(v);
                setCall(null);
              }}
            />
            {v}
          </label>
        ))}
      </fieldset>
      <div className="grid gap-2 sm:grid-cols-3">
        {FIELDS.map(([key, label, placeholder]) =>
          key === 'vaultDays' && !draft.vaultPercent.trim() ? null : (
            <Input
              key={key}
              aria-label={label}
              placeholder={placeholder}
              inputMode={
                key === 'devBuyEth'
                  ? 'decimal'
                  : key.startsWith('vault')
                    ? 'numeric'
                    : undefined
              }
              value={draft[key]}
              disabled={Boolean(hash)}
              onChange={(e) => {
                setDraft({ ...draft, [key]: e.target.value });
                setCall(null);
              }}
            />
          ),
        )}
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
            Deploys {draft.symbol} from {call.from} with{' '}
            {formatEther(call.value)} ETH
            {call.summary.devBuyWei > 0n ? ' (dev buy to your wallet)' : ''}.
            Estimated gas {gas?.toString() ?? '—'} units.
          </p>
          <ul className="text-xs">
            {call.summary.vault && (
              <li>
                Vault: {call.summary.vault.percent}% of supply locked for{' '}
                {call.summary.vault.days} days, then released to your wallet.
              </li>
            )}
            {call.summary.rewards.map((r) => (
              <li key={r.recipient}>
                Trading fees: {r.bps / 100}% to{' '}
                {r.recipient === BANKR_INTERFACE_ADDRESS
                  ? `Bankr (${r.recipient})`
                  : `you (${r.recipient})`}
              </li>
            ))}
          </ul>
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
