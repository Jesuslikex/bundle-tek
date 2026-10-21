import { UUID } from './wallet-operation';
import { walletAddress } from './wallet-workspace';

/** Exact SQLite/JS integer accounting domain, including input plus fees/rent. */
export const AUTO_BUY_BUDGET_MAX = BigInt(Number.MAX_SAFE_INTEGER);
export const AUTO_BUY_BUDGET_SOL =
  'So11111111111111111111111111111111111111112';
export class AutoBuyBudgetError extends Error {
  constructor(
    message: string,
    readonly status = 409,
  ) {
    super(message);
  }
}
export type AutoBuyBudgetLimit = {
  maximumInputLamports: string;
  maximumFeeAndRentLamports: string;
};
export type AutoBuyBudgetTerms = AutoBuyBudgetLimit & {
  id: string;
  projectId: string;
  projectRevision: number;
  mint: string;
  tokenDecimals: number;
  expiresAt: string;
  wallets: (AutoBuyBudgetLimit & { address: string; revision: number })[];
  strategies: (AutoBuyBudgetLimit & {
    id: string;
    kind: 'Counter' | 'DCA' | 'Limit';
    sourceSha256: string;
  })[];
};
export type AutoBuyBudgetClaim = AutoBuyBudgetLimit & {
  id: string;
  sessionId: string;
  sessionRevision: number;
  strategyId: string;
  wallet: string;
  walletRevision: number;
  candidateKey: string;
  kind: 'ExactIn' | 'ExactOut';
  minimumOutputTokenRaw: string;
  sourceSha256: string;
  packetSha256: string;
  expiresAt: string;
};
const limitKeys = ['maximumFeeAndRentLamports', 'maximumInputLamports'];
const fail = (): never => {
  throw new AutoBuyBudgetError(
    'Review exact Auto Buy budget accounting terms.',
    400,
  );
};
function keys(value: unknown, expected: string[]) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== [...expected].sort().join(',')
  )
    fail();
}
function identity(value: string) {
  if (typeof value !== 'string' || !UUID.test(value)) fail();
}
function revision(value: number, zero = false) {
  if (!Number.isSafeInteger(value) || value < (zero ? 0 : 1) || value > 1e9)
    fail();
}
function hash(value: string) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) fail();
}
function solana(value: string) {
  try {
    walletAddress(value, 'Solana');
  } catch {
    fail();
  }
}
function date(value: string) {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    fail();
}
export function autoBuyBudgetAmount(value: unknown, positive = false): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9]\d{0,15})$/.test(value)) fail();
  const n = BigInt(value as string);
  if (n > AUTO_BUY_BUDGET_MAX || (positive && n === 0n)) fail();
  return n;
}
function limit(v: AutoBuyBudgetLimit) {
  if (
    autoBuyBudgetAmount(v.maximumInputLamports, true) +
      autoBuyBudgetAmount(v.maximumFeeAndRentLamports) >
    AUTO_BUY_BUDGET_MAX
  )
    fail();
}
/** These are accounting records, never trading consent or source qualification. */
export const AUTO_BUY_BUDGET_AUTHORITY = Object.freeze({
  signingAllowed: false as const,
  executionAllowed: false as const,
  automaticExecutionAllowed: false as const,
  sourceVerified: false as const,
  instructionsVerified: false as const,
  walletFundsReserved: false as const,
});
export function autoBuyBudgetTerms(value: unknown): AutoBuyBudgetTerms {
  keys(value, [
    ...limitKeys,
    'id',
    'projectId',
    'projectRevision',
    'mint',
    'tokenDecimals',
    'expiresAt',
    'wallets',
    'strategies',
  ]);
  const v = structuredClone(value) as AutoBuyBudgetTerms;
  identity(v.id);
  identity(v.projectId);
  revision(v.projectRevision);
  date(v.expiresAt);
  solana(v.mint);
  if (v.mint === AUTO_BUY_BUDGET_SOL)
    throw new AutoBuyBudgetError(
      'Choose a distinct token for a SOL-input budget.',
      400,
    );
  limit(v);
  if (
    !Number.isInteger(v.tokenDecimals) ||
    v.tokenDecimals < 0 ||
    v.tokenDecimals > 255 ||
    !Array.isArray(v.wallets) ||
    !v.wallets.length ||
    v.wallets.length > 25 ||
    !Array.isArray(v.strategies) ||
    !v.strategies.length ||
    v.strategies.length > 8
  )
    fail();
  for (const w of v.wallets) {
    keys(w, [...limitKeys, 'address', 'revision']);
    solana(w.address);
    revision(w.revision);
    limit(w);
    if (
      autoBuyBudgetAmount(w.maximumInputLamports) >
        autoBuyBudgetAmount(v.maximumInputLamports) ||
      autoBuyBudgetAmount(w.maximumFeeAndRentLamports) >
        autoBuyBudgetAmount(v.maximumFeeAndRentLamports)
    )
      fail();
  }
  for (const s of v.strategies) {
    keys(s, [...limitKeys, 'id', 'kind', 'sourceSha256']);
    identity(s.id);
    hash(s.sourceSha256);
    limit(s);
    if (
      !['Counter', 'DCA', 'Limit'].includes(s.kind) ||
      autoBuyBudgetAmount(s.maximumInputLamports) >
        autoBuyBudgetAmount(v.maximumInputLamports) ||
      autoBuyBudgetAmount(s.maximumFeeAndRentLamports) >
        autoBuyBudgetAmount(v.maximumFeeAndRentLamports)
    )
      fail();
  }
  if (
    new Set(v.wallets.map((w) => w.address)).size !== v.wallets.length ||
    new Set(v.strategies.map((s) => s.id)).size !== v.strategies.length
  )
    fail();
  // Reconstruct deterministically; caller key ordering must not create new terms.
  return {
    id: v.id,
    projectId: v.projectId,
    projectRevision: v.projectRevision,
    mint: v.mint,
    tokenDecimals: v.tokenDecimals,
    maximumInputLamports: v.maximumInputLamports,
    maximumFeeAndRentLamports: v.maximumFeeAndRentLamports,
    expiresAt: v.expiresAt,
    wallets: v.wallets.map((w) => ({
      address: w.address,
      revision: w.revision,
      maximumInputLamports: w.maximumInputLamports,
      maximumFeeAndRentLamports: w.maximumFeeAndRentLamports,
    })),
    strategies: v.strategies.map((s) => ({
      id: s.id,
      kind: s.kind,
      sourceSha256: s.sourceSha256,
      maximumInputLamports: s.maximumInputLamports,
      maximumFeeAndRentLamports: s.maximumFeeAndRentLamports,
    })),
  };
}
export function autoBuyBudgetClaim(value: unknown): AutoBuyBudgetClaim {
  keys(value, [
    ...limitKeys,
    'id',
    'sessionId',
    'sessionRevision',
    'strategyId',
    'wallet',
    'walletRevision',
    'candidateKey',
    'kind',
    'minimumOutputTokenRaw',
    'sourceSha256',
    'packetSha256',
    'expiresAt',
  ]);
  const v = structuredClone(value) as AutoBuyBudgetClaim;
  identity(v.id);
  identity(v.sessionId);
  identity(v.strategyId);
  revision(v.sessionRevision, true);
  revision(v.walletRevision);
  solana(v.wallet);
  hash(v.sourceSha256);
  hash(v.packetSha256);
  date(v.expiresAt);
  limit(v);
  if (
    !['ExactIn', 'ExactOut'].includes(v.kind) ||
    typeof v.candidateKey !== 'string' ||
    !(v.kind === 'ExactOut'
      ? /^[a-f0-9]{64}$/.test(v.candidateKey)
      : /^(0|[1-9]\d{0,9})$/.test(v.candidateKey) ||
        v.candidateKey === 'once') ||
    typeof v.minimumOutputTokenRaw !== 'string' ||
    !/^[1-9]\d{0,19}$/.test(v.minimumOutputTokenRaw) ||
    BigInt(v.minimumOutputTokenRaw) > (1n << 64n) - 1n
  )
    fail();
  if (
    v.kind === 'ExactIn' &&
    v.candidateKey !== 'once' &&
    BigInt(v.candidateKey) > 1000000000n
  )
    fail();
  return {
    id: v.id,
    sessionId: v.sessionId,
    sessionRevision: v.sessionRevision,
    strategyId: v.strategyId,
    wallet: v.wallet,
    walletRevision: v.walletRevision,
    candidateKey: v.candidateKey,
    kind: v.kind,
    minimumOutputTokenRaw: v.minimumOutputTokenRaw,
    sourceSha256: v.sourceSha256,
    packetSha256: v.packetSha256,
    maximumInputLamports: v.maximumInputLamports,
    maximumFeeAndRentLamports: v.maximumFeeAndRentLamports,
    expiresAt: v.expiresAt,
  };
}
