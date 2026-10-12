import { chainQuoteAssets } from '@/lib/quote-catalog';
import { ensurePulseSchema } from '@/db';
import { getChatGPTUser } from '@/app/chatgpt-auth';
import { assertSolanaAddress } from '@/lib/wallet-verification';
import { walletRequest } from '@/lib/wallet-request';
import {
  UUID,
  operationDocument,
  type WalletOperationDocument,
} from '@/lib/wallet-operation';
import { resolveWalletOperation } from '@/lib/wallet-operation-store';
import {
  distributionAuditKey,
  validateDistributionClaim,
  type DistributionClaim,
  type WalletAuditEvent,
} from '@/lib/distribution-audit';
import {
  assertTransactionSignature,
  readFinalizedDevnetTransaction,
  ReceiptError,
  verifyMemoReceipt,
  verifyNativeFundingReceipt,
  verifyTokenReceipt,
} from '@/lib/solana-transfer-receipt';

export const dynamic = 'force-dynamic';

const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { 'cache-control': 'no-store' } });

export async function GET(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return json({ error: 'Sign in to read wallet activity.' }, 401);
  const params = new URL(request.url).searchParams;
  let wallet: string | null,
    cursorDate = '9999-12-31T23:59:59.999Z',
    cursorId = '~';
  const distributionKey = params.get('distributionKey'),
    fundingId = params.get('fundingId');
  try {
    wallet = params.has('address')
      ? assertSolanaAddress(params.get('address'))
      : null;
    if (
      fundingId !== null &&
      (!wallet || !/^[a-zA-Z0-9-]{1,64}$/.test(fundingId))
    )
      throw new Error('Invalid funding filter.');
    if (
      distributionKey !== null &&
      (!wallet || !/^[a-f0-9]{64}$/.test(distributionKey))
    )
      throw new Error('Invalid distribution filter.');
    const cursor = params.get('cursor');
    if (cursor !== null) {
      const parts = cursor.split('~');
      if (
        parts.length !== 2 ||
        parts[0].length !== 24 ||
        new Date(parts[0]).toISOString() !== parts[0] ||
        !/^[a-f0-9-]{36}$/.test(parts[1])
      )
        throw new Error('Invalid wallet activity cursor.');
      [cursorDate, cursorId] = parts;
    }
  } catch {
    return json({ error: 'Invalid wallet activity filter or cursor.' }, 400);
  }
  try {
    const db = await ensurePulseSchema();
    const rows = await db
      .prepare(`SELECT id, wallet_address AS walletAddress, network,
      event_type AS eventType, transaction_signature AS transactionSignature,
      details, created_at AS createdAt FROM wallet_audit_events
      WHERE owner_id=? AND (? IS NULL OR wallet_address=?)
      AND (? IS NULL OR (json_valid(details) AND json_extract(CASE WHEN json_valid(details) THEN details ELSE '{}' END,'$.distributionKey')=?))
      AND (? IS NULL OR (json_valid(details) AND json_extract(CASE WHEN json_valid(details) THEN details ELSE '{}' END,'$.fundingId')=?))
      AND (created_at<? OR (created_at=? AND id<?)) ORDER BY created_at DESC,id DESC LIMIT 51`)
      .bind(
        user.userId,
        wallet,
        wallet,
        distributionKey,
        distributionKey,
        fundingId,
        fundingId,
        cursorDate,
        cursorDate,
        cursorId,
      )
      .all<WalletAuditEvent>();
    const events = rows.results.slice(0, 50),
      last = events.at(-1);
    return json({
      events,
      nextCursor:
        rows.results.length > 50 && last
          ? `${last.createdAt}~${last.id}`
          : null,
    });
  } catch {
    return json({ error: 'Wallet activity temporarily unavailable.' }, 503);
  }
}

export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return json({ error: 'Sign in to record a wallet receipt.' }, 401);
  let operationId: string | null = null;
  let savedFunding = false;
  let tokenFunding = false;
  let tokenIntent: Extract<WalletOperationDocument, { kind: 'spl' }> | null =
    null;
  let nativeFunding = false,
    nativeIntent: Extract<WalletOperationDocument, { kind: 'sol' }> | null =
      null;
  let walletAddress: string,
    signature: string,
    claim: DistributionClaim | null = null,
    recipient: string | null = null,
    distributionKey: string | null = null;
  try {
    const body = await walletRequest(request, 262144);
    if (body.operationId !== undefined) {
      if (typeof body.operationId !== 'string' || !UUID.test(body.operationId))
        throw new Error();
      operationId = body.operationId;
    }
    walletAddress = assertSolanaAddress(body.address);
    signature = assertTransactionSignature(body.signature);
    if (body.savedFunding !== undefined) {
      if (
        body.savedFunding !== true ||
        !operationId ||
        body.distribution !== undefined ||
        body.nativeFunding !== undefined ||
        body.tokenFunding !== undefined
      )
        throw new Error();
      savedFunding = true;
    }
    if (body.tokenFunding !== undefined) {
      if (
        body.tokenFunding !== true ||
        !operationId ||
        body.distribution !== undefined ||
        body.nativeFunding !== undefined
      )
        throw new Error();
      tokenFunding = true;
    }
    if (body.nativeFunding !== undefined) {
      if (
        body.nativeFunding !== true ||
        !operationId ||
        body.distribution !== undefined
      )
        throw new Error();
      nativeFunding = true;
    }
    if (body.distribution !== undefined) {
      claim = validateDistributionClaim(body.distribution);
      recipient = assertSolanaAddress(body.recipient);
      if (
        claim.wallet !== walletAddress ||
        !claim.recipients.some((row) => row.address === recipient)
      )
        throw new Error(
          'Distribution does not match the reviewed wallet or recipient.',
        );
      distributionKey = await distributionAuditKey(claim);
    }
  } catch {
    return json({ error: 'Invalid wallet receipt request.' }, 400);
  }
  let phase = 'storage';
  try {
    const db = await ensurePulseSchema();
    if (nativeFunding || tokenFunding || savedFunding) {
      const saved = await db
        .prepare(
          'SELECT document FROM wallet_operations WHERE owner_id=? AND id=?',
        )
        .bind(user.userId, operationId)
        .first<{ document: string }>();
      if (!saved)
        return json(
          { error: 'Owned native funding operation not found.' },
          404,
        );
      const intent = await operationDocument(JSON.parse(saved.document));
      if (
        intent.wallet !== walletAddress ||
        (savedFunding
          ? !(
              intent.kind === 'sol' ||
              (intent.kind === 'spl' && intent.funding)
            )
          : nativeFunding
            ? intent.kind !== 'sol'
            : intent.kind !== 'spl' || !intent.funding)
      )
        return json(
          { error: 'Saved funding operation does not match this wallet.' },
          409,
        );
      if (intent.kind === 'sol') nativeIntent = intent;
      else if (intent.kind === 'spl') {
        tokenIntent = intent;
        claim = intent.distribution;
        recipient = intent.recipient;
        distributionKey = intent.distributionKey;
      }
    }
    if (operationId && !nativeFunding && !tokenFunding && !savedFunding) {
      const retained = await db
        .prepare(
          'SELECT document FROM wallet_operations WHERE owner_id=? AND id=?',
        )
        .bind(user.userId, operationId)
        .first<{ document: string }>();
      if (retained) {
        const intent = await operationDocument(JSON.parse(retained.document));
        if (intent.kind === 'sol' || (intent.kind === 'spl' && intent.funding))
          return json(
            {
              error:
                'Use saved-funding receipt verification for this retained operation.',
            },
            409,
          );
      }
    }
    const eventType = nativeIntent
      ? 'native_transfer_finalized'
      : claim
        ? 'token_transfer_finalized'
        : 'memo_finalized';
    const failedType = nativeIntent
      ? 'native_transfer_failed'
      : claim
        ? 'token_transfer_failed'
        : 'memo_failed';
    const read = () =>
      db
        .prepare(
          `SELECT id,wallet_address AS walletAddress,network,event_type AS eventType,transaction_signature AS transactionSignature,details,created_at AS createdAt FROM wallet_audit_events WHERE owner_id=? AND transaction_signature=?`,
        )
        .bind(user.userId, signature)
        .first<WalletAuditEvent>();
    const matches = (event: WalletAuditEvent) =>
      event.walletAddress === walletAddress &&
      [eventType, failedType].includes(event.eventType) &&
      (!nativeIntent ||
        JSON.parse(event.details).fundingKey === nativeIntent.fundingKey) &&
      (!tokenIntent ||
        JSON.parse(event.details).fundingKey === tokenIntent.funding!.key) &&
      (!claim ||
        (JSON.parse(event.details).distributionKey === distributionKey &&
          JSON.parse(event.details).recipient === recipient));
    const respond = async (event: WalletAuditEvent) => {
      if (!matches(event))
        return json(
          {
            error: 'This signature is already recorded for another operation.',
          },
          409,
        );
      if (
        operationId &&
        !(await resolveWalletOperation(db, user.userId, operationId, event))
      )
        return json(
          {
            error:
              'Receipt is saved, but it does not resolve this pending operation.',
          },
          409,
        );
      return json({
        recorded: true,
        outcome: event.eventType === failedType ? 'failed' : 'finalized',
        event,
      });
    };
    const previous = await read();
    if (previous) return respond(previous);
    const now = Date.now(),
      freshness = new Date(now - 5 * 60_000).toISOString();
    const proof = await db
      .prepare(
        `SELECT id FROM wallet_audit_events WHERE owner_id=? AND wallet_address=? AND event_type='ownership_verified' AND created_at>? LIMIT 1`,
      )
      .bind(user.userId, walletAddress, freshness)
      .first();
    if (!proof)
      return json(
        {
          error:
            'Verify this wallet for your account before recording a receipt.',
        },
        403,
      );
    const admitted = await db
      .prepare(
        `INSERT INTO wallet_receipt_gates(owner_id,claimed_at) VALUES (?,?) ON CONFLICT(owner_id) DO UPDATE SET claimed_at=excluded.claimed_at WHERE wallet_receipt_gates.claimed_at<=?`,
      )
      .bind(user.userId, now, now - 1000)
      .run();
    if (!admitted.meta.changes)
      return json(
        { error: 'Wait a moment before verifying another receipt.' },
        429,
      );
    phase = 'rpc';
    const transaction = await readFinalizedDevnetTransaction(signature);
    // Outcome comes only from finalized RPC metadata, never the request or SDK error.
    const failed =
      (transaction as { meta?: { err?: unknown } })?.meta?.err !== null;
    const details = nativeIntent
      ? verifyNativeFundingReceipt(transaction, signature, nativeIntent, failed)
      : claim && recipient
        ? await verifyTokenReceipt(
            transaction,
            signature,
            claim,
            recipient,
            failed,
          )
        : verifyMemoReceipt(transaction, signature, walletAddress, failed);
    if (
      tokenIntent?.funding &&
      ('decimals' in details ? details.decimals : null) !==
        chainQuoteAssets('Solana').find(
          (asset) => asset.address === tokenIntent!.distribution.mint,
        )?.decimals
    )
      throw new ReceiptError(
        'Finalized token decimals differ from the saved funding asset.',
      );
    if (tokenIntent?.funding)
      Object.assign(details, {
        fundingId: tokenIntent.funding.id,
        fundingRevision: tokenIntent.funding.revision,
        fundingKey: tokenIntent.funding.key,
      });
    phase = 'storage';
    const createdAt = new Date().toISOString();
    await db
      .prepare(`INSERT OR IGNORE INTO wallet_audit_events
      (id,owner_id,wallet_address,network,event_type,transaction_signature,details,created_at)
      SELECT ?,?,?,'devnet',?,?,?,? WHERE (SELECT COUNT(*) FROM wallet_audit_events WHERE owner_id=?)<10000
      AND EXISTS(SELECT 1 FROM wallet_audit_events WHERE owner_id=? AND wallet_address=? AND event_type='ownership_verified' AND created_at>?)`)
      .bind(
        crypto.randomUUID(),
        user.userId,
        walletAddress,
        failed ? failedType : eventType,
        signature,
        JSON.stringify(details),
        createdAt,
        user.userId,
        user.userId,
        walletAddress,
        new Date(Date.now() - 5 * 60_000).toISOString(),
      )
      .run();
    const event = await read();
    if (!event)
      return json(
        {
          error:
            'Receipt was verified but storage or wallet eligibility changed. Retry after verifying ownership.',
        },
        409,
      );
    return respond(event);
  } catch (error) {
    if (error instanceof ReceiptError)
      return json({ error: error.message }, error.status);
    return json(
      {
        error:
          phase === 'rpc'
            ? 'Receipt provider unavailable or evidence unsupported. No receipt was recorded.'
            : 'Receipt storage temporarily unavailable.',
      },
      phase === 'rpc' ? 502 : 503,
    );
  }
}
