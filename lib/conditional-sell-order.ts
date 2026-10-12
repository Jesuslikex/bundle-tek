import { UUID } from './wallet-operation';
import { walletAddress } from './wallet-workspace';
import { solanaTokenAtoms } from './solana-token-amount';
import { marketGrid, marketUsdMicros } from './market-trigger';
import { formatNativeBalance } from './wallet-balance-format';

export type ConditionalSellTerms = {
  format: 'conditional-sell-v1';
  projectId: string;
  projectRevision: number;
  mint: string;
  decimals: number;
  pair: string;
  wallet: string;
  walletRevision: number;
  kind: 'limit' | 'grid';
  direction: 'at-or-above' | 'at-or-below';
  totalRaw: string;
  levels: {
    level: number;
    targetUsd: string;
    unitsRaw: string;
    amount: string;
  }[];
};
export type ConditionalSellOrder = {
  id: string;
  revision: number;
  state: 'draft' | 'cancelled';
  terms: ConditionalSellTerms;
  createdAt: string;
  updatedAt: string;
};
export function conditionalSellTerms(
  value: Record<string, unknown>,
  token: { chain: string; address: string; decimals: number },
): ConditionalSellTerms {
  if (
    token.chain !== 'Solana' ||
    typeof value.projectId !== 'string' ||
    !UUID.test(value.projectId) ||
    ![value.projectRevision, value.walletRevision].every(
      (v) => Number.isSafeInteger(v) && Number(v) > 0 && Number(v) < 1e9,
    ) ||
    !['limit', 'grid'].includes(String(value.kind)) ||
    !['at-or-above', 'at-or-below'].includes(String(value.direction)) ||
    (value.kind === 'grid' &&
      (value.direction !== 'at-or-above' ||
        typeof value.minimumUsd !== 'string' ||
        typeof value.maximumUsd !== 'string' ||
        !Number.isInteger(value.lines)))
  )
    throw new Error('Choose current Solana project and wallet revisions.');
  const pair = walletAddress(value.pair, 'Solana');
  const wallet = walletAddress(value.wallet, 'Solana');
  const mint = walletAddress(token.address, 'Solana');
  const totalRaw = solanaTokenAtoms(value.amount, token.decimals).toString();
  if (BigInt(totalRaw) < 1n || BigInt(totalRaw) > 18446744073709551615n)
    throw new Error('Choose a positive exact Solana token amount.');
  const levels =
    value.kind === 'grid'
      ? marketGrid({
          minimumUsd: String(value.minimumUsd),
          maximumUsd: String(value.maximumUsd),
          lines: Number(value.lines),
          totalRaw,
          decimals: token.decimals,
        })
      : [
          {
            level: 1,
            targetUsd: formatNativeBalance(
              marketUsdMicros(value.targetUsd).toString(),
              6,
            ),
            unitsRaw: totalRaw,
            amount: formatNativeBalance(totalRaw, token.decimals),
          },
        ];
  return {
    format: 'conditional-sell-v1',
    projectId: value.projectId,
    projectRevision: Number(value.projectRevision),
    mint,
    decimals: token.decimals,
    pair,
    wallet,
    walletRevision: Number(value.walletRevision),
    kind: value.kind as 'limit' | 'grid',
    direction: value.direction as ConditionalSellTerms['direction'],
    totalRaw,
    levels,
  };
}

export function decodeConditionalSellOrder(
  value: unknown,
): ConditionalSellOrder {
  const row = value as ConditionalSellOrder | null;
  if (
    !row ||
    !UUID.test(row.id) ||
    !['draft', 'cancelled'].includes(row.state) ||
    row.revision !== (row.state === 'draft' ? 1 : 2) ||
    !Number.isFinite(Date.parse(row.createdAt)) ||
    !Number.isFinite(Date.parse(row.updatedAt)) ||
    Date.parse(row.updatedAt) < Date.parse(row.createdAt) ||
    !row.terms ||
    row.terms.format !== 'conditional-sell-v1' ||
    !Number.isInteger(row.terms.decimals) ||
    row.terms.decimals < 0 ||
    row.terms.decimals > 255 ||
    typeof row.terms.totalRaw !== 'string' ||
    !/^[1-9]\d{0,19}$/.test(row.terms.totalRaw) ||
    BigInt(row.terms.totalRaw) > 18446744073709551615n ||
    !Array.isArray(row.terms.levels) ||
    row.terms.levels.length < 1 ||
    row.terms.levels.length > 50
  )
    throw new Error('Invalid saved conditional order.');
  const terms = row.terms;
  const normalized = conditionalSellTerms(
    {
      projectId: terms.projectId,
      projectRevision: terms.projectRevision,
      wallet: terms.wallet,
      walletRevision: terms.walletRevision,
      pair: terms.pair,
      kind: terms.kind,
      direction: terms.direction,
      amount: formatNativeBalance(terms.totalRaw, terms.decimals),
      targetUsd: terms.levels[0]?.targetUsd,
      minimumUsd: terms.levels[0]?.targetUsd,
      maximumUsd: terms.levels.at(-1)?.targetUsd,
      lines: terms.levels.length,
    },
    { chain: 'Solana', address: terms.mint, decimals: terms.decimals },
  );
  if (
    normalized.levels.length !== terms.levels.length ||
    normalized.levels.some((level, i) =>
      Object.keys(level).some(
        (key) =>
          level[key as keyof typeof level] !==
          terms.levels[i][key as keyof typeof level],
      ),
    )
  )
    throw new Error('Saved grid amounts or targets differ.');
  return { ...row, terms: normalized };
}
