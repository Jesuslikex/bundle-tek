import { UUID } from './wallet-operation';
import { walletAddress, type WorkspaceWallet } from './wallet-workspace';
import { solanaTokenAtoms } from './solana-token-amount';
import { formatNativeBalance } from './wallet-balance-format';

type BaseStrategy = {
  id: string;
  wallet: string;
  walletRevision: number;
  maxAmount: string | null;
  durationSeconds: number | null;
};
export type DraftStrategy = BaseStrategy &
  (
    | {
        kind: 'DCA';
        amountPerCycle: string;
        cycles: number;
        intervalSeconds: number;
      }
    | {
        kind: 'Limit';
        amount: string;
        marketCapUsd: string;
        direction: 'at-or-above' | 'at-or-below';
      }
  );
export type StrategySessionInput = {
  name: string;
  projectId: string;
  projectRevision: number;
  side: 'Buy' | 'Sell';
  startAt: string;
  maxAmount: string | null;
  durationSeconds: number | null;
  strategies: DraftStrategy[];
};
export type StrategyContext = {
  projectId: string;
  projectRevision: number;
  token: { chain: string; address: string; decimals: number; symbol: string };
  wallets: Pick<
    WorkspaceWallet,
    'chain' | 'address' | 'revision' | 'archived'
  >[];
};
const fail = (message: string): never => {
  throw new Error(message);
};
function exact(value: unknown, keys: string) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== keys
  )
    fail('Review exact strategy draft fields.');
}
const positive = (v: unknown, maximum: number, label: string): number => {
  if (!Number.isSafeInteger(v) || Number(v) < 1 || Number(v) > maximum)
    fail(`Choose ${label} from 1 to ${maximum}.`);
  return Number(v);
};
const amount = (value: unknown, decimals: number) => {
  const raw = solanaTokenAtoms(value, decimals);
  return { raw, text: formatNativeBalance(raw.toString(), decimals) };
};
const endAt = (start: number, seconds: number) =>
  new Date(start + seconds * 1000).toISOString();
function hasControl(value: string) {
  for (let index = 0; index < value.length; index++)
    if (value.charCodeAt(index) < 32 || value.charCodeAt(index) === 127)
      return true;
  return false;
}

/** Independent planning format, never accepted by a trading/session executor. */
export function planStrategySession(value: unknown, context: StrategyContext) {
  exact(
    value,
    'durationSeconds,maxAmount,name,projectId,projectRevision,side,startAt,strategies',
  );
  const v = structuredClone(value) as StrategySessionInput;
  if (
    !UUID.test(v.projectId) ||
    v.projectId !== context.projectId ||
    positive(v.projectRevision, 1e9, 'a project revision') !==
      context.projectRevision ||
    context.token.chain !== 'Solana' ||
    !Number.isInteger(context.token.decimals) ||
    context.token.decimals < 0 ||
    context.token.decimals > 255 ||
    typeof context.token.symbol !== 'string' ||
    !context.token.symbol.trim() ||
    context.token.symbol.length > 64
  )
    fail('Choose a current Solana project.');
  const mint = walletAddress(context.token.address, 'Solana');
  if (
    typeof v.name !== 'string' ||
    !v.name.trim() ||
    v.name.trim().length > 80 ||
    hasControl(v.name)
  )
    fail('Name this draft using 1 to 80 characters.');
  if (!['Buy', 'Sell'].includes(v.side))
    fail('Choose Buy or Sell for the whole session.');
  const start = typeof v.startAt === 'string' ? Date.parse(v.startAt) : NaN;
  if (
    !Number.isSafeInteger(start) ||
    !/^20\d{2}-/.test(v.startAt) ||
    new Date(start).toISOString() !== v.startAt
  )
    fail('Choose an exact UTC start time.');
  const duration =
    v.durationSeconds === null
      ? null
      : positive(v.durationSeconds, 2_678_400, 'session duration in seconds');
  if (
    !Array.isArray(v.strategies) ||
    !v.strategies.length ||
    v.strategies.length > 8
  )
    fail('Add 1 to 8 strategies.');
  const decimals = v.side === 'Buy' ? 9 : context.token.decimals;
  const shared = v.maxAmount === null ? null : amount(v.maxAmount, decimals),
    seen = new Set<string>();
  const summaries: {
    id: string;
    maximumInputRaw: string | null;
    nominalInputRaw: string;
    candidateInputRaw: string;
    maximumTrades: number;
    endsAt: string | null;
    effectiveEndsAt: string | null;
  }[] = [];
  const strategies = v.strategies.map((row) => {
    exact(
      row,
      row.kind === 'DCA'
        ? 'amountPerCycle,cycles,durationSeconds,id,intervalSeconds,kind,maxAmount,wallet,walletRevision'
        : 'amount,direction,durationSeconds,id,kind,marketCapUsd,maxAmount,wallet,walletRevision',
    );
    if (!UUID.test(row.id) || seen.has(row.id))
      fail('Each strategy needs a distinct ID.');
    seen.add(row.id);
    const wallet = walletAddress(row.wallet, 'Solana');
    if (
      wallet === mint ||
      !context.wallets.some(
        (w) =>
          w.chain === 'Solana' &&
          !w.archived &&
          w.address === wallet &&
          w.revision === row.walletRevision,
      )
    )
      fail('Strategy wallets changed. Select current active wallets again.');
    positive(row.walletRevision, 1e9, 'a wallet revision');
    const seconds =
      row.durationSeconds === null
        ? null
        : positive(
            row.durationSeconds,
            2_678_400,
            'strategy duration in seconds',
          );
    const maximum =
      row.maxAmount === null ? null : amount(row.maxAmount, decimals);
    const effectiveSeconds =
      seconds === null
        ? duration
        : duration === null
          ? seconds
          : Math.min(seconds, duration);
    const base = {
      id: row.id,
      wallet,
      walletRevision: row.walletRevision,
      maxAmount: maximum?.text ?? null,
      durationSeconds: seconds,
    };
    let normalized: DraftStrategy, nominal: bigint, maximumTrades: number;
    if (row.kind === 'DCA') {
      const perCycle = amount(row.amountPerCycle, decimals);
      const cycles = positive(row.cycles, 25, 'DCA cycles');
      if (cycles < 2) fail('DCA needs 2 to 25 cycles.');
      const interval = positive(
        row.intervalSeconds,
        86400,
        'DCA interval in seconds',
      );
      if (
        (maximum && perCycle.raw > maximum.raw) ||
        (shared && perCycle.raw > shared.raw)
      )
        fail('A DCA cycle exceeds its strategy or session maximum.');
      nominal = perCycle.raw * BigInt(cycles);
      maximumTrades = Math.min(
        cycles,
        maximum ? Number(maximum.raw / perCycle.raw) : cycles,
        shared ? Number(shared.raw / perCycle.raw) : cycles,
        effectiveSeconds === null
          ? cycles
          : Math.ceil(effectiveSeconds / interval),
      );
      normalized = {
        ...base,
        kind: 'DCA',
        amountPerCycle: perCycle.text,
        cycles,
        intervalSeconds: interval,
      };
    } else if (row.kind === 'Limit') {
      const trade = amount(row.amount, decimals),
        threshold = amount(row.marketCapUsd, 6);
      if (!['at-or-above', 'at-or-below'].includes(row.direction))
        fail('Choose a supported Limit direction.');
      if (
        (maximum && trade.raw > maximum.raw) ||
        (shared && trade.raw > shared.raw)
      )
        fail('A Limit input exceeds its strategy or session maximum.');
      nominal = trade.raw;
      maximumTrades = 1;
      normalized = {
        ...base,
        kind: 'Limit',
        amount: trade.text,
        marketCapUsd: threshold.text,
        direction: row.direction,
      };
    } else return fail('Choose DCA or Limit.');
    summaries.push({
      id: row.id,
      maximumInputRaw: maximum?.raw.toString() ?? null,
      nominalInputRaw: nominal.toString(),
      candidateInputRaw: (normalized.kind === 'DCA'
        ? (nominal / BigInt(normalized.cycles)) * BigInt(maximumTrades)
        : nominal
      ).toString(),
      maximumTrades,
      endsAt: seconds === null ? null : endAt(start, seconds),
      effectiveEndsAt:
        effectiveSeconds === null ? null : endAt(start, effectiveSeconds),
    });
    return normalized;
  });
  const total = summaries.reduce(
    (sum, row) => sum + BigInt(row.candidateInputRaw),
    0n,
  );
  return {
    format: 'strategy-session-draft-v1' as const,
    input: {
      name: v.name.trim(),
      projectId: v.projectId,
      projectRevision: v.projectRevision,
      side: v.side,
      startAt: v.startAt,
      maxAmount: shared?.text ?? null,
      durationSeconds: duration,
      strategies,
    },
    token: {
      chain: 'Solana' as const,
      address: mint,
      decimals: context.token.decimals,
      symbol: context.token.symbol,
    },
    summary: {
      inputDecimals: decimals,
      inputUnit: v.side === 'Buy' ? 'SOL' : context.token.symbol,
      maximumInputRaw: shared?.raw.toString() ?? null,
      totalStrategyMaximumRaw: total.toString(),
      competingForBudget: shared !== null && total > shared.raw,
      endsAt: duration === null ? null : endAt(start, duration),
      strategies: summaries,
    },
    planningOnly: true as const,
    fundingAllowed: false as const,
    signingAllowed: false as const,
    executionAllowed: false as const,
  };
}
export type StrategySessionPlan = ReturnType<typeof planStrategySession>;
export function requireStrategySessionPlan(
  value: unknown,
): StrategySessionPlan {
  const p = value as StrategySessionPlan;
  if (!p?.input || !p.token || !Array.isArray(p.input.strategies))
    fail('Strategy draft unavailable.');
  const rebuilt = planStrategySession(p.input, {
    projectId: p.input.projectId,
    projectRevision: p.input.projectRevision,
    token: p.token,
    wallets: p.input.strategies.map((row) => ({
      chain: 'Solana',
      address: row.wallet,
      revision: row.walletRevision,
      archived: false,
    })),
  });
  if (JSON.stringify(rebuilt) !== JSON.stringify(p))
    fail('Strategy draft terms differ.');
  return rebuilt;
}
