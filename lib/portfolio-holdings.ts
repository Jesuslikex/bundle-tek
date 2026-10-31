import { address } from '@solana/kit';
import { findAssociatedTokenPda } from '@solana-program/token';
import { TOKEN_2022_PROGRAM, TOKEN_PROGRAM } from './market-cleanup-balances';
import {
  PORTFOLIO_MAX_PROJECTS,
  PORTFOLIO_MAX_WALLETS,
  type PortfolioHolding,
  type PortfolioHoldings,
} from './portfolio';

export type PortfolioRpc = (
  method: string,
  params: unknown[],
) => Promise<unknown>;
type Parsed = {
  lamports?: number;
  data?: {
    parsed?: {
      info?: {
        mint?: string;
        owner?: string;
        tokenAmount?: { amount?: string };
      };
    };
  };
} | null;
type ProjectRow = { id: string; document: string; market: string | null };
const fail = (message: string): never => {
  throw new Error(message);
};

async function accounts(rpc: PortfolioRpc, keys: string[]) {
  const out: Parsed[] = [];
  for (let i = 0; i < keys.length; i += 100) {
    const chunk = keys.slice(i, i + 100);
    const result = (await rpc('getMultipleAccounts', [
      chunk,
      { encoding: 'jsonParsed', commitment: 'confirmed' },
    ])) as { value?: Parsed[] };
    if (!Array.isArray(result?.value) || result.value.length !== chunk.length)
      fail('Portfolio balances differ.');
    out.push(...result.value!);
  }
  return out;
}
/** Deepest saved pair's USD price from the newest observation. */
export function savedPrice(market: string | null) {
  if (!market) return { priceUsd: null, observedAt: null };
  try {
    const list = JSON.parse(market) as {
      observedAt?: string;
      pairs?: { priceUsd?: string | null; liquidityUsd?: number | null }[];
    }[];
    const latest = list[0];
    const pair = [...(latest?.pairs ?? [])]
      .filter((p) => p.priceUsd && Number(p.priceUsd) > 0)
      .sort((a, b) => (b.liquidityUsd ?? 0) - (a.liquidityUsd ?? 0))[0];
    return pair
      ? {
          priceUsd: Number(pair.priceUsd),
          observedAt: latest.observedAt ?? null,
        }
      : { priceUsd: null, observedAt: null };
  } catch {
    return { priceUsd: null, observedAt: null };
  }
}

/** Read-only: current coin and SOL balances of the user's saved Solana wallets. */
export async function readPortfolioHoldings(
  db: D1Database,
  owner: string,
  rpc: PortfolioRpc,
): Promise<PortfolioHoldings> {
  const wallets = (
    await db
      .prepare(
        "SELECT w.address FROM workspace_wallets w WHERE w.owner_id=? AND w.chain='Solana' AND w.archived=0 AND EXISTS(SELECT 1 FROM wallet_ownership_proofs p WHERE p.owner_id=w.owner_id AND p.chain='Solana' AND p.address=w.address) ORDER BY w.address",
      )
      .bind(owner)
      .all<{ address: string }>()
  ).results.map((r) => r.address);
  const projects = (
    await db
      .prepare(
        "SELECT p.id,p.document,m.document AS market FROM imported_token_projects p LEFT JOIN imported_market_observations m ON m.owner_id=p.owner_id AND m.project_id=p.id WHERE p.owner_id=? AND p.chain='Solana' AND p.archived=0 ORDER BY p.updated_at DESC",
      )
      .bind(owner)
      .all<ProjectRow>()
  ).results;
  const used = wallets.slice(0, PORTFOLIO_MAX_WALLETS),
    chosen = projects.slice(0, PORTFOLIO_MAX_PROJECTS);
  const native = used.length ? await accounts(rpc, used) : [];
  const solLamports = native.reduce((n, a) => {
    const l = a?.lamports ?? 0;
    if (!Number.isSafeInteger(l) || l < 0)
      fail('Portfolio SOL balance differs.');
    return n + BigInt(l);
  }, 0n);
  const holdings: PortfolioHolding[] = [];
  for (const project of chosen) {
    const token = (
      JSON.parse(project.document) as {
        token: {
          address: string;
          symbol: string;
          name: string;
          decimals: number;
        };
      }
    ).token;
    let held = 0n,
      holders = 0;
    if (used.length) {
      const atas = await Promise.all(
        [TOKEN_PROGRAM, TOKEN_2022_PROGRAM].flatMap((program) =>
          used.map(async (owner) =>
            String(
              (
                await findAssociatedTokenPda({
                  owner: address(owner),
                  mint: address(token.address),
                  tokenProgram: address(program),
                })
              )[0],
            ),
          ),
        ),
      );
      const rows = await accounts(rpc, atas);
      const per = new Map<string, bigint>();
      rows.forEach((account, i) => {
        if (!account) return;
        const wallet = used[i % used.length];
        const info = account.data?.parsed?.info;
        const amount = info?.tokenAmount?.amount;
        if (
          info?.mint !== token.address ||
          info?.owner !== wallet ||
          typeof amount !== 'string' ||
          !/^(0|[1-9]\d{0,19})$/.test(amount)
        )
          fail('Portfolio token account differs.');
        per.set(wallet, (per.get(wallet) ?? 0n) + BigInt(amount!));
      });
      for (const v of per.values()) {
        held += v;
        if (v > 0n) holders++;
      }
    }
    const price = savedPrice(project.market);
    holdings.push({
      projectId: project.id,
      name: token.name,
      symbol: token.symbol,
      mint: token.address,
      decimals: token.decimals,
      heldRaw: held.toString(),
      walletCount: holders,
      priceUsd: price.priceUsd,
      priceObservedAt: price.observedAt,
    });
  }
  return {
    observedAt: new Date().toISOString(),
    walletCount: used.length,
    walletsOmitted: wallets.length - used.length,
    projectsOmitted: projects.length - chosen.length,
    solLamports: solLamports.toString(),
    holdings,
  };
}
