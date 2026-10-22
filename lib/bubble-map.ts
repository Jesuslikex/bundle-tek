import { walletAddress } from './wallet-workspace';
import bs58 from 'bs58';

// Bubble maps estimate links from bounded provider-reported funding evidence.
// This is a read-only estimate: a shared funder can also be an exchange
// hot wallet, so clusters are signals, not proof of common control.

export type BubbleFunder = {
  funder: string;
  signature: string;
  slot: number;
  blockTime?: number | null;
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
  programId?: string;
  parsed?: { type?: string; info?: Record<string, unknown> };
};
type ParsedTransaction = {
  slot?: number;
  blockTime?: number | null;
  transaction?: {
    signatures?: string[];
    message?: { instructions?: Parsed[] };
  };
  meta?: {
    err?: unknown;
    innerInstructions?: { index?: number; instructions?: Parsed[] }[] | null;
  } | null;
};

/** First supported positive System transfer in this provider-parsed trace. */
export function funderInTransaction(
  tx: ParsedTransaction | null,
  address: string,
): BubbleFunder | null {
  if (
    !tx ||
    tx.meta?.err !== null ||
    !Number.isSafeInteger(tx.slot) ||
    tx.slot! < 0
  )
    return null;
  const signature = tx.transaction?.signatures?.[0];
  try {
    if (
      typeof signature !== 'string' ||
      signature.length > 90 ||
      bs58.decode(signature).length !== 64 ||
      walletAddress(address, 'Solana') !== address
    )
      return null;
  } catch {
    return null;
  }
  if (
    tx.blockTime !== undefined &&
    tx.blockTime !== null &&
    (!Number.isSafeInteger(tx.blockTime) ||
      tx.blockTime < 0 ||
      tx.blockTime > Date.now() / 1000)
  )
    return null;
  const outer = tx.transaction?.message?.instructions;
  const groups = tx.meta.innerInstructions;
  if (
    !Array.isArray(outer) ||
    outer.length > 256 ||
    !Array.isArray(groups) ||
    groups.length > 256
  )
    return null;
  const inner = new Map<number, Parsed[]>();
  for (const group of groups) {
    if (
      !group ||
      !Number.isSafeInteger(group.index) ||
      group.index! < 0 ||
      group.index! >= outer.length ||
      inner.has(group.index!) ||
      !Array.isArray(group.instructions) ||
      group.instructions.length > 4096
    )
      return null;
    inner.set(group.index!, group.instructions);
  }
  const all = outer.flatMap((ix, index) => [ix, ...(inner.get(index) ?? [])]);
  if (all.length > 4096) return null;
  for (const ix of all) {
    if (!ix || typeof ix !== 'object') return null;
    try {
      if (
        typeof ix.programId !== 'string' ||
        walletAddress(ix.programId, 'Solana') !== ix.programId
      )
        return null;
    } catch {
      return null;
    }
    if (
      ix.program !== 'system' &&
      ix.programId !== '11111111111111111111111111111111'
    )
      continue;
    if (
      ix.program !== 'system' ||
      ix.programId !== '11111111111111111111111111111111' ||
      !ix.parsed?.info
    )
      return null;
    const { type, info } = ix.parsed;
    if (
      [
        'advanceNonce',
        'advanceNonceAccount',
        'allocate',
        'allocateWithSeed',
        'assign',
        'assignWithSeed',
        'initializeNonce',
        'initializeNonceAccount',
        'authorizeNonce',
        'authorizeNonceAccount',
        'upgradeNonce',
        'upgradeNonceAccount',
      ].includes(type ?? '')
    )
      continue;
    if (
      ![
        'transfer',
        'transferWithSeed',
        'createAccount',
        'createAccountWithSeed',
      ].includes(type ?? '')
    )
      return null;
    const amount = info.lamports;
    if (
      !(
        (typeof amount === 'number' &&
          Number.isSafeInteger(amount) &&
          amount > 0) ||
        (typeof amount === 'string' &&
          /^[1-9]\d{0,19}$/.test(amount) &&
          BigInt(amount) < 1n << 64n)
      )
    )
      return null;
    const to =
      type === 'transfer' || type === 'transferWithSeed'
        ? info.destination
        : type === 'createAccount' || type === 'createAccountWithSeed'
          ? info.newAccount
          : undefined;
    const from = info.source;
    if (typeof to !== 'string') return null;
    try {
      if (walletAddress(to, 'Solana') !== to) return null;
    } catch {
      return null;
    }
    if (to !== address) continue;
    if (typeof from !== 'string') return null;
    if (from === address) continue;
    try {
      if (walletAddress(from, 'Solana') !== from) return null;
      return {
        funder: walletAddress(from, 'Solana'),
        signature,
        slot: tx.slot as number,
        ...(tx.blockTime !== undefined ? { blockTime: tx.blockTime } : {}),
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
