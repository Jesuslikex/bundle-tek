import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getD1 } from '@/db';
import { savedFundingIntent, fundingLink } from '@/lib/devnet-saved-funding';
import { walletRequest } from '@/lib/wallet-request';
import { assertSolanaAddress } from '@/lib/wallet-verification';
import {
  assertTransactionSignature,
  readDevnetOperationSlot,
} from '@/lib/solana-transfer-receipt';
import {
  operationDocument,
  operationClaimHash,
  UUID,
  type WalletOperation,
} from '@/lib/wallet-operation';
export const dynamic = 'force-dynamic';
const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { 'cache-control': 'no-store' } });
const select = `SELECT id,wallet_address AS walletAddress,kind,document,state,signature,created_at AS createdAt,expires_at AS expiresAt,armed_at AS armedAt,minimum_slot AS minimumSlot,updated_at AS updatedAt FROM wallet_operations`;
export async function GET(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return json({ error: 'Sign in to read wallet operations.' }, 401);
  let wallet: string;
  try {
    wallet = assertSolanaAddress(
      new URL(request.url).searchParams.get('address'),
    );
  } catch {
    return json({ error: 'Choose a valid wallet.' }, 400);
  }
  try {
    const rows = await getD1()
      .prepare(
        `${select} WHERE owner_id=? AND wallet_address=? ORDER BY created_at DESC,id DESC LIMIT 50`,
      )
      .bind(user.userId, wallet)
      .all<WalletOperation>();
    const active = await getD1()
      .prepare(
        `${select} WHERE owner_id=? AND wallet_address=? AND (state IN ('awaiting_signature','submitted') OR (state='preparing' AND expires_at>?)) LIMIT 1`,
      )
      .bind(user.userId, wallet, new Date().toISOString())
      .first<WalletOperation>();
    return json({ operations: rows.results, active });
  } catch {
    return json({ error: 'Wallet operations temporarily unavailable.' }, 503);
  }
}
export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user)
    return json({ error: 'Sign in to prepare wallet operations.' }, 401);
  let body: Record<string, unknown>,
    id: string,
    claimHash: string,
    document: Awaited<ReturnType<typeof operationDocument>> | null = null,
    signature: string | null = null;
  try {
    body = await walletRequest(request, 262144);
    if (
      typeof body.id !== 'string' ||
      !UUID.test(body.id) ||
      typeof body.claim !== 'string' ||
      !UUID.test(body.claim)
    )
      throw new Error();
    id = body.id;
    claimHash = await operationClaimHash(body.claim);
    if (body.action === 'reserve')
      document = await operationDocument(body.document);
    else if (body.action === 'submitted')
      signature = assertTransactionSignature(body.signature);
    else if (
      body.action !== 'arm' &&
      body.action !== 'cancel' &&
      body.action !== 'rejected'
    )
      throw new Error();
  } catch {
    return json({ error: 'Invalid wallet operation request.' }, 400);
  }
  let phase = 'storage';
  try {
    const db = getD1(),
      now = new Date().toISOString(),
      freshness = new Date(Date.now() - 300000).toISOString();
    const read = () =>
      db
        .prepare(`${select} WHERE owner_id=? AND id=?`)
        .bind(user.userId, id)
        .first<WalletOperation>();
    const previous = await read();
    if (previous) {
      const credential = await db
        .prepare(
          'SELECT claim_hash FROM wallet_operations WHERE owner_id=? AND id=?',
        )
        .bind(user.userId, id)
        .first<{ claim_hash: string }>();
      if (credential?.claim_hash !== claimHash)
        return json(
          { error: 'This operation belongs to another approval session.' },
          403,
        );
    }
    if (document) {
      if (previous)
        return previous.document === JSON.stringify(document)
          ? json({ operation: previous })
          : json({ error: 'Operation id already has another intent.' }, 409);
      const link = fundingLink(document);
      if (link) {
        const saved = await db
          .prepare(
            'SELECT document,revision,archived FROM funding_plans WHERE owner_id=? AND id=?',
          )
          .bind(user.userId, link.id)
          .first<{ document: string; revision: number; archived: number }>();
        if (!saved || saved.archived || saved.revision !== link.revision)
          return json(
            {
              error:
                'Save and reload the current active funding draft before preparing.',
            },
            409,
          );
        let expected;
        try {
          expected = await savedFundingIntent(
            JSON.parse(saved.document),
            link.id,
            link.revision,
            document.kind === 'memo' ? '' : document.recipient,
          );
        } catch {
          return json(
            {
              error:
                'Saved funding draft is not eligible for immediate devnet execution.',
            },
            409,
          );
        }
        if (JSON.stringify(expected) !== JSON.stringify(document))
          return json(
            {
              error:
                'Only the exact saved funder, mint, amount and recipient can be approved.',
            },
            409,
          );
      }
      await db
        .prepare(
          "UPDATE wallet_operations SET state='cancelled',updated_at=? WHERE owner_id=? AND wallet_address=? AND state='preparing' AND expires_at<=?",
        )
        .bind(now, user.userId, document.wallet, now)
        .run();
      try {
        const result = await db
          .prepare(`INSERT INTO wallet_operations(owner_id,id,wallet_address,kind,document,claim_hash,created_at,expires_at,updated_at)
        SELECT ?,?,?,?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM wallet_operations WHERE owner_id=?)<1000
        AND EXISTS(SELECT 1 FROM wallet_audit_events WHERE owner_id=? AND wallet_address=? AND event_type='ownership_verified' AND created_at>?)
        AND (?='memo' OR NOT EXISTS(SELECT 1 FROM wallet_audit_events WHERE owner_id=? AND wallet_address=? AND event_type='token_transfer_finalized'
          AND json_extract(CASE WHEN json_valid(details) THEN details ELSE '{}' END,'$.distributionKey')=?
          AND json_extract(CASE WHEN json_valid(details) THEN details ELSE '{}' END,'$.recipient')=?))
        AND (? IS NULL OR (EXISTS(SELECT 1 FROM funding_plans WHERE owner_id=? AND id=? AND revision=? AND archived=0)
          AND NOT EXISTS(SELECT 1 FROM wallet_audit_events WHERE owner_id=? AND wallet_address=? AND event_type IN ('native_transfer_finalized','token_transfer_finalized')
            AND json_extract(CASE WHEN json_valid(details) THEN details ELSE '{}' END,'$.fundingKey')=?)))`)
          .bind(
            user.userId,
            id,
            document.wallet,
            document.kind,
            JSON.stringify(document),
            claimHash,
            now,
            new Date(Date.now() + 60000).toISOString(),
            now,
            user.userId,
            user.userId,
            document.wallet,
            freshness,
            document.kind,
            user.userId,
            document.wallet,
            document.kind === 'spl' ? document.distributionKey : null,
            document.kind === 'spl' ? document.recipient : null,
            link?.id ?? null,
            user.userId,
            link?.id ?? null,
            link?.revision ?? null,
            user.userId,
            document.wallet,
            link?.key ?? null,
          )
          .run();
        if (!result.meta.changes)
          return json(
            {
              error:
                'Wallet ownership, prior receipts or storage eligibility changed. Reload history before continuing.',
            },
            403,
          );
      } catch (error) {
        const active = await db
          .prepare(
            "SELECT id FROM wallet_operations WHERE owner_id=? AND wallet_address=? AND state IN ('preparing','awaiting_signature','submitted')",
          )
          .bind(user.userId, document.wallet)
          .first();
        if (active)
          return json(
            {
              error:
                'This wallet has an unresolved operation. Refresh its pending operation before approving another.',
            },
            409,
          );
        throw error;
      }
    } else {
      if (!previous) return json({ error: 'Wallet operation not found.' }, 404);
      if (body.action === 'arm') {
        if (previous.state !== 'preparing')
          return json(
            {
              error:
                'This approval reservation was already used. Inspect the existing operation.',
            },
            409,
          );
        phase = 'rpc';
        const minimumSlot = await readDevnetOperationSlot();
        phase = 'storage';
        const armedAt = new Date().toISOString(),
          proofFreshness = new Date(Date.now() - 300000).toISOString();
        const result = await db
          .prepare(`UPDATE wallet_operations SET state='awaiting_signature',armed_at=?,minimum_slot=?,updated_at=? WHERE owner_id=? AND id=? AND claim_hash=? AND state='preparing' AND expires_at>?
        AND EXISTS(SELECT 1 FROM wallet_audit_events WHERE owner_id=? AND wallet_address=? AND event_type='ownership_verified' AND created_at>?)
        AND ((kind<>'sol' AND json_extract(wallet_operations.document,'$.funding.id') IS NULL) OR EXISTS(SELECT 1 FROM funding_plans f WHERE f.owner_id=wallet_operations.owner_id
          AND f.id=COALESCE(json_extract(wallet_operations.document,'$.fundingId'),json_extract(wallet_operations.document,'$.funding.id')) AND f.revision=COALESCE(json_extract(wallet_operations.document,'$.fundingRevision'),json_extract(wallet_operations.document,'$.funding.revision')) AND f.archived=0))`)
          .bind(
            armedAt,
            minimumSlot,
            armedAt,
            user.userId,
            id,
            claimHash,
            armedAt,
            user.userId,
            previous.walletAddress,
            proofFreshness,
          )
          .run();
        if (!result.meta.changes)
          return json(
            {
              error: 'Reservation or wallet ownership expired. Prepare again.',
            },
            409,
          );
      } else if (body.action === 'rejected') {
        // A signing-only client reports an explicit rejection. This is not chain evidence.
        // The session claim is required and a known signed identity always wins.
        if (previous.state === 'cancelled' && !previous.signature)
          return json({ operation: previous });
        const result = await db
          .prepare(
            "UPDATE wallet_operations SET state='cancelled',updated_at=? WHERE owner_id=? AND id=? AND claim_hash=? AND state='awaiting_signature' AND signature IS NULL",
          )
          .bind(now, user.userId, id, claimHash)
          .run();
        if (!result.meta.changes)
          return json(
            {
              error:
                'Only an unsigned rejected approval can be released. Refresh the existing operation.',
            },
            409,
          );
      } else if (body.action === 'cancel') {
        if (previous.state === 'cancelled')
          return json({ operation: previous });
        const result = await db
          .prepare(
            "UPDATE wallet_operations SET state='cancelled',updated_at=? WHERE owner_id=? AND id=? AND claim_hash=? AND state='preparing'",
          )
          .bind(now, user.userId, id, claimHash)
          .run();
        if (!result.meta.changes)
          return json(
            {
              error:
                'Approval began. A matching verified receipt is required to resolve this operation.',
            },
            409,
          );
      } else {
        if (previous.signature)
          return previous.signature === signature
            ? json({ operation: previous })
            : json({ error: 'Operation already has another signature.' }, 409);
        const result = await db
          .prepare(
            "UPDATE wallet_operations SET state='submitted',signature=?,updated_at=? WHERE owner_id=? AND id=? AND claim_hash=? AND state='awaiting_signature'",
          )
          .bind(signature, now, user.userId, id, claimHash)
          .run();
        if (!result.meta.changes)
          return json({ error: 'Operation is not awaiting a signature.' }, 409);
      }
    }
    return json({ operation: await read() });
  } catch {
    return json(
      {
        error:
          phase === 'rpc'
            ? 'Devnet preparation provider unavailable. No approval was started.'
            : 'Wallet operation storage temporarily unavailable.',
      },
      phase === 'rpc' ? 502 : 503,
    );
  }
}
