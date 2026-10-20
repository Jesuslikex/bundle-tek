import type { SavedWarmup } from './wallet-warmup-storage';
import type { WalletWarmupSessionReview } from './wallet-warmup-session-review';
import {
  walletWarmupSessionView,
  type WalletWarmupSessionView,
} from './wallet-warmup-session-view';
import { walletWarmupSessionDigest } from './wallet-warmup-session-digest';
import { UUID } from './wallet-operation';
export type WarmupSessionRecovery = {
  id: string;
  planId: string;
  revision: number;
  reviewedAt: string;
  reviewSha256: string;
};
const fail = (): never => {
  throw Error(
    'Retained review response differs. Recover the same review ID before saving again.',
  );
};
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : fail();
const iso = (value: unknown): value is string =>
  typeof value === 'string' &&
  Number.isSafeInteger(Date.parse(value)) &&
  new Date(value).toISOString() === value;
const revision = (value: unknown): value is number =>
  typeof value === 'number' &&
  Number.isSafeInteger(value) &&
  value >= 1 &&
  value < 1e9;
const id = (value: unknown): value is string =>
  typeof value === 'string' &&
  UUID.test(value) &&
  value === value.toLowerCase();
const hash = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const publicKey = (value: unknown): value is string =>
  typeof value === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value);
const canonical = (value: unknown) =>
  JSON.stringify(value, (_key, node: unknown) =>
    node && typeof node === 'object' && !Array.isArray(node)
      ? Object.fromEntries(
          Object.entries(node).sort(([a], [b]) => a.localeCompare(b)),
        )
      : node,
  );
function amount(value: unknown) {
  if (
    typeof value !== 'string' ||
    !/^(0|[1-9]\d{0,20})$/.test(value) ||
    BigInt(value) > 20n * ((1n << 64n) - 1n)
  )
    return fail();
  return BigInt(value);
}
export function walletWarmupSessionRecovery(
  value: unknown,
  planId: string,
): WarmupSessionRecovery {
  const row = object(value),
    keys = ['id', 'planId', 'revision', 'reviewedAt', 'reviewSha256'];
  if (
    Object.keys(row).length !== 5 ||
    Object.keys(row).some((k) => !keys.includes(k)) ||
    !id(row.id) ||
    row.planId !== planId ||
    !revision(row.revision) ||
    !iso(row.reviewedAt) ||
    !hash(row.reviewSha256)
  )
    return fail();
  return {
    id: row.id,
    planId,
    revision: row.revision,
    reviewedAt: row.reviewedAt,
    reviewSha256: row.reviewSha256,
  };
}
export async function walletWarmupSessionSaveSelection(
  view: WalletWarmupSessionView,
  plan: SavedWarmup,
  now = Date.now(),
): Promise<WarmupSessionRecovery> {
  if (view.deadline <= now || plan.archived) return fail();
  const current = walletWarmupSessionView(
    { review: view.review, reviewExpiresAt: view.reviewExpiresAt },
    plan,
    now,
  );
  return {
    id: crypto.randomUUID(),
    planId: plan.id,
    revision: plan.revision,
    reviewedAt: current.review.reviewedAt,
    reviewSha256: await walletWarmupSessionDigest(current.review.contextKey),
  };
}
export type RetainedWarmupSessionSummary = {
  id: string;
  planId: string;
  planRevision: number;
  reviewSha256: string;
  reviewedAt: string;
  createdAt: string;
  reviewExpiresAt: string;
  walletCount: number;
  actionCount: number;
  maximumNativeSpendLamports: string;
};
/** Recovery is historical display only. No retained response can authorize a transaction. */
export async function walletWarmupSessionRetainedView(
  value: unknown,
  expected: {
    id: string;
    planId: string;
    revision?: number;
    reviewedAt?: string;
    reviewSha256?: string;
  },
  original?: WalletWarmupSessionReview,
): Promise<RetainedWarmupSessionSummary> {
  const body = object(value),
    row = object(body.retainedReview),
    document = object(row.document);
  const keys = [
    'id',
    'planId',
    'planRevision',
    'reviewSha256',
    'reviewedAt',
    'reviewExpiresAt',
    'createdAt',
    'document',
  ];
  if (
    Object.keys(body).length !== 1 ||
    Object.keys(row).length !== 8 ||
    Object.keys(row).some((k) => !keys.includes(k)) ||
    JSON.stringify(value).length > 2 * 1024 * 1024 ||
    !id(row.id) ||
    row.id !== expected.id ||
    row.planId !== expected.planId ||
    !revision(row.planRevision) ||
    !hash(row.reviewSha256) ||
    !iso(row.reviewedAt) ||
    !iso(row.reviewExpiresAt) ||
    !iso(row.createdAt) ||
    Date.parse(row.reviewExpiresAt) - Date.parse(row.reviewedAt) !== 60000 ||
    Date.parse(row.createdAt) < Date.parse(row.reviewedAt) ||
    Date.parse(row.createdAt) > Date.parse(row.reviewExpiresAt) ||
    (expected.revision !== undefined &&
      row.planRevision !== expected.revision) ||
    (expected.reviewedAt !== undefined &&
      row.reviewedAt !== expected.reviewedAt) ||
    (expected.reviewSha256 !== undefined &&
      row.reviewSha256 !== expected.reviewSha256) ||
    document.planId !== row.planId ||
    document.planRevision !== row.planRevision ||
    document.reviewedAt !== row.reviewedAt ||
    document.signingAllowed !== false ||
    document.executionAllowed !== false ||
    document.automaticExecutionAllowed !== false ||
    'contextKey' in document ||
    !Array.isArray(document.wallets) ||
    document.wallets.length < 1 ||
    document.wallets.length > 20 ||
    !Array.isArray(document.actions) ||
    document.actions.length > 4800
  )
    return fail();
  const wallets = new Map<string, number>();
  let total = 0n;
  for (const item of document.wallets) {
    const wallet = object(item);
    if (
      !publicKey(wallet.wallet) ||
      !revision(wallet.walletRevision) ||
      wallets.has(wallet.wallet)
    )
      return fail();
    wallets.set(wallet.wallet, wallet.walletRevision);
    const max = amount(wallet.maximumNativeSpendLamports);
    if (
      max !==
      amount(wallet.buySpendLamports) +
        amount(wallet.remainingFeeReserveLamports)
    )
      return fail();
    total += max;
  }
  if (total !== amount(document.totalMaximumNativeSpendLamports)) return fail();
  const actions = new Map<string, Record<string, unknown>>();
  for (const item of document.actions) {
    const action = object(item);
    if (
      typeof action.id !== 'string' ||
      action.id.length < 1 ||
      action.id.length > 256 ||
      actions.has(action.id) ||
      !publicKey(action.wallet) ||
      wallets.get(action.wallet) !== action.walletRevision ||
      !publicKey(action.mint) ||
      !Number.isInteger(action.cycle) ||
      Number(action.cycle) < 1 ||
      Number(action.cycle) > 20 ||
      !['Buy', 'Sell'].includes(action.side as string) ||
      !iso(action.scheduledAt)
    )
      return fail();
    actions.set(action.id, action);
  }
  for (const action of actions.values())
    if (action.side === 'Sell') {
      const source = object(action.source);
      if (source.kind === 'session-buy') {
        const buy = actions.get(String(source.actionId));
        if (
          !buy ||
          buy.side !== 'Buy' ||
          buy.wallet !== action.wallet ||
          buy.mint !== action.mint ||
          buy.cycle !== action.cycle
        )
          return fail();
      } else if (source.kind === 'saved-buy') {
        if (
          typeof source.buyReceiptId !== 'string' ||
          source.buyReceiptId.length < 1 ||
          source.buyReceiptId.length > 256 ||
          amount(source.remainingRaw) === 0n
        )
          return fail();
      } else return fail();
    }
  if (original) {
    const { contextKey, ...manifest } = original;
    const context: unknown = JSON.parse(contextKey);
    if (
      !Array.isArray(context) ||
      context.length !== 4 ||
      canonical(context[3]) !== canonical(manifest) ||
      canonical(document) !== canonical(manifest) ||
      (await walletWarmupSessionDigest(contextKey)) !== row.reviewSha256
    )
      return fail();
  }
  return {
    id: row.id,
    planId: expected.planId,
    planRevision: row.planRevision,
    reviewSha256: row.reviewSha256,
    reviewedAt: row.reviewedAt,
    createdAt: row.createdAt,
    reviewExpiresAt: row.reviewExpiresAt,
    walletCount: wallets.size,
    actionCount: actions.size,
    maximumNativeSpendLamports: total.toString(),
  };
}
