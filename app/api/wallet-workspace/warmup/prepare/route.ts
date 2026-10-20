import { env } from '@/lib/server-env';
import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getD1 } from '@/db';
import { buildWarmupPlan, warmupBuyAmount } from '@/lib/wallet-warmup';
import { WARMUP_HISTORY_LIMIT } from '@/lib/warmup-history-capacity';
import { walletAddress } from '@/lib/wallet-workspace';
import { prepareSolanaSwap } from '@/lib/warmup-swap-quote';
import {
  simulateImportedSwap,
  SwapBlockhashExpiredError,
} from '@/lib/imported-swap-simulation';
import type { SavedWarmup } from '@/lib/wallet-warmup-storage';
import type { SavedWarmupBuyReceipt } from '@/lib/warmup-buy-receipt';
import { warmupBuyLink } from '@/lib/warmup-buy-link';
import { UUID } from '@/lib/wallet-operation';
import { WalletRpcError } from '@/lib/wallet-balances';
import { WarmupQuoteError } from '@/lib/warmup-swap-quote';
import {
  warmupPreparationSummary,
  saveWarmupPreparation,
} from '@/lib/warmup-preparation-history';
import {
  inspectWarmupSellInventory,
  WarmupSellAmountError,
} from '@/lib/warmup-sell-inventory';
export const dynamic = 'force-dynamic';
const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return json({ error: 'Sign in to prepare a saved warmup.' }, 401);
  if (
    !request.headers
      .get('content-type')
      ?.toLowerCase()
      .startsWith('application/json')
  )
    return json({ error: 'JSON required.' }, 415);
  if (
    request.headers.get('origin') &&
    request.headers.get('origin') !== new URL(request.url).origin
  )
    return json({ error: 'Cross-origin request rejected.' }, 403);
  let input: {
    id: string;
    revision: number;
    cycle: number;
    wallet: string;
    side?: 'Buy' | 'Sell';
    mode?: 'inventory';
    amount?: string;
    buyReceiptId?: string;
    useHistoricalBuy?: boolean;
  };
  try {
    const text = await request.text();
    if (text.length > 700) return json({ error: 'Request too large.' }, 413);
    input = JSON.parse(text);
    if (
      !input ||
      typeof input.id !== 'string' ||
      !/^[a-zA-Z0-9-]{1,64}$/.test(input.id) ||
      !Number.isSafeInteger(input.revision) ||
      input.revision < 1 ||
      input.revision >= 1000000000 ||
      !Number.isSafeInteger(input.cycle) ||
      input.cycle < 1 ||
      input.cycle > 20 ||
      (input.side !== undefined && !['Buy', 'Sell'].includes(input.side)) ||
      (input.buyReceiptId !== undefined &&
        (input.side !== 'Sell' || !UUID.test(input.buyReceiptId))) ||
      (input.useHistoricalBuy !== undefined &&
        (typeof input.useHistoricalBuy !== 'boolean' ||
          input.side !== 'Sell' ||
          !input.buyReceiptId)) ||
      (input.mode !== undefined &&
        (input.mode !== 'inventory' || input.side !== 'Sell')) ||
      (input.side === 'Sell' &&
        input.mode !== 'inventory' &&
        (typeof input.amount !== 'string' ||
          !/^(0|[1-9]\d*)(\.\d+)?$/.test(input.amount) ||
          input.amount.length > 260))
    )
      throw new Error();
    input.wallet = walletAddress(input.wallet, 'Solana');
  } catch {
    return json(
      { error: 'Choose a saved warmup revision, cycle and wallet.' },
      400,
    );
  }
  let stage = 'saved context';
  try {
    const db = getD1();
    const read = () =>
      db
        .prepare(
          `SELECT document FROM wallet_warmup_plans p WHERE owner_id=? AND id=? AND revision=? AND archived=0 AND (SELECT COUNT(*) FROM json_each(json_extract(p.document,'$.walletRevisions')) j JOIN workspace_wallets w ON w.address=json_extract(j.value,'$.address') AND w.revision=json_extract(j.value,'$.revision') WHERE w.owner_id=p.owner_id AND w.chain=json_extract(p.document,'$.chain') AND w.archived=0)=json_array_length(json_extract(p.document,'$.addresses'))`,
        )
        .bind(user.userId, input.id, input.revision)
        .first<{ document: string }>();
    const row = await read();
    if (!row)
      return json(
        {
          error: 'Saved plan or wallet revisions changed, or plan is archived.',
        },
        409,
      );
    const document = JSON.parse(row.document) as SavedWarmup['document'];
    if (document.chain !== 'Solana')
      return json(
        { error: 'Unsigned warmup preparation supports Solana.' },
        400,
      );
    stage = 'plan validation';
    const plan = buildWarmupPlan(
      document,
      Math.min(Date.now(), Date.parse(document.startAt)),
    );
    if (input.cycle > plan.cycles || !plan.addresses.includes(input.wallet))
      return json(
        { error: 'Choose a cycle and wallet in the saved plan.' },
        400,
      );
    const walletRevision = document.walletRevisions.find(
      (w) => w.address === input.wallet,
    )?.revision;
    if (!walletRevision)
      return json({ error: 'Saved wallet revision unavailable.' }, 409);
    const mint = plan.tokens[(input.cycle - 1) % plan.tokens.length];
    let buyReceipt: SavedWarmupBuyReceipt | undefined;
    const receiptContext = {
      planId: input.id,
      planRevision: input.revision,
      allowHistoricalBuy: input.useHistoricalBuy === true,
      cycle: input.cycle,
      wallet: input.wallet,
      walletRevision,
      mint,
    };
    if (input.buyReceiptId) {
      const stored = await db
        .prepare(
          'SELECT id,preparation_id AS preparationId,plan_id AS planId,plan_revision AS planRevision,cycle,wallet_revision AS walletRevision,created_at AS createdAt,remaining_raw AS remainingRaw,document FROM warmup_buy_receipts WHERE owner_id=? AND id=?',
        )
        .bind(user.userId, input.buyReceiptId)
        .first<
          Omit<SavedWarmupBuyReceipt, 'document'> & { document: string }
        >();
      if (!stored)
        return json({ error: 'Matching buy receipt unavailable.' }, 409);
      buyReceipt = { ...stored, document: JSON.parse(stored.document) };
      try {
        warmupBuyLink(buyReceipt, receiptContext);
      } catch {
        return json(
          {
            error:
              'Buy receipt does not match this saved cycle, wallet and revision.',
          },
          409,
        );
      }
    }
    const key = (env as unknown as Record<string, unknown>).JUPITER_API_KEY;
    if (input.mode !== 'inventory' && (typeof key !== 'string' || !key))
      return json(
        { error: 'Swap preparation service is not configured.' },
        503,
      );
    const now = Date.now();
    if (input.mode !== 'inventory') {
      const count = await db
        .prepare(
          'SELECT COUNT(*) AS n FROM warmup_swap_preparations WHERE owner_id=? AND plan_id=?',
        )
        .bind(user.userId, input.id)
        .first<{ n: number }>();
      if (!count || count.n >= WARMUP_HISTORY_LIMIT)
        return json({ error: 'Warmup preparation history is full.' }, 409);
    }
    stage = 'read gate';
    const gate = await db
      .prepare(
        'INSERT INTO wallet_balance_gates(owner_id,next_allowed_at) VALUES (?,?) ON CONFLICT(owner_id) DO UPDATE SET next_allowed_at=excluded.next_allowed_at WHERE wallet_balance_gates.next_allowed_at<=?',
      )
      .bind(user.userId, now + 15000, now)
      .run();
    if (!gate.meta.changes)
      return json({ error: 'Wait 15 seconds between wallet reads.' }, 429);
    const signal = AbortSignal.any([
      request.signal,
      AbortSignal.timeout(25000),
    ]);
    const side = input.side ?? 'Buy';
    const inventory =
      side === 'Sell'
        ? await inspectWarmupSellInventory(
            input.wallet,
            mint,
            signal,
            input.mode === 'inventory' ? undefined : input.amount,
          )
        : undefined;
    if (inventory && !(await read()))
      return json(
        { error: 'Saved plan or wallets changed during inventory read.' },
        409,
      );
    let buyLink;
    if (buyReceipt && inventory) {
      try {
        buyLink = warmupBuyLink(buyReceipt, receiptContext, inventory);
      } catch {
        return json(
          {
            error:
              'Sell input exceeds the matching buy acquisition or inventory is stale or mismatched.',
            inventory,
          },
          409,
        );
      }
    }
    if (input.mode === 'inventory')
      return json({
        id: input.id,
        revision: input.revision,
        cycle: input.cycle,
        walletRevision,
        inventory,
        ...(buyLink ? { buyLink } : {}),
      });
    if (
      inventory &&
      (!inventory.preparationSupported ||
        !inventory.amountCovered ||
        inventory.decimals === null)
    )
      return json(
        {
          error: 'Fresh unfrozen holdings do not cover a supported sell input.',
          inventory,
        },
        409,
      );
    stage = 'provider order';
    const order = await prepareSolanaSwap(
      {
        tokenMint: mint,
        side,
        amount:
          side === 'Sell'
            ? input.amount!
            : warmupBuyAmount(document, input.wallet, input.cycle),
        decimals: inventory?.decimals ?? 9,
        wallet: input.wallet,
      },
      typeof key === 'string' ? key : undefined,
      signal,
    );
    if (order.side !== side || order.preparation?.wallet !== input.wallet)
      return json(
        { error: 'Prepared order does not match the requested warmup.' },
        409,
      );
    const expired = () =>
      !Number.isFinite(Date.parse(order.expiresAt)) ||
      Date.parse(order.expiresAt) <= Date.now();
    if (!(await read()) || expired())
      return json(
        { error: 'Saved plan or wallets changed, or order expired.' },
        409,
      );
    stage = 'independent simulation';
    const simulation = await simulateImportedSwap(order, signal);
    if (!(await read()) || expired())
      return json(
        { error: 'Saved plan or wallets changed, or order expired.' },
        409,
      );
    stage = 'retained summary';
    const history = await saveWarmupPreparation(
      db,
      user.userId,
      {
        planId: input.id,
        planRevision: input.revision,
        cycle: input.cycle,
        walletRevision,
      },
      warmupPreparationSummary(order, simulation, mint, inventory, buyLink),
      row.document,
    );
    if (!history || expired())
      return json(
        {
          error:
            'Preparation expired, history is full or saved plan/wallets changed. Prepare again.',
        },
        409,
      );
    return json({
      id: input.id,
      revision: input.revision,
      cycle: input.cycle,
      walletRevision,
      order,
      simulation,
      history,
      reviewWaitMs: Math.max(0, now + 15000 - Date.now()),
      ...(inventory ? { inventory } : {}),
      ...(buyLink ? { buyLink } : {}),
    });
  } catch (error) {
    if (error instanceof SwapBlockhashExpiredError)
      return json(
        {
          error:
            'Prepared transaction blockhash expired. Prepare a fresh order.',
        },
        409,
      );
    console.error('Warmup preparation failed', {
      stage,
    });
    if (error instanceof WalletRpcError)
      return json(
        {
          error:
            error.status === 429
              ? 'Solana provider rate limit reached. Wait and prepare again.'
              : error.status === 403
                ? 'Solana provider denied this read. Configure an authorized RPC provider.'
                : 'Solana preparation provider unavailable.',
        },
        502,
      );
    if (error instanceof WarmupQuoteError)
      return json({ error: error.message }, 502);
    if (error instanceof WarmupSellAmountError)
      return json({ error: error.message }, 400);
    return json(
      { error: 'Warmup preparation unavailable. No execution clearance.' },
      502,
    );
  }
}
