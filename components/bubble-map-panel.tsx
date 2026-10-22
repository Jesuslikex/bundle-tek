'use client';
import { useLayoutEffect, useRef, useState } from 'react';
import { Button } from './ui/button';
import {
  readBubbleMapFunding,
  isBubbleMapAddress,
  BubbleMapReadError,
  bubbleFunders,
  bubbleUnknownReason,
  type BubbleLookup,
  type BubbleReadProgress,
} from '@/lib/bubble-map-client';
import styles from './bubble-map-panel.module.css';
import {
  buildBubbleMap,
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

type Props = {
  holders: BubbleHolder[];
  teamWallets: string[];
  totalSupplyRaw: string;
};
export function BubbleMapPanel(props: Props) {
  // A committed input change remounts the read scope, including A -> B -> A.
  return <BubbleMapRead key={JSON.stringify(props)} {...props} />;
}
function BubbleMapRead({ holders, teamWallets, totalSupplyRaw }: Props) {
  const [map, setMap] = useState<BubbleMap | null>(null);
  const [rows, setRows] = useState<Record<string, BubbleLookup>>({});
  const [progress, setProgress] = useState<BubbleReadProgress | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef<AbortController | null>(null);
  useLayoutEffect(() => () => pending.current?.abort(), []);
  const startButton = useRef<HTMLButtonElement | null>(null);
  const restoreFocus = useRef(false);
  useLayoutEffect(() => {
    if (!busy && restoreFocus.current) {
      restoreFocus.current = false;
      startButton.current?.focus();
    }
  }, [busy]);
  let invalid = 0;
  let conflict = false;
  const unique = new Map<string, BubbleHolder>();
  for (const holder of holders) {
    if (
      !isBubbleMapAddress(holder.owner) ||
      !/^(0|[1-9]\d{0,77})$/.test(holder.raw)
    ) {
      invalid++;
      continue;
    }
    const prior = unique.get(holder.owner);
    if (prior) {
      if (prior.raw !== holder.raw) conflict = true;
      invalid++;
    } else unique.set(holder.owner, holder);
  }
  const validTeam = new Set<string>();
  for (const wallet of teamWallets) {
    if (!isBubbleMapAddress(wallet) || validTeam.has(wallet)) {
      invalid++;
      continue;
    }
    validTeam.add(wallet);
  }
  const candidates = [
    ...unique.values(),
    ...[...validTeam]
      .filter((w) => !unique.has(w))
      .map((owner) => ({ owner, raw: '0' })),
  ];
  const nodes = candidates.slice(0, 32);
  const includedTeam = [...validTeam].filter((w) =>
    nodes.some((n) => n.owner === w),
  );
  const supplyAvailable = /^[1-9]\d{0,77}$/.test(totalSupplyRaw);
  const unknown = Object.values(rows).filter((row) => !row.funder).length;
  async function run() {
    if (pending.current || !nodes.length || conflict || !supplyAvailable)
      return;
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setError('');
    setMap(null);
    setRows({});
    setProgress(null);
    try {
      const result = await readBubbleMapFunding(
        nodes.map((n) => n.owner),
        controller.signal,
        (value) => {
          if (pending.current === controller) setProgress(value);
        },
      );
      if (controller.signal.aborted || pending.current !== controller) return;
      setMap(
        buildBubbleMap(
          nodes,
          bubbleFunders(result),
          totalSupplyRaw,
          teamWallets,
        ),
      );
      setRows(result);
    } catch (failure) {
      if (!controller.signal.aborted && pending.current === controller) {
        setProgress(null);
        setError(
          failure instanceof BubbleMapReadError
            ? failure.message
            : 'Funding links could not be checked. Wait at least 10 seconds, refresh holder data and try again. No automatic retry was made.',
        );
      }
    } finally {
      if (pending.current === controller) {
        pending.current = null;
        setBusy(false);
      }
    }
  }
  function cancel() {
    restoreFocus.current = true;
    pending.current?.abort();
    pending.current = null;
    setBusy(false);
    setProgress(null);
    setError(
      'Funding check cancelled. No further groups will be requested. Reads already received by the provider may finish. Wait at least 10 seconds before starting a new check.',
    );
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
        Looks for a supported SOL funding source in the oldest returned
        transaction, within three provider history pages. Missing or unsupported
        evidence stays unknown. Provider history may be incomplete. A shared
        funder can be an exchange, so a cluster is a signal, not proof.
      </p>
      <p className={styles.coverage}>
        {nodes.length} of {candidates.length} holder and team wallets in this
        map.
        {candidates.length > nodes.length &&
          ` ${candidates.length - nodes.length} are outside the first 32 and are not checked.`}
        {invalid > 0 &&
          ` ${invalid} invalid or duplicate entries were excluded.`}
        {validTeam.size > 0 &&
          ` ${includedTeam.length} of ${validTeam.size} valid team wallets are included.`}
        {conflict &&
          ' Holder balances disagree for a duplicate wallet. Refresh holder data before mapping.'}
        {!supplyAvailable &&
          ' A positive total supply is required to show supply shares. Refresh holder data before mapping.'}
        {!nodes.length && ' Load holder data to start a map.'}
      </p>
      <div className={styles.controls}>
        <Button
          ref={startButton}
          type="button"
          variant="outline"
          disabled={busy || !nodes.length || conflict || !supplyAvailable}
          onClick={() => void run()}
        >
          {busy ? 'Reading funding history…' : 'Map funding links'}
        </Button>
        {busy && (
          <Button type="button" variant="outline" onClick={cancel}>
            Cancel funding check
          </Button>
        )}
      </div>
      {progress && (
        <output className={styles.coverage}>
          {progress.completed} of {progress.total} wallets checked.
          {progress.phase === 'waiting'
            ? ' Waiting 10 seconds before the next group to respect the read limit.'
            : progress.phase === 'reading'
              ? ` Reading group ${progress.group} of ${progress.groups}.`
              : ' Check complete.'}
        </output>
      )}
      {error && <p role="alert">{error}</p>}
      {!busy && map && (
        <>
          <p>
            Clustered supply {pct(map.clusteredBasisPoints)} across{' '}
            {map.clusters.length} cluster{map.clusters.length === 1 ? '' : 's'}.
            {includedTeam.length > 0 &&
              ` Linked to checked team wallets: ${pct(map.ownedClusteredBasisPoints)}.`}
            {validTeam.size > 0 &&
              includedTeam.length === 0 &&
              ' Team-wallet links were not checked because no team wallet is included.'}
            {unknown > 0 &&
              ` ${unknown} wallet(s) had no usable funding evidence in this bounded lookup.`}
          </p>
          {unknown > 0 && (
            <details className={styles.unknown}>
              <summary>
                Why {unknown} funding{' '}
                {unknown === 1 ? 'source is' : 'sources are'} unknown
              </summary>
              <ul>
                {Object.entries(rows)
                  .filter(([, row]) => !row.funder)
                  .map(([owner, row]) => (
                    <li key={owner}>
                      <span>{owner}</span>: {bubbleUnknownReason(row)}
                    </li>
                  ))}
              </ul>
            </details>
          )}
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
