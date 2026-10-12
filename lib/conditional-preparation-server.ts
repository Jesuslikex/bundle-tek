import {
  validatedConditionalSigning,
  sameConditionalTerms,
} from './conditional-signing';
import { decodeConditionalSellOrder } from './conditional-sell-order';
import { reviewMarketTrigger } from './market-trigger';
import type { SavedTokenMarket } from './token-market';
import { UUID } from './wallet-operation';
export type ConditionalLevelRequest = {
  orderId: string;
  revision: number;
  level: number;
};
export type ConditionalPreparation = {
  format: 'conditional-preparation-v1';
  orderId: string;
  orderRevision: number;
  level: number;
  termsSha256: string;
  pair: string;
  direction: 'at-or-above' | 'at-or-below';
  targetUsd: string;
  unitsRaw: string;
  observedMarketCapUsd: string;
  observedAt: string;
  expiresAt: string;
  source: 'api.dexscreener.com';
};
export type ConditionalPreparationGuard = {
  selection: ConditionalPreparation;
  document: string;
  marketDocument: string;
};
export function conditionalLevelRequest(
  value: unknown,
): ConditionalLevelRequest {
  const input = value as ConditionalLevelRequest | null;
  if (
    !input ||
    Object.keys(input).sort().join(',') !== 'level,orderId,revision' ||
    typeof input.orderId !== 'string' ||
    !UUID.test(input.orderId) ||
    !Number.isSafeInteger(input.revision) ||
    input.revision < 1 ||
    input.revision >= 1e9 ||
    !Number.isInteger(input.level) ||
    input.level < 1 ||
    input.level > 50
  )
    throw new Error('Choose a current conditional order level.');
  return {
    orderId: input.orderId,
    revision: input.revision,
    level: input.level,
  };
}
export async function captureConditionalPreparation(
  db: D1Database,
  owner: string,
  request: ConditionalLevelRequest,
  context: {
    projectId: string;
    projectRevision: number;
    wallet: string;
    walletRevision: number;
    mint: string;
    decimals: number;
    side: string;
    unitsRaw: string;
  },
  now = Date.now(),
  intentId?: string,
): Promise<ConditionalPreparationGuard> {
  const row = await db
    .prepare(`SELECT o.id,o.document,o.state,o.revision,o.created_at AS createdAt,o.updated_at AS updatedAt,m.document AS market
    FROM conditional_sell_orders o JOIN imported_token_projects p ON p.owner_id=o.owner_id AND p.id=o.project_id
    JOIN workspace_wallets w ON w.owner_id=o.owner_id AND w.chain='Solana' AND w.address=?
    JOIN imported_market_observations m ON m.owner_id=o.owner_id AND m.project_id=o.project_id
    WHERE o.owner_id=? AND o.id=? AND o.project_id=? AND o.revision=? AND o.state='draft'
    AND p.revision=? AND p.archived=0 AND p.chain='Solana' AND p.address=? AND w.revision=? AND w.archived=0
    AND (? IS NULL AND NOT EXISTS(SELECT 1 FROM conditional_level_reservations v WHERE v.owner_id=o.owner_id AND v.order_id=o.id AND v.level=?) OR ? IS NOT NULL AND EXISTS(SELECT 1 FROM conditional_level_reservations v WHERE v.owner_id=o.owner_id AND v.order_id=o.id AND v.level=? AND v.intent_id=? AND v.units_raw=?))
    AND NOT EXISTS(SELECT 1 FROM conditional_level_fills f WHERE f.owner_id=o.owner_id AND f.order_id=o.id AND f.level=?)`)
    .bind(
      context.wallet,
      owner,
      request.orderId,
      context.projectId,
      request.revision,
      context.projectRevision,
      context.mint,
      context.walletRevision,
      intentId ?? null,
      request.level,
      intentId ?? null,
      request.level,
      intentId ?? null,
      context.unitsRaw,
      request.level,
    )
    .first<{
      id: string;
      document: string;
      state: 'draft';
      revision: number;
      createdAt: string;
      updatedAt: string;
      market: string;
    }>();
  if (!row)
    throw new Error('Conditional draft, wallet or market context unavailable.');
  const order = decodeConditionalSellOrder({
      ...row,
      terms: JSON.parse(row.document),
    }),
    terms = order.terms;
  const level = terms.levels.find((l) => l.level === request.level);
  if (
    context.side !== 'Sell' ||
    terms.projectId !== context.projectId ||
    terms.projectRevision !== context.projectRevision ||
    terms.wallet !== context.wallet ||
    terms.walletRevision !== context.walletRevision ||
    terms.mint !== context.mint ||
    terms.decimals !== context.decimals ||
    !level ||
    level.unitsRaw !== context.unitsRaw
  )
    throw new Error('Trade differs from the saved conditional level.');
  const observations: SavedTokenMarket[] = JSON.parse(row.market);
  const review = reviewMarketTrigger(
    {
      pair: terms.pair,
      direction: terms.direction,
      targetUsd: level.targetUsd,
    },
    observations[0],
    { chain: 'Solana', mint: terms.mint, revision: terms.projectRevision },
    now,
  );
  if (!review.met) throw new Error('Saved level condition is not met.');
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(row.document),
  );
  const termsSha256 = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
  return {
    document: row.document,
    marketDocument: row.market,
    selection: {
      format: 'conditional-preparation-v1',
      orderId: order.id,
      orderRevision: order.revision,
      level: level.level,
      termsSha256,
      pair: terms.pair,
      direction: terms.direction,
      targetUsd: level.targetUsd,
      unitsRaw: level.unitsRaw,
      observedMarketCapUsd: review.observedMarketCapUsd,
      observedAt: review.observedAt,
      expiresAt: review.expiresAt,
      source: review.source,
    },
  };
}
// Approval and submission capture a fresh observation, while the original packet binding stays immutable.
export async function currentConditionalSigning(
  db: D1Database,
  owner: string,
  saved: {
    projectId: string;
    projectRevision: number;
    walletRevision: number;
    document: import('./imported-swap-preparation-history').SavedSwapPreparation['document'];
  },
  intentId?: string,
) {
  const c = saved.document.conditional;
  if (c === undefined) return undefined;
  validatedConditionalSigning(c, saved.document.inAmountRaw, Date.now());
  const project = await db
    .prepare(
      'SELECT document FROM imported_token_projects WHERE owner_id=? AND id=?',
    )
    .bind(owner, saved.projectId)
    .first<{ document: string }>();
  if (!project) throw new Error('Conditional project unavailable.');
  const guard = await captureConditionalPreparation(
    db,
    owner,
    { orderId: c.orderId, revision: c.orderRevision, level: c.level },
    {
      projectId: saved.projectId,
      projectRevision: saved.projectRevision,
      wallet: saved.document.wallet,
      walletRevision: saved.walletRevision,
      mint: saved.document.inputMint,
      decimals: JSON.parse(project.document).token.decimals,
      side: saved.document.side,
      unitsRaw: saved.document.inAmountRaw,
    },
    Date.now(),
    intentId,
  );
  if (!sameConditionalTerms(c, guard.selection))
    throw new Error('Conditional order terms changed.');
  return guard;
}
export function conditionalSigningWriteGuard(
  owner: string,
  projectId: string,
  guard?: ConditionalPreparationGuard,
) {
  return guard
    ? {
        sql: " AND EXISTS(SELECT 1 FROM conditional_sell_orders o JOIN imported_market_observations m ON m.owner_id=o.owner_id AND m.project_id=o.project_id WHERE o.owner_id=? AND o.project_id=? AND o.id=? AND o.revision=? AND o.state='draft' AND o.document=? AND m.document=?) AND julianday(?)>julianday('now')",
        bindings: [
          owner,
          projectId,
          guard.selection.orderId,
          guard.selection.orderRevision,
          guard.document,
          guard.marketDocument,
          guard.selection.expiresAt,
        ],
      }
    : { sql: '', bindings: [] };
}
export function conditionalPreparationWriteGuard(
  owner: string,
  projectId: string,
  guard?: ConditionalPreparationGuard,
) {
  return guard
    ? {
        sql: ` AND EXISTS(SELECT 1 FROM conditional_sell_orders o JOIN imported_market_observations m ON m.owner_id=o.owner_id AND m.project_id=o.project_id WHERE o.owner_id=? AND o.project_id=? AND o.id=? AND o.state='draft' AND o.revision=? AND o.document=? AND m.document=? AND NOT EXISTS(SELECT 1 FROM conditional_level_reservations v WHERE v.owner_id=o.owner_id AND v.order_id=o.id AND v.level=?) AND NOT EXISTS(SELECT 1 FROM conditional_level_fills f WHERE f.owner_id=o.owner_id AND f.order_id=o.id AND f.level=?)) AND ?>?`,
        bindings: [
          owner,
          projectId,
          guard.selection.orderId,
          guard.selection.orderRevision,
          guard.document,
          guard.marketDocument,
          guard.selection.level,
          guard.selection.level,
          Date.parse(guard.selection.expiresAt),
          Date.now(),
        ],
      }
    : { sql: '', bindings: [] };
}
