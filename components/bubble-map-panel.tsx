'use client';
import { useEffect, useRef, useState } from 'react';
import { Button } from './ui/button';
import {
  buildBubbleMap,
  type BubbleFunder,
  type BubbleHolder,
  type BubbleMap,
} from '@/lib/bubble-map';

const COLORS = [
  '#2563eb',
  '#db2777',
  '#d97706',
  '#059669',
  '#7c3aed',
  '#dc2626',
];
const pct = (bps: number) => (bps / 100).toFixed(2) + '%';
const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;

export function BubbleMapPanel({
  holders,
  teamWallets,
  totalSupplyRaw,
}: {
  holders: BubbleHolder[];
  teamWallets: string[];
  totalSupplyRaw: string;
}) {
  const [map, setMap] = useState<BubbleMap | null>(null);
  const [unknown, setUnknown] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  // Team wallets join the map at zero sampled units so links to them show up.
  const team = teamWallets.filter((w) => !holders.some((h) => h.owner === w));
  const nodes = [
    ...holders,
    ...team.map((owner) => ({ owner, raw: '0' })),
  ].slice(0, 32);
  async function run() {
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setError('');
    try {
      const funders: Record<string, BubbleFunder | null> = {};
      let missing = 0;
      for (let i = 0; i < nodes.length; i += 20) {
        const response = await fetch('/api/supply/bubble-map', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            addresses: nodes.slice(i, i + 20).map((n) => n.owner),
          }),
          signal: AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(60000),
          ]),
        });
        const value = (await response.json()) as {
          funders?: Record<string, { funder: BubbleFunder | null }>;
          error?: string;
        };
        if (!response.ok || !value.funders)
          throw new Error(value.error || 'Funding history unavailable.');
        for (const n of nodes.slice(i, i + 20)) {
          const found = value.funders[n.owner]?.funder ?? null;
          if (!found) missing++;
          funders[n.owner] = found;
        }
      }
      if (controller.signal.aborted) return;
      setMap(buildBubbleMap(nodes, funders, totalSupplyRaw, teamWallets));
      setUnknown(missing);
    } catch (e) {
      if (!controller.signal.aborted)
        setError(e instanceof Error ? e.message : 'Bubble map unavailable.');
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  const size = 320,
    center = size / 2;
  const placed = map
    ? map.nodes.map((n, i) => {
        const angle = (2 * Math.PI * i) / map.nodes.length;
        const ring = n.cluster ? 90 : 130;
        return {
          ...n,
          x: center + ring * Math.cos(angle),
          y: center + ring * Math.sin(angle),
          r: n.raw === '0' ? 5 : 6 + Math.sqrt(n.supplyBasisPoints) * 1.2,
        };
      })
    : [];
  const at = new Map(placed.map((p) => [p.owner, p]));
  return (
    <section aria-label="Bubble map" className="min-w-0 space-y-3">
      <h4>Bubble map</h4>
      <p className="text-xs text-muted-foreground">
        Links these holders by the wallet that first sent each of them SOL, the
        way bubble map tools do. It reads public history only. A shared funder
        can be an exchange, so a cluster is a signal, not proof.
      </p>
      <Button
        type="button"
        variant="outline"
        disabled={busy || !nodes.length}
        onClick={() => void run()}
      >
        {busy ? 'Reading funding history…' : 'Map funding links'}
      </Button>
      {error && <p role="alert">{error}</p>}
      {map && (
        <>
          <p>
            Clustered supply {pct(map.clusteredBasisPoints)} across{' '}
            {map.clusters.length} cluster{map.clusters.length === 1 ? '' : 's'}.
            {teamWallets.length > 0 &&
              ` Linked to your team wallets: ${pct(map.ownedClusteredBasisPoints)}.`}
            {unknown > 0 &&
              ` ${unknown} wallet(s) had no readable first funder.`}
          </p>
          <svg
            viewBox={`0 0 ${size} ${size}`}
            className="w-full max-w-sm"
            aria-labelledby="bubble-map-title"
          >
            <title id="bubble-map-title">Holder funding clusters</title>
            {map.links.map((l) => {
              const a = at.get(l.from),
                b = at.get(l.to);
              const from = a ?? { x: center, y: center };
              return b ? (
                <line
                  key={l.from + l.to}
                  x1={from.x}
                  y1={from.y}
                  x2={b.x}
                  y2={b.y}
                  stroke="currentColor"
                  strokeOpacity={0.3}
                />
              ) : null;
            })}
            {placed.map((p) => (
              <circle
                key={p.owner}
                cx={p.x}
                cy={p.y}
                r={p.r}
                fill={
                  p.cluster
                    ? COLORS[(p.cluster - 1) % COLORS.length]
                    : '#9ca3af'
                }
                stroke={p.owned ? 'currentColor' : 'none'}
                strokeWidth={2}
              >
                <title>
                  {p.owner}
                  {p.owned ? ' (your team)' : ''} · {pct(p.supplyBasisPoints)}
                  {p.funder ? ` · funded by ${p.funder}` : ''}
                </title>
              </circle>
            ))}
          </svg>
          {map.clusters.length > 0 && (
            <ul className="space-y-1 text-sm">
              {map.clusters.map((c) => (
                <li key={c.id}>
                  Cluster {c.id}: {c.owners.length} wallets,{' '}
                  {pct(c.supplyBasisPoints)}
                  {c.sharedFunders.length > 0 &&
                    ` · shared funder ${c.sharedFunders.map(short).join(', ')}`}
                  {c.ownedWallets.length > 0 && ' · includes your team wallets'}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
