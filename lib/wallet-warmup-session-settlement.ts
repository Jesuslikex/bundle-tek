import { z } from 'zod';
import {
  observeWarmupBuyReceipt,
  type SavedWarmupBuyReceipt,
} from './warmup-buy-receipt';
import {
  observeWarmupSellReceipt,
  type WarmupSellReceipt,
} from './warmup-sell-receipt';
import type { SavedWarmupPreparation } from './warmup-preparation-history';
import type { WarmupSigningReview } from './warmup-signing';
import type { WalletWarmupSessionSequence } from './wallet-warmup-session-sequence';
import { reviewUnsignedSwapOrder } from './unsigned-swap-order';
import { canonicalPumpHolderJson as canonical } from './pump-holder-review';
import { walletAddress } from './wallet-workspace';
import { walletWarmupSessionDigest as digest } from './wallet-warmup-session-digest';

const uuid = z.uuid().refine((v) => v === v.toLowerCase());
const units = z
  .string()
  .regex(/^[1-9]\d{0,19}$/)
  .refine((v) => BigInt(v) < 1n << 64n);
const address = z.string().refine((v) => {
  try {
    return walletAddress(v, 'Solana') === v;
  } catch {
    return false;
  }
});
const context = {
  id: z.string().max(256),
  wallet: address,
  walletRevision: z.number().int().min(1).max(1e9),
  cycle: z.number().int().min(1).max(20),
  mint: address,
  scheduledAt: z.iso.datetime(),
};
const source = z
  .object({
    buyReceiptId: uuid,
    remainingRaw: units,
    decimals: z.number().int().min(0).max(18),
  })
  .strict();
const action = z.discriminatedUnion('side', [
  z
    .object({ ...context, side: z.literal('Buy'), inputLamports: units })
    .strict(),
  z
    .object({
      ...context,
      side: z.literal('Sell'),
      source: z.discriminatedUnion('kind', [
        z
          .object({
            kind: z.literal('session-buy'),
            actionId: z.string().max(256),
          })
          .strict(),
        z
          .object({
            kind: z.literal('saved-buy'),
            buyReceiptId: uuid,
            remainingRaw: units,
            decimals: z.number().int().min(0).max(18),
          })
          .strict(),
      ]),
    })
    .strict(),
]);
const selection = z
  .object({
    planId: z.string().regex(/^[a-zA-Z0-9-]{1,64}$/),
    planRevision: z.number().int().min(1).max(1e9),
    receiptId: uuid,
    candidate: z
      .object({
        action,
        sellSource: source.nullable(),
        executionAllowed: z.literal(false),
        signingAllowed: z.literal(false),
      })
      .strict(),
  })
  .strict();
export type WarmupSessionSettlementSelection = {
  planId: string;
  planRevision: number;
  receiptId: string;
  candidate: ReturnType<WalletWarmupSessionSequence['beginReview']>;
};
type Row = {
  receiptWallet: string | null;
  remainingRaw: string | null;
  receiptId: string;
  receiptPlanId: string;
  receiptSignature: string;
  receiptDocument: string;
  receiptPlanRevision: number | null;
  receiptWalletRevision: number | null;
  receiptCycle: number | null;
  buyReceiptId: string | null;
  consumedRaw: string | null;
  preparationId: string;
  planId: string;
  planRevision: number;
  cycle: number;
  walletRevision: number;
  preparationCreatedAt: string;
  preparationDocument: string;
  approvalId: string;
  approvalPreparationId: string;
  approvalWallet: string;
  approvalSignature: string;
  approvalState: string;
  approvalDocument: string;
};
const fail = (): never => {
  throw Error('Owned finalized settlement evidence is unavailable or changed.');
};
function document<T>(value: string): T {
  if (
    typeof value !== 'string' ||
    new TextEncoder().encode(value).byteLength > 1048576
  )
    return fail();
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    return fail();
  return parsed as T;
}
async function read(
  db: D1Database,
  owner: string,
  planId: string,
  id: string,
  side: 'Buy' | 'Sell',
) {
  // Table names are closed constants, never supplied by the caller.
  const table = side === 'Buy' ? 'warmup_buy_receipts' : 'warmup_sell_receipts';
  const specific =
    side === 'Buy'
      ? 'r.wallet_address AS receiptWallet,r.remaining_raw AS remainingRaw,r.plan_revision AS receiptPlanRevision,r.wallet_revision AS receiptWalletRevision,r.cycle AS receiptCycle,NULL AS buyReceiptId,NULL AS consumedRaw'
      : 'NULL AS receiptWallet,NULL AS remainingRaw,NULL AS receiptPlanRevision,NULL AS receiptWalletRevision,NULL AS receiptCycle,r.buy_receipt_id AS buyReceiptId,r.consumed_raw AS consumedRaw';
  const row = await db
    .prepare(`SELECT r.id AS receiptId,r.plan_id AS receiptPlanId,r.signature AS receiptSignature,r.document AS receiptDocument,${specific},
    s.id AS preparationId,s.plan_id AS planId,s.plan_revision AS planRevision,s.cycle,s.wallet_revision AS walletRevision,s.created_at AS preparationCreatedAt,s.document AS preparationDocument,
    i.id AS approvalId,i.preparation_id AS approvalPreparationId,i.wallet_address AS approvalWallet,i.signature AS approvalSignature,i.state AS approvalState,i.document AS approvalDocument
    FROM ${table} r JOIN warmup_swap_preparations s ON s.owner_id=r.owner_id AND s.id=r.preparation_id
    JOIN warmup_signing_intents i ON i.owner_id=s.owner_id AND i.preparation_id=s.id
    WHERE r.owner_id=? AND r.id=? AND r.plan_id=? AND EXISTS(SELECT 1 FROM wallet_warmup_plans p WHERE p.owner_id=r.owner_id AND p.id=r.plan_id)`)
    .bind(owner, id, planId)
    .first<Row>();
  if (!row) return fail();
  return row;
}
function decode(
  row: Row,
  selected: z.infer<typeof selection>,
  side: 'Buy' | 'Sell',
) {
  const a = selected.candidate.action;
  const preparation: SavedWarmupPreparation = {
    id: row.preparationId,
    planId: row.planId,
    planRevision: row.planRevision,
    cycle: row.cycle,
    walletRevision: row.walletRevision,
    createdAt: row.preparationCreatedAt,
    document: document(row.preparationDocument),
  };
  const approval = document<WarmupSigningReview>(row.approvalDocument),
    p = preparation.document;
  if (
    row.receiptPlanId !== selected.planId ||
    row.planId !== selected.planId ||
    row.planRevision !== selected.planRevision ||
    row.cycle !== a.cycle ||
    row.walletRevision !== a.walletRevision ||
    p.side !== side ||
    p.wallet !== a.wallet ||
    p.inputMint !==
      (side === 'Buy'
        ? 'So11111111111111111111111111111111111111112'
        : a.mint) ||
    p.outputMint !==
      (side === 'Sell'
        ? 'So11111111111111111111111111111111111111112'
        : a.mint) ||
    row.approvalState !== 'finalized' ||
    row.approvalPreparationId !== row.preparationId ||
    row.approvalSignature !== row.receiptSignature ||
    row.approvalWallet !== a.wallet ||
    approval.id !== row.approvalId ||
    approval.preparationId !== row.preparationId ||
    approval.wallet !== a.wallet ||
    approval.sha256 !== p.transaction.sha256 ||
    approval.network !== 'mainnet' ||
    approval.inputMint !== p.inputMint ||
    approval.outputMint !== p.outputMint ||
    approval.inputRaw !== p.inAmountRaw ||
    approval.minimumOutputRaw !== p.minimumOutRaw ||
    approval.lastValidBlockHeight !== p.transaction.lastValidBlockHeight
  )
    return fail();
  if (
    side === 'Buy' &&
    (row.receiptWallet !== a.wallet ||
      row.receiptPlanRevision !== selected.planRevision ||
      row.receiptCycle !== a.cycle ||
      row.receiptWalletRevision !== a.walletRevision)
  )
    return fail();
  return { preparation, approval };
}
async function checkPacket(
  preparation: SavedWarmupPreparation,
  approval: WarmupSigningReview,
) {
  // Parse the historical packet without the current-time expiry check used before signing.
  const packet = await reviewUnsignedSwapOrder(
    {
      transaction: approval.transaction,
      transactionVersion: 0,
      taker: approval.wallet,
      gasless: false,
      lastValidBlockHeight: approval.lastValidBlockHeight,
      signatureFeeLamports: 0,
      prioritizationFeeLamports: 0,
      rentFeeLamports: 0,
    },
    approval.wallet,
  );
  if (
    packet.sha256 !== preparation.document.transaction.sha256 ||
    packet.transactionBytes !== preparation.document.transaction.bytes
  )
    return fail();
}
function core(value: Record<string, unknown>, side: 'Buy' | 'Sell') {
  const keys = [
    'executionAllowed',
    'instructionsVerified',
    'network',
    'commitment',
    'signature',
    'signatureVerified',
    'wallet',
    'mint',
    'preparationSha256',
    'slot',
    'blockTime',
    'decimals',
    'tokenProgram',
    'accounts',
    'networkFeeLamports',
    'nativeChangeRaw',
    'rentChangeRaw',
    'nativeSettlementRaw',
    ...(side === 'Buy' ? ['acquiredRaw'] : ['consumedRaw', 'buyReceiptId']),
  ];
  if (keys.some((k) => value[k] === undefined)) return fail();
  return canonical(Object.fromEntries(keys.map((k) => [k, value[k]])));
}
/**
 * SELECT-only owned receipt replay. No authentication wrapper or caller exists yet.
 * Future callers must supply their verified owner; this grants no signing or send authority.
 */
export async function replayWarmupSessionSettlement(
  db: D1Database,
  owner: string,
  input: WarmupSessionSettlementSelection,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
) {
  if (typeof owner !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(owner))
    return fail();
  const selected = selection.parse(input),
    a = selected.candidate.action;
  const base = `${a.side}:${a.cycle}:${a.wallet}`;
  if (
    a.id !==
    (a.side === 'Sell' && a.source.kind === 'saved-buy'
      ? `${base}:${a.source.buyReceiptId}`
      : base)
  )
    return fail();
  if (a.side === 'Buy' && selected.candidate.sellSource !== null) return fail();
  if (
    a.side === 'Sell' &&
    (!selected.candidate.sellSource ||
      (a.source.kind === 'session-buy' &&
        a.source.actionId !== `Buy:${a.cycle}:${a.wallet}`) ||
      (a.source.kind === 'saved-buy' &&
        (a.source.buyReceiptId !== selected.candidate.sellSource.buyReceiptId ||
          a.source.remainingRaw !==
            selected.candidate.sellSource.remainingRaw ||
          a.source.decimals !== selected.candidate.sellSource.decimals)))
  )
    return fail();
  signal.throwIfAborted();
  const before = await read(
    db,
    owner,
    selected.planId,
    selected.receiptId,
    a.side,
  );
  signal.throwIfAborted();
  const { preparation, approval } = decode(before, selected, a.side);
  if (
    preparation.document.inAmountRaw !==
    (a.side === 'Buy'
      ? a.inputLamports
      : selected.candidate.sellSource!.remainingRaw)
  )
    return fail();
  await checkPacket(preparation, approval);
  signal.throwIfAborted();
  let linked: Row | undefined, buy: SavedWarmupBuyReceipt | undefined;
  if (a.side === 'Sell') {
    const expected = selected.candidate.sellSource!;
    if (
      before.buyReceiptId !== expected.buyReceiptId ||
      before.consumedRaw !== expected.remainingRaw ||
      preparation.document.buyReceipt?.receiptId !== expected.buyReceiptId ||
      (preparation.document.buyReceipt.remainingRaw ??
        preparation.document.buyReceipt.acquiredRaw) !== expected.remainingRaw
    )
      return fail();
    linked = await read(
      db,
      owner,
      selected.planId,
      expected.buyReceiptId,
      'Buy',
    );
    signal.throwIfAborted();
    const bound = decode(linked, selected, 'Buy');
    await checkPacket(bound.preparation, bound.approval);
    signal.throwIfAborted();
    const document = await observeWarmupBuyReceipt(
      bound.preparation,
      linked.receiptSignature,
      signal,
      fetcher,
      bound.approval,
    );
    if (
      core(document, 'Buy') !== core(documentFromRow(linked), 'Buy') ||
      document.decimals !== expected.decimals ||
      BigInt(document.acquiredRaw) < BigInt(expected.remainingRaw)
    )
      return fail();
    buy = {
      id: linked.receiptId,
      preparationId: linked.preparationId,
      planId: linked.planId,
      planRevision: linked.planRevision,
      cycle: linked.cycle,
      walletRevision: linked.walletRevision,
      createdAt: linked.preparationCreatedAt,
      document,
    };
  }
  const observed =
    a.side === 'Buy'
      ? await observeWarmupBuyReceipt(
          preparation,
          before.receiptSignature,
          signal,
          fetcher,
          approval,
        )
      : await observeWarmupSellReceipt(
          preparation,
          buy!,
          before.receiptSignature,
          signal,
          fetcher,
          approval,
        );
  signal.throwIfAborted();
  if (core(observed, a.side) !== core(documentFromRow(before), a.side))
    return fail();
  const after = await read(
    db,
    owner,
    selected.planId,
    selected.receiptId,
    a.side,
  );
  signal.throwIfAborted();
  if (canonical(before) !== canonical(after)) return fail();
  if (linked) {
    const afterBuy = await read(
      db,
      owner,
      selected.planId,
      linked.receiptId,
      'Buy',
    );
    signal.throwIfAborted();
    if (canonical(linked) !== canonical(afterBuy)) return fail();
  }
  const common = {
    actionId: a.id,
    planId: selected.planId,
    planRevision: selected.planRevision,
    wallet: a.wallet,
    walletRevision: a.walletRevision,
    mint: a.mint,
    receiptId: before.receiptId,
    network: 'mainnet' as const,
    commitment: 'finalized' as const,
    verified: true as const,
    networkFeeLamports: observed.networkFeeLamports,
    rentChangeLamports: observed.rentChangeRaw,
  };
  const settlement =
    a.side === 'Buy'
      ? {
          ...common,
          side: 'Buy' as const,
          inputLamports: (-BigInt(observed.nativeSettlementRaw)).toString(),
          acquiredRaw: (observed as SavedWarmupBuyReceipt['document'])
            .acquiredRaw,
          decimals: observed.decimals,
        }
      : {
          ...common,
          side: 'Sell' as const,
          buyReceiptId: selected.candidate.sellSource!.buyReceiptId,
          consumedRaw: (observed as WarmupSellReceipt).consumedRaw,
        };
  signal.throwIfAborted();
  const sourceSha256 = await digest(canonical([before, linked ?? null]));
  signal.throwIfAborted();
  return {
    settlement,
    sourceSha256,
    replayScope: 'owned-signature-packet-finalized-balances' as const,
    executionAllowed: false as const,
    signingAllowed: false as const,
    automaticExecutionAllowed: false as const,
  };
}
function documentFromRow(row: Row) {
  return document<Record<string, unknown>>(row.receiptDocument);
}
