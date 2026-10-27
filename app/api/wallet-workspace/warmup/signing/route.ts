import { decodeSwapFailure } from '@/lib/swap-failure-server';
import { validatedSwapFailure } from '@/lib/swap-failure';
import { validatedWarmupFailure } from '@/lib/warmup-approval-history';
import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getD1 } from '@/db';
import { warmupAtoms } from '@/lib/wallet-warmup';
import { UUID } from '@/lib/wallet-operation';
import {
  restoreWarmupOrder,
  requireWarmupSigningReview,
  type WarmupSigningReview,
} from '@/lib/warmup-signing';
import {
  simulateImportedSwap,
  SwapBlockhashExpiredError,
} from '@/lib/imported-swap-simulation';
import type { SavedWarmupPreparation } from '@/lib/warmup-preparation-history';
import {
  address,
  getBase64Encoder,
  getTransactionDecoder,
  getTransactionEncoder,
} from '@solana/kit';
import bs58 from 'bs58';
import { verifySolanaSignature } from '@/lib/solana-signature';
import {
  balanceRpc,
  SOLANA_MAINNET_GENESIS,
  WalletRpcError,
} from '@/lib/wallet-balances';
import { getSolanaRpcEndpoint } from '@/lib/solana-rpc';
import { refreshPacketBlockhash } from '@/lib/warmup-swap-quote';
import type { WarmupApprovalHistoryRow } from '@/lib/warmup-approval-history';
import { requireStoredWarmupBuyLink } from '@/lib/warmup-buy-link';
import type { SavedWarmupBuyReceipt } from '@/lib/warmup-buy-receipt';
import {
  isSessionBoundWarmupPreparation,
  SESSION_PREPARATION_SIGNING_DISABLED,
} from '@/lib/warmup-session-preparation-scope';
export const dynamic = 'force-dynamic';
const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
type Intent = {
  id: string;
  preparationId: string;
  wallet: string;
  state: string;
  signature: string | null;
  document: string;
  failureReceipt: string | null;
};
export async function GET(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return json({ error: 'Sign in to view approvals.' }, 401);
  const query = new URL(request.url).searchParams,
    preparationId = query.get('preparationId'),
    planId = query.get('planId'),
    cursor = query.get('cursor');
  if (planId !== null) {
    if (
      preparationId !== null ||
      !/^[a-zA-Z0-9-]{1,64}$/.test(planId) ||
      (cursor !== null && !UUID.test(cursor))
    )
      return json({ error: 'Choose a plan and valid approval cursor.' }, 400);
    try {
      const db = getD1();
      const plan = await db
        .prepare('SELECT id FROM wallet_warmup_plans WHERE owner_id=? AND id=?')
        .bind(user.userId, planId)
        .first();
      if (!plan) return json({ error: 'Warmup plan not found.' }, 404);
      const anchor = cursor
        ? await db
            .prepare(
              `SELECT i.id,i.created_at AS createdAt FROM warmup_signing_intents i JOIN warmup_swap_preparations s ON s.owner_id=i.owner_id AND s.id=i.preparation_id WHERE i.owner_id=? AND s.plan_id=? AND i.id=?`,
            )
            .bind(user.userId, planId, cursor)
            .first<{ id: string; createdAt: string }>()
        : null;
      if (cursor && !anchor)
        return json({ error: 'Approval cursor unavailable.' }, 400);
      const result = await db
        .prepare(
          `SELECT i.id,i.preparation_id AS preparationId,s.plan_id AS planId,s.plan_revision AS planRevision,i.wallet_address AS wallet,s.cycle,json_extract(s.document,'$.side') AS side,i.state,i.signature,i.failure_receipt AS failureReceipt,i.document,i.created_at AS createdAt,i.updated_at AS updatedAt FROM warmup_signing_intents i JOIN warmup_swap_preparations s ON s.owner_id=i.owner_id AND s.id=i.preparation_id WHERE i.owner_id=? AND s.plan_id=? AND (? IS NULL OR i.created_at<? OR (i.created_at=? AND i.id<?)) ORDER BY i.created_at DESC,i.id DESC LIMIT 51`,
        )
        .bind(
          user.userId,
          planId,
          anchor?.createdAt ?? null,
          anchor?.createdAt ?? '',
          anchor?.createdAt ?? '',
          anchor?.id ?? '',
        )
        .all<
          Omit<WarmupApprovalHistoryRow, 'document' | 'failureReceipt'> & {
            document: string;
            failureReceipt: string | null;
          }
        >();
      const intents = result.results.slice(0, 50).map((row) => {
        const document = JSON.parse(row.document) as WarmupSigningReview;
        if (
          document.id !== row.id ||
          document.preparationId !== row.preparationId ||
          document.wallet !== row.wallet ||
          document.network !== 'mainnet' ||
          !['Buy', 'Sell'].includes(row.side) ||
          ![
            'awaiting_signature',
            'signed',
            'submitted',
            'cancelled',
            'failed',
            'finalized',
          ].includes(row.state)
        )
          throw new Error('Approval context differs.');
        return {
          ...row,
          document,
          failureReceipt: validatedWarmupFailure({
            ...row,
            document,
            failureReceipt: row.failureReceipt
              ? JSON.parse(row.failureReceipt)
              : null,
          }),
        };
      });
      return json({
        planId,
        intents,
        nextCursor: result.results.length > 50 ? intents.at(-1)!.id : null,
      });
    } catch {
      return json({ error: 'Approval history unavailable.' }, 503);
    }
  }
  if (cursor !== null)
    return json({ error: 'Choose a plan for paged approval history.' }, 400);
  if (!preparationId || !UUID.test(preparationId))
    return json({ error: 'Choose a preparation.' }, 400);
  try {
    const row = await getD1()
      .prepare(
        'SELECT id,preparation_id AS preparationId,wallet_address AS wallet,state,signature,failure_receipt AS failureReceipt,document FROM warmup_signing_intents WHERE owner_id=? AND preparation_id=?',
      )
      .bind(user.userId, preparationId)
      .first<Intent>();
    const intent = row
      ? {
          ...row,
          document: JSON.parse(row.document),
          failureReceipt: row.failureReceipt
            ? JSON.parse(row.failureReceipt)
            : null,
        }
      : null;
    if (intent) validatedWarmupFailure(intent);
    return json({ intent });
  } catch {
    return json({ error: 'Approval history unavailable.' }, 503);
  }
}
export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return json({ error: 'Sign in to approve a transaction.' }, 401);
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
  let body: {
    action: string;
    intentId?: string;
    preparationId?: string;
    id?: string;
    transaction?: string;
  };
  try {
    const text = await request.text();
    if (text.length > 2200) return json({ error: 'Request too large.' }, 413);
    body = JSON.parse(text);
    if (
      !body ||
      !['review', 'register', 'submit', 'cancel', 'recover'].includes(
        body.action,
      )
    )
      throw new Error();
    if (
      body.action === 'review'
        ? !body.preparationId || !UUID.test(body.preparationId)
        : !body.id || !UUID.test(body.id)
    )
      throw new Error();
  } catch {
    return json({ error: 'Invalid approval request.' }, 400);
  }
  let stage = 'saved approval';
  try {
    const db = getD1(),
      signal = AbortSignal.any([request.signal, AbortSignal.timeout(60000)]),
      now = new Date().toISOString();
    if (body.action === 'review') {
      const row = await db
        .prepare(
          `SELECT s.id,s.plan_id AS planId,s.plan_revision AS planRevision,s.cycle,s.wallet_revision AS walletRevision,s.created_at AS createdAt,s.document FROM warmup_swap_preparations s JOIN wallet_warmup_plans p ON p.owner_id=s.owner_id AND p.id=s.plan_id AND p.revision=s.plan_revision WHERE s.owner_id=? AND s.id=? AND p.archived=0 AND (SELECT COUNT(*) FROM json_each(json_extract(p.document,'$.walletRevisions')) j JOIN workspace_wallets w ON w.address=json_extract(j.value,'$.address') AND w.revision=json_extract(j.value,'$.revision') WHERE w.owner_id=p.owner_id AND w.chain='Solana' AND w.archived=0)=json_array_length(json_extract(p.document,'$.addresses')) AND EXISTS(SELECT 1 FROM workspace_wallets w WHERE w.owner_id=s.owner_id AND w.chain='Solana' AND w.address=s.wallet_address AND w.revision=s.wallet_revision AND w.archived=0)`,
        )
        .bind(user.userId, body.preparationId)
        .first<
          Omit<SavedWarmupPreparation, 'document'> & { document: string }
        >();
      if (!row || typeof body.transaction !== 'string')
        return json({ error: 'Current saved preparation unavailable.' }, 409);
      if (await isSessionBoundWarmupPreparation(db, user.userId, row.id))
        return json({ error: SESSION_PREPARATION_SIGNING_DISABLED }, 409);
      const saved = {
        ...row,
        document: JSON.parse(row.document),
      } as SavedWarmupPreparation;
      if (saved.document.side === 'Sell') {
        const buyId = saved.document.buyReceipt?.receiptId;
        if (!buyId)
          return json(
            { error: 'Signing a sell requires a matched buy lot.' },
            409,
          );
        const lot = await db
          .prepare(
            "SELECT COALESCE(remaining_raw,json_extract(document,'$.acquiredRaw')) AS remainingRaw FROM warmup_buy_receipts WHERE owner_id=? AND id=?",
          )
          .bind(user.userId, buyId)
          .first<{ remainingRaw: string }>();
        if (
          !lot ||
          BigInt(lot.remainingRaw) < BigInt(saved.document.inAmountRaw)
        )
          return json(
            { error: 'Remaining buy units no longer cover this sell.' },
            409,
          );
      }
      stage = 'restore owned order';
      const order = await restoreWarmupOrder(saved, body.transaction);
      // DFlow's blockhash can arrive already near expiry, and the review plus a
      // wallet approval eat the rest of it. Take a fresh one before the review
      // simulation, so the signed packet starts with a full window.
      const fresh = await refreshPacketBlockhash(
        order.preparation.transaction,
        signal,
        fetch,
      );
      console.error('review refresh', {
        fresh: !!fresh,
        lvbh: fresh?.lastValidBlockHeight,
        reviewLvbh: order.preparation.lastValidBlockHeight,
      });
      if (fresh) {
        const digest = await crypto.subtle.digest(
          'SHA-256',
          Uint8Array.from(getBase64Encoder().encode(fresh.transaction)).buffer,
        );
        order.preparation.transaction = fresh.transaction;
        order.preparation.lastValidBlockHeight = fresh.lastValidBlockHeight;
        order.preparation.sha256 = Array.from(
          new Uint8Array(digest),
          (b) => b.toString(16).padStart(2, '0'),
        ).join('');
        saved.document.transaction.lastValidBlockHeight =
          fresh.lastValidBlockHeight;
        saved.document.transaction.sha256 = order.preparation.sha256;
      }
      const occupied = await db
        .prepare(
          "SELECT id FROM warmup_signing_intents WHERE owner_id=? AND (preparation_id=? OR (wallet_address=? AND state IN ('awaiting_signature','signed','submitted'))) LIMIT 1",
        )
        .bind(user.userId, saved.id, saved.document.wallet)
        .first();
      const reservation = await db
        .prepare(
          'SELECT scope,intent_id AS intentId FROM solana_swap_reservations WHERE owner_id=? AND wallet_address=?',
        )
        .bind(user.userId, saved.document.wallet)
        .first();
      // A re-review of the same intent (blockhash refresh before a re-sign) is
      // not a second approval, so it may reuse its own intent and reservation.
      const sameIntent =
        typeof body.intentId === 'string' &&
        (occupied as { id?: string } | null)?.id === body.intentId &&
        (!reservation ||
          (reservation as { intentId?: string }).intentId === body.intentId);
      if ((occupied || reservation) && !sameIntent)
        return json(
          { error: 'Recover the existing wallet approval first.', reservation },
          409,
        );
      const gateNow = Date.now();
      // The review re-simulates an order the prepare already read for, so it must
      // not queue behind the 15s read gate: the blockhash only lives ~150 blocks.
      const gate =
        body.action === 'review'
          ? { meta: { changes: 1 } }
          : await db
              .prepare(
                'INSERT INTO wallet_balance_gates(owner_id,next_allowed_at) VALUES (?,?) ON CONFLICT(owner_id) DO UPDATE SET next_allowed_at=excluded.next_allowed_at WHERE wallet_balance_gates.next_allowed_at<=?',
              )
              .bind(user.userId, gateNow + 15000, gateNow)
              .run();
      if (!gate.meta.changes) {
        const currentGate = await db
          .prepare(
            'SELECT next_allowed_at AS deadline FROM wallet_balance_gates WHERE owner_id=?',
          )
          .bind(user.userId)
          .first<{ deadline: number }>();
        return json(
          {
            error: 'Wait 15 seconds between wallet reads.',
            reviewWaitMs: Math.min(
              15000,
              Math.max(
                0,
                (currentGate?.deadline ?? gateNow + 15000) - Date.now(),
              ),
            ),
          },
          429,
        );
      }
      stage = 'independent simulation';
      const simulation = await simulateImportedSwap(order, signal, fetch, true);
      stage = 'settlement validation';
      const settlement = await requireWarmupSigningReview(order, simulation);
      const plan = await db
        .prepare(
          'SELECT document FROM wallet_warmup_plans WHERE owner_id=? AND id=? AND revision=? AND archived=0',
        )
        .bind(user.userId, saved.planId, saved.planRevision)
        .first<{ document: string }>();
      if (
        !plan ||
        BigInt(settlement.maximumRentLamports) +
          BigInt(simulation.networkFeeLamports) >
          warmupAtoms(JSON.parse(plan.document).feeReserve, 9)
      )
        return json(
          {
            error:
              'Network fee and new-account rent exceed the saved fee reserve.',
          },
          409,
        );
      // A re-review supersedes the intent it replaces, so the wallet is not left
      // occupied by a signature that can no longer land.
      if (sameIntent) {
        await db
          .prepare(
            "UPDATE warmup_signing_intents SET state='failed', updated_at=? WHERE owner_id=? AND id=? AND state IN ('awaiting_signature','signed')",
          )
          .bind(new Date().toISOString(), user.userId, body.intentId)
          .run();
        await db
          .prepare(
            'DELETE FROM solana_swap_reservations WHERE owner_id=? AND intent_id=?',
          )
          .bind(user.userId, body.intentId)
          .run();
      }
      const id = crypto.randomUUID(),
        review: WarmupSigningReview = {
          id,
          preparationId: saved.id,
          wallet: saved.document.wallet,
          sha256: saved.document.transaction.sha256,
          network: 'mainnet',
          expiresAt: order.expiresAt,
          maximumFeeLamports: simulation.networkFeeLamports,
          inputRaw: order.inAmount,
          minimumOutputRaw: order.minimumOutAmount,
          inputMint: order.inputMint,
          outputMint: order.outputMint,
          transaction: order.preparation.transaction,
          lastValidBlockHeight: order.preparation.lastValidBlockHeight,
          settlement,
          ...(order.platformFee ? { platformFee: order.platformFee } : {}),
          ...(saved.document.buyReceipt
            ? { buyReceipt: saved.document.buyReceipt }
            : {}),
        };
      // Persist the refreshed packet so submission signs the same bytes.
      if (fresh) {
        review.transaction = order.preparation.transaction;
        review.lastValidBlockHeight = order.preparation.lastValidBlockHeight;
        review.sha256 = order.preparation.sha256;
        const document = JSON.stringify(saved.document);
        await db
          .prepare(
            'UPDATE warmup_swap_preparations SET document=? WHERE owner_id=? AND id=? AND document=?',
          )
          .bind(document, user.userId, saved.id, row.document)
          .run();
        row.document = document;
      }
      stage = 'reserve unsigned approval';
      const write = await db
        .prepare(
          `INSERT OR IGNORE INTO warmup_signing_intents(id,owner_id,preparation_id,wallet_address,document,state,created_at,updated_at) SELECT ?,?,?,?,?, 'awaiting_signature',?,? WHERE EXISTS(SELECT 1 FROM warmup_swap_preparations s JOIN wallet_warmup_plans p ON p.id=s.plan_id AND p.owner_id=s.owner_id WHERE s.owner_id=? AND s.id=? AND s.document=? AND p.revision=s.plan_revision AND p.archived=0 AND (SELECT COUNT(*) FROM json_each(json_extract(p.document,'$.walletRevisions')) j JOIN workspace_wallets w ON w.address=json_extract(j.value,'$.address') AND w.revision=json_extract(j.value,'$.revision') WHERE w.owner_id=p.owner_id AND w.chain='Solana' AND w.archived=0)=json_array_length(json_extract(p.document,'$.addresses')) AND EXISTS(SELECT 1 FROM workspace_wallets w WHERE w.owner_id=s.owner_id AND w.chain='Solana' AND w.address=s.wallet_address AND w.revision=s.wallet_revision AND w.archived=0)) AND ?>?`,
        )
        .bind(
          id,
          user.userId,
          saved.id,
          review.wallet,
          JSON.stringify(review),
          now,
          now,
          user.userId,
          saved.id,
          row.document,
          Date.parse(review.expiresAt),
          Date.now(),
        )
        .run();
      if (!write.meta.changes)
        return json(
          {
            error:
              'An approval already exists, this wallet has an unresolved transaction, or the plan changed. Recover the existing approval first.',
          },
          409,
        );
      return json({ review });
    }
    const row = await db
      .prepare(
        'SELECT id,preparation_id AS preparationId,wallet_address AS wallet,state,signature,failure_receipt AS failureReceipt,document FROM warmup_signing_intents WHERE owner_id=? AND id=?',
      )
      .bind(user.userId, body.id)
      .first<Intent>();
    if (!row) return json({ error: 'Approval unavailable.' }, 404);
    if (
      ['register', 'submit'].includes(body.action) &&
      (await isSessionBoundWarmupPreparation(
        db,
        user.userId,
        row.preparationId,
      ))
    )
      return json({ error: SESSION_PREPARATION_SIGNING_DISABLED }, 409);
    const review = JSON.parse(row.document) as WarmupSigningReview;
    if (body.action === 'recover') {
      if (
        !row.signature ||
        !['signed', 'submitted', 'failed', 'finalized'].includes(row.state)
      )
        return json({ error: 'No registered signature to recover.' }, 409);
      if (
        row.state === 'finalized' ||
        (row.state === 'failed' && row.failureReceipt)
      )
        return json({
          state: row.state,
          signature: row.signature,
          ...(row.failureReceipt
            ? {
                failureReceipt: validatedSwapFailure(
                  JSON.parse(row.failureReceipt),
                  review,
                  row.signature,
                ),
              }
            : {}),
        });
      const endpoint = getSolanaRpcEndpoint('mainnet'),
        rpc = (method: string, params: unknown[]) =>
          balanceRpc(endpoint, method, params, signal, fetch);
      if ((await rpc('getGenesisHash', [])) !== SOLANA_MAINNET_GENESIS)
        throw new Error('Wrong network.');
      const raw = (await rpc('getTransaction', [
        row.signature,
        {
          encoding: 'base64',
          commitment: 'finalized',
          maxSupportedTransactionVersion: 0,
        },
      ])) as { meta?: { err?: unknown }; transaction?: unknown };
      if (
        !raw?.meta ||
        raw.meta.err === undefined ||
        !Array.isArray(raw.transaction) ||
        raw.transaction[1] !== 'base64' ||
        typeof raw.transaction[0] !== 'string'
      )
        return json(
          {
            error:
              'Finalized outcome unavailable. Keep this signature reserved.',
          },
          409,
        );
      const tx = getTransactionDecoder().decode(
          getBase64Encoder().encode(raw.transaction[0]),
        ),
        sig = tx.signatures[address(review.wallet)];
      const unsigned = getTransactionEncoder().encode({
          ...tx,
          signatures: { [review.wallet]: null },
        }),
        approved = getBase64Encoder().encode(review.transaction);
      if (
        Object.keys(tx.signatures).length !== 1 ||
        !sig ||
        bs58.encode(sig) !== row.signature ||
        unsigned.length !== approved.length ||
        unsigned.some((b, i) => b !== approved[i]) ||
        !verifySolanaSignature(
          Uint8Array.from(tx.messageBytes),
          Uint8Array.from(sig),
          bs58.decode(review.wallet),
        )
      )
        throw new Error('Receipt packet differs.');
      if (row.state === 'failed' && raw.meta.err === null)
        throw new Error('Retained failed outcome differs.');
      if (raw.meta.err === null)
        return json({
          state: row.state,
          signature: row.signature,
          message:
            'Transaction finalized successfully. Verify its matching buy or sell receipt to update remaining units and finish this approval.',
        });
      const failureReceipt = await decodeSwapFailure(
        raw,
        review,
        row.signature,
      );
      await db
        .prepare(
          "UPDATE warmup_signing_intents SET state='failed',failure_receipt=?,updated_at=? WHERE owner_id=? AND id=? AND signature=? AND (state IN ('signed','submitted') OR (state='failed' AND failure_receipt IS NULL))",
        )
        .bind(
          JSON.stringify(failureReceipt),
          now,
          user.userId,
          row.id,
          row.signature,
        )
        .run();
      const retained = await db
        .prepare(
          'SELECT state,failure_receipt AS failureReceipt FROM warmup_signing_intents WHERE owner_id=? AND id=? AND signature=?',
        )
        .bind(user.userId, row.id, row.signature)
        .first<{ state: string; failureReceipt: string | null }>();
      if (retained?.state !== 'failed' || !retained.failureReceipt)
        throw new Error('Retained failure unavailable.');
      return json({
        state: 'failed',
        signature: row.signature,
        failureReceipt: validatedSwapFailure(
          JSON.parse(retained.failureReceipt),
          review,
          row.signature,
        ),
      });
    }
    if (body.action === 'cancel') {
      const write = await db
        .prepare(
          "UPDATE warmup_signing_intents SET state='cancelled',updated_at=? WHERE owner_id=? AND id=? AND state='awaiting_signature' AND signature IS NULL",
        )
        .bind(now, user.userId, row.id)
        .run();
      return write.meta.changes
        ? json({ state: 'cancelled' })
        : json(
            { error: 'A signed transaction requires receipt recovery.' },
            409,
          );
    }
    if (typeof body.transaction !== 'string' || body.transaction.length > 1644)
      return json({ error: 'Signed packet required.' }, 400);
    const bytes = getBase64Encoder().encode(body.transaction),
      tx = getTransactionDecoder().decode(bytes),
      sig = tx.signatures[address(review.wallet)];
    const unsigned = getTransactionEncoder().encode({
        ...tx,
        signatures: { [review.wallet]: null },
      }),
      approved = getBase64Encoder().encode(review.transaction);
    if (
      bytes.length > 1232 ||
      Object.keys(tx.signatures).length !== 1 ||
      !sig ||
      unsigned.length !== approved.length ||
      unsigned.some((b, i) => b !== approved[i]) ||
      !verifySolanaSignature(
        Uint8Array.from(tx.messageBytes),
        Uint8Array.from(sig),
        bs58.decode(review.wallet),
      )
    )
      return json(
        { error: 'Signature or exact approved packet differs.' },
        400,
      );
    const signature = bs58.encode(sig);
    if (body.action === 'register') {
      if (
        row.signature === signature &&
        ['signed', 'submitted', 'finalized'].includes(row.state)
      )
        return json({ signature, state: row.state });
      const write = await db
        .prepare(
          "UPDATE warmup_signing_intents SET signature=?,state='signed',updated_at=? WHERE owner_id=? AND id=? AND state='awaiting_signature' AND signature IS NULL",
        )
        .bind(signature, now, user.userId, row.id)
        .run();
      return write.meta.changes
        ? json({ signature, state: 'signed' })
        : json({ error: 'Approval state changed.' }, 409);
    }
    if (row.signature !== signature || row.state !== 'signed')
      return json(
        {
          error:
            'Register this signature before one submission. Submitted packets require receipt recovery.',
        },
        409,
      );
    if (Date.parse(review.expiresAt) <= Date.now())
      return json(
        {
          error:
            'Approval expired. Keep the registered signature for recovery.',
        },
        409,
      );
    const endpoint = getSolanaRpcEndpoint('mainnet'),
      rpc = (method: string, params: unknown[]) =>
        balanceRpc(endpoint, method, params, signal, fetch);
    if ((await rpc('getGenesisHash', [])) !== SOLANA_MAINNET_GENESIS)
      return json({ error: 'Submission network differs.' }, 502);
    const orderRow = await db
      .prepare(
        `SELECT id,plan_id AS planId,plan_revision AS planRevision,cycle,wallet_revision AS walletRevision,created_at AS createdAt,document FROM warmup_swap_preparations s WHERE owner_id=? AND id=? AND EXISTS(SELECT 1 FROM wallet_warmup_plans p WHERE p.owner_id=s.owner_id AND p.id=s.plan_id AND p.revision=s.plan_revision AND p.archived=0) AND EXISTS(SELECT 1 FROM workspace_wallets w WHERE w.owner_id=s.owner_id AND w.chain='Solana' AND w.address=s.wallet_address AND w.revision=s.wallet_revision AND w.archived=0)`,
      )
      .bind(user.userId, review.preparationId)
      .first<Omit<SavedWarmupPreparation, 'document'> & { document: string }>();
    if (!orderRow) return json({ error: 'Preparation unavailable.' }, 409);
    const order = await restoreWarmupOrder(
      { ...orderRow, document: JSON.parse(orderRow.document) },
      review.transaction,
    );
    const freshSimulation = await simulateImportedSwap(
      order,
      signal,
      fetch,
      true,
    );
    const freshSettlement = await requireWarmupSigningReview(
      order,
      freshSimulation,
    );
    if (
      !review.settlement ||
      JSON.stringify(review.settlement) !== JSON.stringify(freshSettlement) ||
      freshSimulation.networkFeeLamports !== review.maximumFeeLamports
    )
      return json(
        {
          error:
            'Approved setup, rent, fee or lookup tables changed. Keep this signature reserved for recovery.',
        },
        409,
      );
    const plan = await db
      .prepare(
        'SELECT document FROM wallet_warmup_plans WHERE owner_id=? AND id=? AND revision=? AND archived=0',
      )
      .bind(user.userId, orderRow.planId, orderRow.planRevision)
      .first<{ document: string }>();
    if (
      !plan ||
      BigInt(freshSettlement.maximumRentLamports) +
        BigInt(freshSimulation.networkFeeLamports) >
        warmupAtoms(JSON.parse(plan.document).feeReserve, 9)
    )
      return json(
        {
          error:
            'Network fee and new-account rent exceed the saved fee reserve. Keep this signature reserved for recovery.',
        },
        409,
      );
    const savedDoc = JSON.parse(
      orderRow.document,
    ) as SavedWarmupPreparation['document'];
    const buyId = savedDoc.buyReceipt?.receiptId ?? '';
    let capturedRemaining = '';
    if (savedDoc.side === 'Sell') {
      const lot = await db
        .prepare(
          "SELECT id,preparation_id AS preparationId,plan_id AS planId,plan_revision AS planRevision,cycle,wallet_revision AS walletRevision,created_at AS createdAt,COALESCE(remaining_raw,json_extract(document,'$.acquiredRaw')) AS remainingRaw,document FROM warmup_buy_receipts WHERE owner_id=? AND id=?",
        )
        .bind(user.userId, buyId)
        .first<
          Omit<SavedWarmupBuyReceipt, 'document'> & {
            document: string;
            remainingRaw: string;
          }
        >();
      capturedRemaining = lot?.remainingRaw ?? '';
      if (!lot || BigInt(lot.remainingRaw) < BigInt(savedDoc.inAmountRaw))
        return json({ error: 'Remaining buy units changed.' }, 409);
      requireStoredWarmupBuyLink(
        { ...lot, document: JSON.parse(lot.document) },
        {
          planId: orderRow.planId,
          planRevision: orderRow.planRevision,
          cycle: orderRow.cycle,
          walletRevision: orderRow.walletRevision,
          wallet: savedDoc.wallet,
          mint: savedDoc.inputMint,
        },
        savedDoc.buyReceipt,
      );
    }
    // Mark before broadcast. A timeout must never silently enable a second send.
    const armed = await db
      .prepare(
        "UPDATE warmup_signing_intents SET state='submitted',updated_at=? WHERE owner_id=? AND id=? AND state='signed' AND signature=? AND EXISTS(SELECT 1 FROM warmup_swap_preparations s JOIN wallet_warmup_plans p ON p.owner_id=s.owner_id AND p.id=s.plan_id WHERE s.owner_id=? AND s.id=? AND p.revision=s.plan_revision AND p.archived=0 AND (SELECT COUNT(*) FROM json_each(json_extract(p.document,'$.walletRevisions')) j JOIN workspace_wallets w ON w.address=json_extract(j.value,'$.address') AND w.revision=json_extract(j.value,'$.revision') WHERE w.owner_id=p.owner_id AND w.chain='Solana' AND w.archived=0)=json_array_length(json_extract(p.document,'$.addresses')) AND EXISTS(SELECT 1 FROM workspace_wallets w WHERE w.owner_id=s.owner_id AND w.chain='Solana' AND w.address=s.wallet_address AND w.revision=s.wallet_revision AND w.archived=0)) AND (?='' OR EXISTS(SELECT 1 FROM warmup_buy_receipts WHERE owner_id=? AND id=? AND COALESCE(remaining_raw,json_extract(document,'$.acquiredRaw'))=?))",
      )
      .bind(
        now,
        user.userId,
        row.id,
        signature,
        user.userId,
        review.preparationId,
        buyId,
        user.userId,
        buyId,
        capturedRemaining,
      )
      .run();
    if (!armed.meta.changes)
      return json({ error: 'Submission already in progress.' }, 409);
    try {
      const returned = await rpc('sendTransaction', [
        body.transaction,
        {
          encoding: 'base64',
          skipPreflight: false,
          preflightCommitment: 'confirmed',
          maxRetries: 0,
        },
      ]);
      if (returned !== signature) throw new Error();
      return json({ signature, state: 'submitted' });
    } catch {
      return json(
        {
          error:
            'Submission outcome unknown. Recover this registered signature; do not create a replacement transaction.',
          signature,
          state: 'submitted',
        },
        502,
      );
    }
  } catch (err) {
    if (
      err instanceof Error &&
      err.message.includes(SESSION_PREPARATION_SIGNING_DISABLED)
    )
      return json({ error: SESSION_PREPARATION_SIGNING_DISABLED }, 409);
    if (err instanceof SwapBlockhashExpiredError) {
      console.error('blockhash expired', { stage, action: body.action });
      return json(
        {
          error:
            body.action === 'review'
              ? 'Prepared transaction blockhash expired. Prepare a fresh order before approval.'
              : 'Approved transaction blockhash expired. Keep the registered signature for receipt recovery. Do not create a replacement automatically.',
        },
        409,
      );
    }
    console.error('Warmup approval failed', {
      stage,
      status: err instanceof WalletRpcError ? err.status : null,
      message: err instanceof Error ? err.message : String(err),
    });
    if (err instanceof WalletRpcError)
      return json(
        {
          error:
            err.status === 429
              ? 'Solana provider rate limit reached. Wait and review a fresh preparation.'
              : 'Solana approval provider unavailable.',
        },
        502,
      );
    return json(
      {
        error:
          err instanceof Error &&
          /Signing requires|Additional transfers|Network debit|Simulated swap|Unrelated token|Reviewed packet/.test(
            err.message,
          )
            ? err.message
            : 'Approval checks unavailable. No automatic signature or submission.',
      },
      502,
    );
  }
}
