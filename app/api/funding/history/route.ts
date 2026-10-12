import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getD1 } from '@/db';
import {
  fundingReceipt,
  fundingPendingOperation,
} from '@/lib/funding-execution-history';
import type { WalletAuditEvent } from '@/lib/distribution-audit';
import { UUID, type WalletOperation } from '@/lib/wallet-operation';
export const dynamic = 'force-dynamic';
const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { 'cache-control': 'no-store' } });
export async function GET(request: Request) {
  const user = await getChatGPTUser();
  if (!user)
    return json(
      { error: 'Sign in to read saved funding execution history.' },
      401,
    );
  const params = new URL(request.url).searchParams;
  const id = params.get('id'),
    revision = params.get('revision');
  let cursorDate = '9999-12-31T23:59:59.999Z',
    cursorId = '~';
  try {
    if (
      !id ||
      !/^[a-zA-Z0-9-]{1,64}$/.test(id) ||
      !revision ||
      !/^[1-9]\d{0,9}$/.test(revision) ||
      Number(revision) > 1000000000
    )
      throw new Error();
    const cursor = params.get('cursor');
    if (cursor !== null) {
      const parts = cursor.split('~');
      if (
        parts.length !== 2 ||
        parts[0].length !== 24 ||
        new Date(parts[0]).toISOString() !== parts[0] ||
        !UUID.test(parts[1])
      )
        throw new Error();
      [cursorDate, cursorId] = parts;
    }
  } catch {
    return json(
      { error: 'Choose a saved funding revision and valid history cursor.' },
      400,
    );
  }
  try {
    const db = getD1();
    const read = () =>
      db
        .prepare(
          'SELECT revision,archived FROM funding_plans WHERE owner_id=? AND id=?',
        )
        .bind(user.userId, id)
        .first<{ revision: number; archived: number }>();
    const saved = await read();
    if (!saved) return json({ error: 'Saved funding draft not found.' }, 404);
    if (saved.revision !== Number(revision))
      return json({ error: 'Funding draft changed. Reload its history.' }, 409);
    const [events, operations] = await Promise.all([
      db
        .prepare(`SELECT id,wallet_address AS walletAddress,network,event_type AS eventType,
        transaction_signature AS transactionSignature,details,created_at AS createdAt FROM wallet_audit_events
        WHERE owner_id=? AND network='devnet' AND event_type IN ('native_transfer_finalized','native_transfer_failed','token_transfer_finalized','token_transfer_failed')
        AND json_extract(CASE WHEN json_valid(details) THEN details ELSE '{}' END,'$.fundingId')=?
        AND (created_at<? OR (created_at=? AND id<?)) ORDER BY created_at DESC,id DESC LIMIT 51`)
        .bind(user.userId, id, cursorDate, cursorDate, cursorId)
        .all<WalletAuditEvent>(),
      db
        .prepare(`SELECT id,wallet_address AS walletAddress,kind,document,state,signature,created_at AS createdAt,
        expires_at AS expiresAt,armed_at AS armedAt,minimum_slot AS minimumSlot,updated_at AS updatedAt FROM wallet_operations
        WHERE owner_id=? AND COALESCE(json_extract(CASE WHEN json_valid(document) THEN document ELSE '{}' END,'$.fundingId'),
        json_extract(CASE WHEN json_valid(document) THEN document ELSE '{}' END,'$.funding.id'))=?
        AND (state IN ('awaiting_signature','submitted') OR (state='preparing' AND expires_at>?))
        ORDER BY created_at DESC,id DESC LIMIT 51`)
        .bind(user.userId, id, new Date().toISOString())
        .all<WalletOperation>(),
    ]);
    const page = events.results.slice(0, 50),
      last = page.at(-1);
    const receipts = await Promise.all(
      page.map((event) => fundingReceipt(event, id!)),
    );
    const pending = await Promise.all(
      operations.results
        .slice(0, 50)
        .map((op) => fundingPendingOperation(op, id!)),
    );
    const current = await read();
    if (
      !current ||
      current.revision !== saved.revision ||
      current.archived !== saved.archived
    )
      return json(
        { error: 'Funding draft changed while reading history. Reload it.' },
        409,
      );
    return json({
      id,
      revision: saved.revision,
      archived: !!saved.archived,
      receipts,
      pending,
      pendingTruncated: operations.results.length > 50,
      nextCursor:
        events.results.length > 50 && last
          ? `${last.createdAt}~${last.id}`
          : null,
    });
  } catch {
    return json(
      {
        error:
          'Funding execution history is unavailable or its retained evidence is inconsistent.',
      },
      503,
    );
  }
}
