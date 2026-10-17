import { walletAddress } from './wallet-workspace';

// Bubble maps link holders through who first funded them with SOL.
// This is a read-only estimate: a shared funder can also be an exchange
// hot wallet, so clusters are signals, not proof of common control.

export type BubbleFunder = {
  funder: string;
  signature: string;
  slot: number;
};
export type BubbleHolder = { owner: string; raw: string };
export type BubbleCluster = {
  id: number;
  owners: string[];
  raw: string;
  supplyBasisPoints: number;
  // Funders that link this cluster without holding the token themselves.
  sharedFunders: string[];
  ownedWallets: string[];
};
export type BubbleMap = {
  nodes: {
    owner: string;
    raw: string;
    supplyBasisPoints: number;
    cluster: number | null;
    funder: string | null;
    owned: boolean;
  }[];
  links: { from: string; to: string }[];
  clusters: BubbleCluster[];
  clusteredBasisPoints: number;
  ownedClusteredBasisPoints: number;
};

type Parsed = {
  program?: string;
  parsed?: { type?: string; info?: Record<string, unknown> };
};
type ParsedTransaction = {
  slot?: number;
  transaction?: {
    signatures?: string[];
    message?: { instructions?: Parsed[] };
  };
  meta?: {
    err?: unknown;
    innerInstructions?: { instructions?: Parsed[] }[];
  } | null;
};

/** The wallet that sent `address` its first SOL in this transaction, if any. */
export function funderInTransaction(
  tx: ParsedTransaction | null,
  address: string,
): BubbleFunder | null {
  if (!tx || tx.meta?.err) return null;
  const all = [
    ...(tx.transaction?.message?.instructions ?? []),
    ...(tx.meta?.innerInstructions ?? []).flatMap((i) => i.instructions ?? []),
  ];
  for (const ix of all) {
    if (ix.program !== 'system' || !ix.parsed?.info) continue;
    const { type, info } = ix.parsed;
    const to =
      type === 'transfer' || type === 'transferWithSeed'
        ? info.destination
        : type === 'createAccount' || type === 'createAccountWithSeed'
          ? info.newAccount
          : undefined;
    const from = info.source;
    if (to !== address || typeof from !== 'string' || from === address)
      continue;
    const signature = tx.transaction?.signatures?.[0];
    if (typeof signature !== 'string' || !Number.isSafeInteger(tx.slot))
      return null;
    try {
      return {
        funder: walletAddress(from, 'Solana'),
        signature,
        slot: tx.slot as number,
      };
    } catch {
      return null;
    }
  }
  return null;
}

const bps = (raw: bigint, total: bigint) =>
  total > 0n ? Number((raw * 10000n) / total) : 0;

export function buildBubbleMap(
  holders: BubbleHolder[],
  funders: Record<string, BubbleFunder | null>,
  totalSupplyRaw: string,
  owned: string[] = [],
): BubbleMap {
  if (holders.length > 50) throw new Error('Map up to 50 holders.');
  const total = BigInt(totalSupplyRaw);
  const index = new Map(holders.map((h, i) => [h.owner, i]));
  if (index.size !== holders.length)
    throw new Error('Each holder must appear once.');
  const parent = holders.map((_, i) => i);
  const find = (i: number): number =>
    parent[i] === i ? i : (parent[i] = find(parent[i]));
  const union = (a: number, b: number) => {
    parent[find(a)] = find(b);
  };
  const links: BubbleMap['links'] = [];
  const byFunder = new Map<string, number[]>();
  holders.forEach((h, i) => {
    const f = funders[h.owner]?.funder;
    if (!f) return;
    const j = index.get(f);
    // A holder funded by another holder links them directly.
    if (j !== undefined) {
      union(i, j);
      links.push({ from: f, to: h.owner });
    } else byFunder.set(f, [...(byFunder.get(f) ?? []), i]);
  });
  const sharedFunders = new Map<number, Set<string>>();
  for (const [funder, members] of byFunder) {
    if (members.length < 2) continue;
    for (const m of members.slice(1)) union(members[0], m);
    for (const m of members) links.push({ from: funder, to: holders[m].owner });
    const root = find(members[0]);
    sharedFunders.set(root, (sharedFunders.get(root) ?? new Set()).add(funder));
  }
  const ownedSet = new Set(owned);
  const groups = new Map<number, number[]>();
  holders.forEach((_, i) => {
    const root = find(i);
    groups.set(root, [...(groups.get(root) ?? []), i]);
  });
  const clusters: BubbleCluster[] = [];
  const clusterOf = new Map<number, number>();
  for (const [root, members] of groups) {
    if (members.length < 2) continue;
    const raw = members.reduce((s, m) => s + BigInt(holders[m].raw), 0n);
    const funderSet = new Set<string>();
    for (const m of members)
      for (const f of sharedFunders.get(find(m)) ?? []) funderSet.add(f);
    const id = clusters.length + 1;
    for (const m of members) clusterOf.set(m, id);
    clusters.push({
      id,
      owners: members.map((m) => holders[m].owner),
      raw: raw.toString(),
      supplyBasisPoints: bps(raw, total),
      sharedFunders: [...funderSet].sort(),
      ownedWallets: members
        .map((m) => holders[m].owner)
        .filter((o) => ownedSet.has(o)),
    });
    void root;
  }
  clusters.sort((a, b) =>
    BigInt(a.raw) === BigInt(b.raw)
      ? 0
      : BigInt(a.raw) > BigInt(b.raw)
        ? -1
        : 1,
  );
  const renumber = new Map(clusters.map((c, i) => [c.id, i + 1]));
  clusters.forEach((c, i) => (c.id = i + 1));
  const clusteredRaw = clusters.reduce((s, c) => s + BigInt(c.raw), 0n);
  const ownedRaw = clusters
    .filter((c) => c.ownedWallets.length)
    .reduce((s, c) => s + BigInt(c.raw), 0n);
  return {
    nodes: holders.map((h, i) => ({
      owner: h.owner,
      raw: h.raw,
      supplyBasisPoints: bps(BigInt(h.raw), total),
      cluster: clusterOf.has(i) ? renumber.get(clusterOf.get(i)!)! : null,
      funder: funders[h.owner]?.funder ?? null,
      owned: ownedSet.has(h.owner),
    })),
    links,
    clusters,
    clusteredBasisPoints: bps(clusteredRaw, total),
    ownedClusteredBasisPoints: bps(ownedRaw, total),
  };
}
