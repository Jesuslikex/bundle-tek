import {
  currentTradeSession,
  tradeSessionWriteGuard,
} from '@/lib/imported-trade-session-server';
import { validatedTradeSessionCapture } from '@/lib/imported-trade-session';
import {
  currentConditionalSigning,
  conditionalSigningWriteGuard,
} from '@/lib/conditional-preparation-server';
import {
  validatedConditionalSigning,
  requireConditionalSwapContext,
  requireConditionalBuyOutputPrecision,
} from '@/lib/conditional-signing';
import { ConditionalBuyStorageUnavailable } from '@/lib/conditional-buy-capability';
import { decodeSwapFailure } from '@/lib/swap-failure-server';
import { validatedSwapFailure } from '@/lib/swap-failure';
import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getD1 } from '@/db';
import { UUID } from '@/lib/wallet-operation';
import {
  currentImportedPreparation,
  reserveImportedApproval,
  verifyExactSwapSignature,
  type ImportedSwapApproval,
} from '@/lib/imported-swap-approval';
import {
  restoreSavedSwapOrder,
  requireWarmupSigningReview,
  type WarmupSigningReview,
} from '@/lib/warmup-signing';
import {
  simulateImportedSwap,
  SwapBlockhashExpiredError,
} from '@/lib/imported-swap-simulation';
import { balanceRpc, SOLANA_MAINNET_GENESIS } from '@/lib/wallet-balances';
import { getSolanaRpcEndpoint } from '@/lib/solana-rpc';
import { decodeWarmupReceipt } from '@/lib/warmup-buy-receipt';
import type { SavedSwapPreparation } from '@/lib/imported-swap-preparation-history';
import {
  currentImportedAcquisition,
  finalizeImportedAcquisition,
} from '@/lib/imported-acquisition-server';
import { validatedImportedAcquisitionSelection } from '@/lib/imported-acquisition';
import type { ImportedTradeReceipt } from '@/lib/imported-trade-ledger';
export const dynamic = 'force-dynamic';
const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
type StoredIntent = Omit<
  ImportedSwapApproval,
  'document' | 'failureReceipt'
> & {
  document: string;
  failureReceipt: string | null;
};
const columns =
  'i.id,i.preparation_id AS preparationId,i.wallet_address AS wallet,i.state,i.signature,i.failure_receipt AS failureReceipt,i.document,i.created_at AS createdAt,i.updated_at AS updatedAt';
async function readReceipt(db: D1Database, owner: string, intentId: string) {
  const row = await db
    .prepare(
      'SELECT id,project_id AS projectId,preparation_id AS preparationId,project_revision AS projectRevision,wallet_revision AS walletRevision,created_at AS createdAt,document FROM imported_swap_receipts WHERE owner_id=? AND intent_id=?',
    )
    .bind(owner, intentId)
    .first<{
      id: string;
      projectId: string;
      preparationId: string;
      projectRevision: number;
      walletRevision: number;
      createdAt: string;
      document: string;
    }>();
  return row ? { ...row, document: JSON.parse(row.document) } : null;
}
export async function GET(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return json({ error: 'Sign in to view approvals.' }, 401);
  const params = new URL(request.url).searchParams,
    projectId = params.get('projectId'),
    cursor = params.get('cursor'),
    intentId = params.get('intentId');
  if (
    !projectId ||
    !UUID.test(projectId) ||
    (cursor !== null && !UUID.test(cursor)) ||
    (intentId !== null && (!UUID.test(intentId) || cursor !== null))
  )
    return json(
      { error: 'Choose an imported project and approval cursor.' },
      400,
    );
  try {
    const db = getD1();
    if (
      !(await db
        .prepare(
          'SELECT id FROM imported_token_projects WHERE owner_id=? AND id=?',
        )
        .bind(user.userId, projectId)
        .first())
    )
      return json({ error: 'Project unavailable.' }, 404);
    const anchor = cursor
      ? await db
          .prepare(
            'SELECT i.id,i.created_at AS createdAt FROM imported_swap_signing_intents i JOIN imported_swap_preparations s ON s.owner_id=i.owner_id AND s.id=i.preparation_id WHERE i.owner_id=? AND s.project_id=? AND i.id=?',
          )
          .bind(user.userId, projectId, cursor)
          .first<{ id: string; createdAt: string }>()
      : null;
    if (cursor && !anchor)
      return json({ error: 'Approval cursor unavailable.' }, 400);
    const rows = await db
      .prepare(
        `SELECT ${columns},s.project_id AS projectId,s.project_revision AS projectRevision,s.wallet_revision AS walletRevision,json_extract(s.document,'$.side') AS side FROM imported_swap_signing_intents i JOIN imported_swap_preparations s ON s.owner_id=i.owner_id AND s.id=i.preparation_id WHERE i.owner_id=? AND s.project_id=? AND (? IS NULL OR i.id=?) AND (? IS NULL OR i.created_at<? OR (i.created_at=? AND i.id<?)) ORDER BY i.created_at DESC,i.id DESC LIMIT 51`,
      )
      .bind(
        user.userId,
        projectId,
        intentId,
        intentId,
        anchor?.createdAt ?? null,
        anchor?.createdAt ?? '',
        anchor?.createdAt ?? '',
        anchor?.id ?? '',
      )
      .all<
        StoredIntent & {
          projectId: string;
          projectRevision: number;
          walletRevision: number;
          side: string;
        }
      >();
    if (intentId && rows.results.length !== 1)
      return json({ error: 'Owned project approval unavailable.' }, 404);
    const intents = rows.results.slice(0, 50).map((row) => {
      const document = JSON.parse(row.document) as WarmupSigningReview;
      if (
        document.id !== row.id ||
        document.wallet !== row.wallet ||
        document.preparationId !== row.preparationId ||
        document.network !== 'mainnet'
      )
        throw new Error();
      if (document.acquisition) {
        if (row.side !== 'Sell') throw new Error();
        validatedImportedAcquisitionSelection(document.acquisition, {
          projectId: row.projectId,
          wallet: row.wallet,
          mint: document.inputMint,
          unitsRaw: document.inputRaw,
        });
      }
      if (document.session)
        validatedTradeSessionCapture(document.session, document.inputRaw);
      if (document.conditional) {
        requireConditionalSwapContext(document.conditional, {
          side: row.side,
          inputMint: document.inputMint,
          outputMint: document.outputMint,
          inputRaw: document.inputRaw,
        });
        validatedConditionalSigning(document.conditional, document.inputRaw);
      }
      const failureReceipt = row.failureReceipt
        ? validatedSwapFailure(
            JSON.parse(row.failureReceipt),
            document,
            row.signature!,
          )
        : null;
      if (failureReceipt && row.state !== 'failed') throw new Error();
      return { ...row, document, failureReceipt };
    });
    return json({
      projectId,
      intents,
      nextCursor: rows.results.length > 50 ? intents.at(-1)!.id : null,
    });
  } catch {
    return json({ error: 'Approval history unavailable.' }, 503);
  }
}
export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user)
    return json({ error: 'Sign in to approve this transaction.' }, 401);
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
      !['review', 'register', 'submit', 'recover', 'cancel'].includes(
        body.action,
      ) ||
      (body.action === 'review'
        ? !body.preparationId || !UUID.test(body.preparationId)
        : !body.id || !UUID.test(body.id))
    )
      throw new Error();
  } catch {
    return json({ error: 'Invalid approval request.' }, 400);
  }
  try {
    const db = getD1(),
      signal = AbortSignal.any([request.signal, AbortSignal.timeout(25000)]),
      now = new Date().toISOString();
    if (body.action === 'review') {
      const captured = await currentImportedPreparation(
        db,
        user.userId,
        body.preparationId!,
      );
      if (!captured || typeof body.transaction !== 'string')
        return json({ error: 'Current preparation unavailable.' }, 409);
      const saved = {
        ...captured,
        document: JSON.parse(captured.document),
      } as SavedSwapPreparation;
      await currentTradeSession(db, user.userId, saved);
      await currentConditionalSigning(db, user.userId, saved);
      const order = await restoreSavedSwapOrder(saved, body.transaction);
      const acquisition = saved.document.acquisition;
      if (acquisition)
        validatedImportedAcquisitionSelection(acquisition, {
          projectId: saved.projectId,
          wallet: order.preparation.wallet,
          mint: order.inputMint,
          unitsRaw: order.inAmount,
        });
      const acquisitionGuard = acquisition
        ? await currentImportedAcquisition(db, user.userId, acquisition)
        : undefined;
      const occupied = await db
        .prepare(
          'SELECT scope,intent_id AS intentId FROM solana_swap_reservations WHERE owner_id=? AND wallet_address=?',
        )
        .bind(user.userId, order.preparation.wallet)
        .first();
      if (occupied)
        return json(
          {
            error: 'Recover the existing wallet approval before a new review.',
            reservation: occupied,
          },
          409,
        );
      const gateNow = Date.now();
      const gate = await db
        .prepare(
          'INSERT INTO wallet_balance_gates(owner_id,next_allowed_at) VALUES (?,?) ON CONFLICT(owner_id) DO UPDATE SET next_allowed_at=excluded.next_allowed_at WHERE wallet_balance_gates.next_allowed_at<=?',
        )
        .bind(user.userId, gateNow + 15000, gateNow)
        .run();
      if (!gate.meta.changes) {
        const retained = await db
          .prepare(
            'SELECT next_allowed_at AS deadline FROM wallet_balance_gates WHERE owner_id=?',
          )
          .bind(user.userId)
          .first<{ deadline: number }>();
        return json(
          {
            error: 'Wait between wallet reads.',
            reviewWaitMs: Math.min(
              15000,
              Math.max(0, (retained?.deadline ?? gateNow + 15000) - Date.now()),
            ),
          },
          429,
        );
      }
      const simulation = await simulateImportedSwap(order, signal, fetch, true);
      requireConditionalBuyOutputPrecision(
        saved.document.conditional,
        simulation.tokenChanges,
      );
      const settlement = await requireWarmupSigningReview(order, simulation);
      const review: WarmupSigningReview = {
        id: crypto.randomUUID(),
        preparationId: saved.id,
        wallet: order.preparation.wallet,
        sha256: order.preparation.sha256,
        network: 'mainnet',
        expiresAt: saved.document.conditional
          ? new Date(
              Math.min(
                Date.parse(order.expiresAt),
                Date.parse(saved.document.conditional.expiresAt),
              ),
            ).toISOString()
          : order.expiresAt,
        maximumFeeLamports: simulation.networkFeeLamports,
        inputRaw: order.inAmount,
        minimumOutputRaw: order.minimumOutAmount,
        inputMint: order.inputMint,
        outputMint: order.outputMint,
        transaction: order.preparation.transaction,
        lastValidBlockHeight: order.preparation.lastValidBlockHeight,
        settlement,
        ...(order.platformFee ? { platformFee: order.platformFee } : {}),
        ...(acquisition ? { acquisition } : {}),
        ...(saved.document.session ? { session: saved.document.session } : {}),
        ...(saved.document.conditional
          ? { conditional: saved.document.conditional }
          : {}),
      };
      const conditionalGuard = await currentConditionalSigning(
        db,
        user.userId,
        saved,
      );
      const sessionGuard = await currentTradeSession(db, user.userId, saved);
      const write = await reserveImportedApproval(
        db,
        user.userId,
        captured,
        review,
        acquisitionGuard,
        conditionalGuard,
        sessionGuard,
      );
      return write.meta.changes
        ? json({ review })
        : json(
            {
              error:
                'Approval already exists, wallet is reserved or the project changed. Recover before retrying.',
            },
            409,
          );
    }
    const row = await db
      .prepare(
        `SELECT ${columns} FROM imported_swap_signing_intents i WHERE i.owner_id=? AND i.id=?`,
      )
      .bind(user.userId, body.id!)
      .first<StoredIntent>();
    if (!row) return json({ error: 'Approval unavailable.' }, 404);
    const review = JSON.parse(row.document) as WarmupSigningReview;
    if (
      review.id !== row.id ||
      review.preparationId !== row.preparationId ||
      review.wallet !== row.wallet ||
      review.network !== 'mainnet'
    )
      throw new Error();
    if (review.session)
      validatedTradeSessionCapture(review.session, review.inputRaw);
    if (review.conditional)
      validatedConditionalSigning(review.conditional, review.inputRaw);
    if (body.action === 'cancel') {
      const write = await db
        .prepare(
          "UPDATE imported_swap_signing_intents SET state='cancelled',updated_at=? WHERE owner_id=? AND id=? AND state='awaiting_signature' AND signature IS NULL AND NOT EXISTS(SELECT 1 FROM jito_bundle_packets bp WHERE bp.owner_id=imported_swap_signing_intents.owner_id AND bp.intent_id=imported_swap_signing_intents.id)",
        )
        .bind(now, user.userId, row.id)
        .run();
      return write.meta.changes
        ? json({ state: 'cancelled' })
        : json({ error: 'Signed transactions require receipt recovery.' }, 409);
    }
    const endpoint = getSolanaRpcEndpoint('mainnet'),
      rpc = (method: string, params: unknown[]) =>
        balanceRpc(endpoint, method, params, signal, fetch);
    if (body.action === 'recover') {
      if (
        !row.signature ||
        !['signed', 'submitted', 'failed', 'finalized'].includes(row.state)
      )
        return json({ error: 'No registered signature to recover.' }, 409);
      if (
        row.state === 'finalized' ||
        (row.state === 'failed' && row.failureReceipt)
      ) {
        const receipt =
          row.state === 'finalized'
            ? await readReceipt(db, user.userId, row.id)
            : null;
        if (row.state === 'finalized' && !receipt) throw new Error();
        return json({
          state: row.state,
          signature: row.signature,
          ...(receipt ? { receipt } : {}),
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
      }
      if ((await rpc('getGenesisHash', [])) !== SOLANA_MAINNET_GENESIS)
        throw new Error();
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
      if (
        verifyExactSwapSignature(review, raw.transaction[0]) !== row.signature
      )
        throw new Error();
      if (row.state === 'failed' && raw.meta.err === null)
        throw new Error('Retained failed outcome differs.');
      if (raw.meta.err !== null) {
        const failureReceipt = await decodeSwapFailure(
          raw,
          review,
          row.signature,
        );
        const transitionAt = new Date().toISOString();
        await db
          .prepare(
            "UPDATE imported_swap_signing_intents SET state='failed',failure_receipt=?,updated_at=? WHERE owner_id=? AND id=? AND signature=? AND (state IN ('signed','submitted') OR (state='failed' AND failure_receipt IS NULL))",
          )
          .bind(
            JSON.stringify(failureReceipt),
            transitionAt,
            user.userId,
            row.id,
            row.signature,
          )
          .run();
        const retained = await db
          .prepare(
            'SELECT state,failure_receipt AS failureReceipt FROM imported_swap_signing_intents WHERE owner_id=? AND id=? AND signature=?',
          )
          .bind(user.userId, row.id, row.signature)
          .first<{ state: string; failureReceipt: string | null }>();
        if (retained?.state !== 'failed' || !retained.failureReceipt)
          throw new Error('Retained failure unavailable.');
        return json({
          failureReceipt: validatedSwapFailure(
            JSON.parse(retained.failureReceipt),
            review,
            row.signature,
          ),
          state: 'failed',
          signature: row.signature,
        });
      }
      const saved = await db
        .prepare(
          'SELECT id,project_id AS projectId,project_revision AS projectRevision,wallet_revision AS walletRevision,created_at AS createdAt,document FROM imported_swap_preparations WHERE owner_id=? AND id=?',
        )
        .bind(user.userId, row.preparationId)
        .first<Omit<SavedSwapPreparation, 'document'> & { document: string }>();
      if (!saved) throw new Error();
      const document = JSON.parse(
        saved.document,
      ) as SavedSwapPreparation['document'];
      const { acquiredRaw, ...evidence } = await decodeWarmupReceipt(
        raw,
        { document },
        row.signature,
        document.side,
        review,
      );
      requireConditionalBuyOutputPrecision(document.conditional, [evidence]);
      const transitionAt = new Date().toISOString();
      const receipt = {
        id: crypto.randomUUID(),
        projectId: saved.projectId,
        preparationId: saved.id,
        projectRevision: saved.projectRevision,
        walletRevision: saved.walletRevision,
        createdAt: transitionAt,
        document: {
          ...evidence,
          side: document.side,
          tokenUnitsRaw: acquiredRaw,
          ...(document.conditional?.format === 'conditional-preparation-v2'
            ? {
                quoteUnitsRaw: (-BigInt(
                  evidence.nativeSettlementRaw,
                )).toString(),
              }
            : {}),
          source: new URL(endpoint).hostname,
          observedAt: transitionAt,
          limitations:
            'Exact signed packet and finalized wallet token/native changes. Selected acquisitions are recorded separately as bookkeeping links. This does not reconstruct external transfers or prove profit.',
        },
      };
      const text = JSON.stringify(receipt.document);
      if (text.length > 16384) throw new Error();
      // Receipt insertion and approval finalization commit together, across archives.
      const writes = [
        db
          .prepare(
            `INSERT OR IGNORE INTO imported_swap_receipts VALUES(?,?,?,?,?,?,?,?,?,?)`,
          )
          .bind(
            receipt.id,
            user.userId,
            row.id,
            saved.id,
            saved.projectId,
            saved.projectRevision,
            saved.walletRevision,
            row.signature,
            text,
            transitionAt,
          ),
        db
          .prepare(
            "UPDATE imported_swap_signing_intents SET state='finalized',updated_at=? WHERE owner_id=? AND id=? AND signature=? AND state IN ('signed','submitted') AND EXISTS(SELECT 1 FROM imported_swap_receipts WHERE owner_id=? AND intent_id=? AND signature=?)",
          )
          .bind(
            transitionAt,
            user.userId,
            row.id,
            row.signature,
            user.userId,
            row.id,
            row.signature,
          ),
      ];
      if (review.acquisition) {
        if (
          JSON.stringify(document.acquisition) !==
          JSON.stringify(review.acquisition)
        )
          throw new Error('Approved acquisition changed.');
        await finalizeImportedAcquisition(
          db,
          user.userId,
          review.acquisition,
          receipt as ImportedTradeReceipt,
          writes[0],
          writes[1],
        );
      } else await db.batch(writes);
      return json({
        state: 'finalized',
        signature: row.signature,
        receipt: await readReceipt(db, user.userId, row.id),
      });
    }
    if (typeof body.transaction !== 'string')
      return json({ error: 'Signed packet required.' }, 400);
    let signature: string;
    try {
      signature = verifyExactSwapSignature(review, body.transaction);
    } catch {
      return json(
        { error: 'Signature or exact approved packet differs.' },
        400,
      );
    }
    if (body.action === 'register') {
      if (
        row.signature === signature &&
        ['signed', 'submitted', 'finalized'].includes(row.state)
      )
        return json({ signature, state: row.state });
      const write = await db
        .prepare(
          "UPDATE imported_swap_signing_intents SET state='signed',signature=?,updated_at=? WHERE owner_id=? AND id=? AND state='awaiting_signature' AND signature IS NULL AND NOT EXISTS(SELECT 1 FROM jito_bundle_packets bp WHERE bp.owner_id=imported_swap_signing_intents.owner_id AND bp.intent_id=imported_swap_signing_intents.id)",
        )
        .bind(signature, now, user.userId, row.id)
        .run();
      return write.meta.changes
        ? json({ state: 'signed', signature })
        : json({ error: 'Approval state changed.' }, 409);
    }
    if (
      row.state !== 'signed' ||
      row.signature !== signature ||
      Date.parse(review.expiresAt) <= Date.now()
    )
      return json(
        {
          error:
            'Register once before submission. Retain expired or submitted signatures for recovery.',
        },
        409,
      );
    const captured = await currentImportedPreparation(
      db,
      user.userId,
      row.preparationId,
    );
    if (!captured)
      return json(
        {
          error: 'Project or wallet changed. Keep the signature for recovery.',
        },
        409,
      );
    const order = await restoreSavedSwapOrder(
      { ...captured, document: JSON.parse(captured.document) },
      review.transaction,
    );
    if (review.acquisition)
      await currentImportedAcquisition(
        db,
        user.userId,
        review.acquisition,
        true,
      );
    await currentTradeSession(
      db,
      user.userId,
      { ...captured, document: JSON.parse(captured.document) },
      row.id,
    );
    await currentConditionalSigning(
      db,
      user.userId,
      { ...captured, document: JSON.parse(captured.document) },
      row.id,
    );
    const simulation = await simulateImportedSwap(order, signal, fetch, true);
    requireConditionalBuyOutputPrecision(
      review.conditional,
      simulation.tokenChanges,
    );
    const settlement = await requireWarmupSigningReview(order, simulation);
    if (
      JSON.stringify(settlement) !== JSON.stringify(review.settlement) ||
      simulation.networkFeeLamports !== review.maximumFeeLamports
    )
      return json(
        {
          error:
            'Approved rent, fees, settlement or lookup tables changed. Keep the signature for recovery.',
        },
        409,
      );
    if ((await rpc('getGenesisHash', [])) !== SOLANA_MAINNET_GENESIS)
      throw new Error();
    const after = await currentImportedPreparation(
      db,
      user.userId,
      row.preparationId,
    );
    if (
      !after ||
      after.document !== captured.document ||
      Date.parse(review.expiresAt) <= Date.now()
    )
      return json(
        {
          error: 'Context changed or expired. Keep the signature for recovery.',
        },
        409,
      );
    const conditionalGuard = await currentConditionalSigning(
      db,
      user.userId,
      { ...after, document: JSON.parse(after.document) },
      row.id,
    );
    const conditionWrite = conditionalSigningWriteGuard(
      user.userId,
      after.projectId,
      conditionalGuard,
    );
    const sessionGuard = await currentTradeSession(
      db,
      user.userId,
      { ...after, document: JSON.parse(after.document) },
      row.id,
    );
    const sessionWrite = tradeSessionWriteGuard(
      user.userId,
      sessionGuard,
      row.id,
    );
    // Mark before any send. An unknown response never enables a second submission.
    const armed = await db
      .prepare(
        `UPDATE imported_swap_signing_intents SET state='submitted',updated_at=? WHERE owner_id=? AND id=? AND state='signed' AND signature=? AND EXISTS(SELECT 1 FROM imported_swap_preparations s JOIN imported_token_projects p ON p.owner_id=s.owner_id AND p.id=s.project_id AND p.revision=s.project_revision JOIN workspace_wallets w ON w.owner_id=s.owner_id AND w.chain='Solana' AND w.address=s.wallet_address AND w.revision=s.wallet_revision WHERE s.owner_id=? AND s.id=? AND s.document=? AND p.chain='Solana' AND p.archived=0 AND w.archived=0 AND json_extract(s.document,'$.wallet')=s.wallet_address AND p.address=CASE json_extract(s.document,'$.side') WHEN 'Buy' THEN json_extract(s.document,'$.outputMint') WHEN 'Sell' THEN json_extract(s.document,'$.inputMint') END) AND EXISTS(SELECT 1 FROM solana_swap_reservations r WHERE r.owner_id=imported_swap_signing_intents.owner_id AND r.wallet_address=imported_swap_signing_intents.wallet_address AND r.scope='imported' AND r.intent_id=imported_swap_signing_intents.id AND r.state='signed') AND julianday(json_extract(document,'$.expiresAt'))>julianday('now') AND ?>?${conditionWrite.sql}${sessionWrite.sql}`,
      )
      .bind(
        now,
        user.userId,
        row.id,
        signature,
        user.userId,
        row.preparationId,
        captured.document,
        Date.parse(review.expiresAt),
        Date.now(),
        ...conditionWrite.bindings,
        ...sessionWrite.bindings,
      )
      .run();
    if (!armed.meta.changes)
      return json(
        { error: 'Submission already in progress or context changed.' },
        409,
      );
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
      return json({ state: 'submitted', signature });
    } catch {
      return json(
        {
          error:
            'Submission outcome unknown. Recover this registered signature; do not create a replacement.',
          state: 'submitted',
          signature,
        },
        502,
      );
    }
  } catch (error) {
    if (error instanceof ConditionalBuyStorageUnavailable)
      return json({ error: error.message }, 503);
    if (
      error instanceof Error &&
      /Wallet already reserved|Signature already registered|Conditional approval already exists/.test(
        error.message,
      )
    )
      return json(
        {
          error:
            'Wallet or signature is already reserved. Recover the existing approval first.',
        },
        409,
      );
    if (error instanceof Error && /trade session/i.test(error.message))
      return json(
        {
          error:
            'Trade session entry changed or already has an approval. Cancel an unsigned approval or recover its registered signature. No submission occurred.',
        },
        409,
      );
    if (
      error instanceof Error &&
      /conditional|Saved level condition|market condition|market observation/i.test(
        error.message,
      )
    )
      return json(
        {
          error:
            'Conditional level changed, expired or is not met. No submission occurred. Cancel an unsigned approval or retain a registered signature for recovery.',
        },
        409,
      );
    if (error instanceof Error && error.message.startsWith('DCA supply'))
      return json(
        {
          error:
            'The captured DCA supply or project changed. Review a new session using the current saved supply. No submission occurred; registered signatures remain recoverable.',
        },
        409,
      );
    if (error instanceof Error && error.message.startsWith('DCA market'))
      return json(
        {
          error:
            'DCA market cap is outside the saved range or its observation is unavailable. Refresh the market before reviewing again. No submission occurred; retain registered signatures for recovery.',
        },
        409,
      );
    if (error instanceof SwapBlockhashExpiredError)
      return json(
        {
          error:
            body.action === 'review'
              ? 'Prepared blockhash expired. Prepare a fresh order.'
              : 'Approved blockhash expired. Retain the registered signature for recovery.',
        },
        409,
      );
    return json(
      {
        error:
          'Approval checks unavailable. No automatic signature, replacement or submission.',
      },
      502,
    );
  }
}
