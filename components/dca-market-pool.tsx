'use client';
import { useEffect, useRef, useState } from 'react';
import { Button } from './ui/button';
import { walletAddress } from '@/lib/wallet-workspace';
import { marketUsdMicros } from '@/lib/market-trigger';

type PoolProps = {
  project: {
    id: string;
    revision: number;
    document: { token: { address: string } };
  };
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
};
export function DcaMarketPool(props: PoolProps) {
  return (
    <DcaMarketPoolContext
      key={`${props.project.id}:${props.project.revision}`}
      {...props}
    />
  );
}
function DcaMarketPoolContext({
  project,
  value,
  disabled,
  onChange,
}: PoolProps) {
  const pending = useRef<AbortController | null>(null);
  const [pools, setPools] = useState<
    { address: string; dex: string; cap: number }[]
  >([]);
  const [loading, setLoading] = useState(false),
    [message, setMessage] = useState('');
  useEffect(() => {
    return () => {
      pending.current?.abort();
      pending.current = null;
    };
  }, []);
  async function load() {
    if (disabled || pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    setLoading(true);
    setMessage('');
    try {
      const response = await fetch(
        `/api/imported-projects/market?id=${encodeURIComponent(project.id)}&revision=${project.revision}`,
        { cache: 'no-store', signal: controller.signal },
      );
      const body = (await response.json()) as {
        id: string;
        revision: number;
        executionAllowed: boolean;
        observations: unknown[];
      };
      const sample = body.observations?.[0] as {
        chain: string;
        address: string;
        projectRevision: number;
        source: string;
        executionAllowed: boolean;
        observedAt: string;
        pairs: { address: string; dex: string; marketCapUsd: number | null }[];
      };
      if (
        !response.ok ||
        body.id !== project.id ||
        body.revision !== project.revision ||
        body.executionAllowed !== false ||
        sample?.chain !== 'Solana' ||
        sample.address !== project.document.token.address ||
        sample.projectRevision !== project.revision ||
        sample.source !== 'api.dexscreener.com' ||
        sample.executionAllowed !== false ||
        !Number.isFinite(Date.parse(sample.observedAt)) ||
        !Array.isArray(sample.pairs) ||
        sample.pairs.length > 100
      )
        throw Error('Refresh the market workspace, then load its pools again.');
      const choices: typeof pools = [];
      const seen = new Set<string>();
      for (const p of sample.pairs) {
        const address = walletAddress(p.address, 'Solana');
        if (
          seen.has(address) ||
          typeof p.dex !== 'string' ||
          !/^[a-zA-Z0-9_-]{1,64}$/.test(p.dex)
        )
          throw Error('Saved pool coverage differs. Refresh the market.');
        seen.add(address);
        if (p.marketCapUsd === null) continue;
        if (
          typeof p.marketCapUsd !== 'number' ||
          !Number.isFinite(p.marketCapUsd)
        )
          throw Error('Market cap unavailable.');
        try {
          marketUsdMicros(String(p.marketCapUsd));
        } catch {
          continue;
        }
        choices.push({ address, dex: p.dex, cap: p.marketCapUsd });
      }
      if (controller.signal.aborted) return;
      setPools(choices);
      if (!choices.some((p) => p.address === value)) onChange('');
      setMessage(
        choices.length
          ? `Saved observation: ${sample.observedAt}. Each cycle needs a current market observation.`
          : 'No saved pool has supported market-cap data. Refresh the market workspace.',
      );
    } catch {
      if (!controller.signal.aborted) {
        setPools([]);
        onChange('');
        setMessage(
          'Pool selection unavailable. Refresh the market workspace and retry.',
        );
      }
    } finally {
      if (!controller.signal.aborted) setLoading(false);
      if (pending.current === controller) pending.current = null;
    }
  }
  return (
    <div className="space-y-2">
      <Button
        type="button"
        disabled={disabled || loading}
        onClick={() => void load()}
      >
        {loading ? 'Loading pools…' : 'Load saved market pools'}
      </Button>
      <label>
        Selected market pool
        <select
          value={value}
          disabled={disabled || loading || !pools.length}
          onChange={(e) => onChange(e.target.value)}
        >
          <option value="">Choose a pool</option>
          {pools.map((p) => (
            <option key={p.address} value={p.address}>
              {p.dex} · {p.address} · ${p.cap}
            </option>
          ))}
        </select>
      </label>
      <output aria-live="polite">{message}</output>
    </div>
  );
}
