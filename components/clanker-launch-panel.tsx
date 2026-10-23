'use client';
import { useCallback, useLayoutEffect, useRef, useState } from 'react';
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

type Props = {
  name?: string;
  symbol?: string;
  venue?: ClankerInterface;
};

export function ClankerLaunchPanel({
  name = '',
  symbol = '',
  venue: initialVenue = 'Clanker',
}: Props) {
  return (
    <ClankerLaunchDraft
      key={JSON.stringify([name, symbol, initialVenue])}
      name={name}
      symbol={symbol}
      venue={initialVenue}
    />
  );
}

function ClankerLaunchDraft({
  name,
  symbol,
  venue: initialVenue,
}: Required<Props>) {
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
  const [reviewedSymbol, setReviewedSymbol] = useState('');
  const revision = useRef(0),
    reviewedRevision = useRef<number | null>(null);
  const reviewedProvider = useRef<Provider | null>(null);
  const mounted = useRef(true),
    running = useRef(false),
    approved = useRef(false);
  const provider = () =>
    (globalThis as { ethereum?: Provider }).ethereum ?? null;

  const invalidateReview = useCallback(() => {
    revision.current++;
    reviewedRevision.current = null;
    reviewedProvider.current = null;
    approved.current = false;
    setCall(null);
    setGas(null);
    setAck(false);
    setReviewedSymbol('');
  }, []);

  useLayoutEffect(() => {
    mounted.current = true;
    if (
      reviewedRevision.current !== null &&
      reviewedRevision.current !== revision.current
    )
      invalidateReview();
    return () => {
      mounted.current = false;
      revision.current++;
      approved.current = false;
    };
  }, [invalidateReview]);

  function current(version: number, p: Provider) {
    return mounted.current && revision.current === version && provider() === p;
  }

  async function guarded(task: () => Promise<void>) {
    if (running.current || !mounted.current) return;
    running.current = true;
    setBusy(true);
    setError('');
    let version = revision.current;
    try {
      const pending = task();
      version = revision.current;
      await pending;
    } catch (e) {
      if (mounted.current && revision.current === version)
        setError(walletError(e));
    } finally {
      running.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  async function prepare() {
    invalidateReview();
    const version = revision.current,
      capturedDraft = { ...draft };
    const p = provider();
    if (!p) throw new Error('No browser wallet found.');
    const account = (await connectEvmWallet(p as never, 'Base', () =>
      current(version, p),
    )) as Address;
    if (!current(version, p)) return;
    const next = await clankerDeployCall({
      ...capturedDraft,
      venue,
      admin: account,
    });
    if (!current(version, p)) return;
    // Simulate on Base before the wallet is ever asked to sign.
    await client().call({
      account: next.from,
      to: next.to,
      data: next.data,
      value: next.value,
    });
    if (!current(version, p)) return;
    const estimate = await client().estimateGas({
      account: next.from,
      to: next.to,
      data: next.data,
      value: next.value,
    });
    if (!current(version, p)) return;
    setGas(estimate);
    reviewedRevision.current = version;
    reviewedProvider.current = p;
    setReviewedSymbol(capturedDraft.symbol.trim());
    setCall(next);
    setAck(false);
  }

  async function send() {
    const p = provider();
    const version = revision.current;
    if (
      !p ||
      !call ||
      !approved.current ||
      reviewedRevision.current !== version
    )
      return;
    if (reviewedProvider.current !== p) {
      invalidateReview();
      throw new Error('Wallet provider changed. Simulate again.');
    }
    const account = await connectEvmWallet(p as never, 'Base', () =>
      current(version, p),
    );
    if (
      !current(version, p) ||
      reviewedRevision.current !== version ||
      !approved.current
    )
      return;
    if (account.toLowerCase() !== call.from.toLowerCase()) {
      invalidateReview();
      setError('Wallet account changed. Simulate again.');
      return;
    }
    // One wallet handoff per explicit acknowledgement, including rejected requests.
    approved.current = false;
    setAck(false);
    const sent = (await p.request({
      method: 'eth_sendTransaction',
      params: walletRequestParams(call),
    })) as Hex;
    if (mounted.current) {
      setHash(sent);
      setStatus('pending');
    }
  }

  async function refresh() {
    if (!hash) return;
    const r = await client()
      .getTransactionReceipt({ hash })
      .catch(() => null);
    if (mounted.current) setStatus(r ? r.status : 'status unknown');
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
                invalidateReview();
                setVenue(v);
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
              disabled={busy || Boolean(hash)}
              onChange={(e) => {
                invalidateReview();
                setDraft({ ...draft, [key]: e.target.value });
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
            Deploys {reviewedSymbol} from {call.from} with{' '}
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
              disabled={busy}
              onChange={(e) => {
                approved.current = e.target.checked;
                setAck(e.target.checked);
              }}
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
