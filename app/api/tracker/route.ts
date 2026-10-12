import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getD1 } from '@/db';
import {
  MAX_TRACKED_WALLETS,
  validateWalletBatch,
  validateTrackedWallet,
} from '@/lib/tracked-wallet';

export const dynamic = 'force-dynamic';
const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } });

export async function GET() {
  const user = await getChatGPTUser();
  if (!user) return json({ error: 'Sign in to open your tracker.' }, 401);
  try {
    const result = await getD1()
      .prepare(`SELECT address, network, label, group_name AS "group", icon, favorite, archived, updated_at AS updatedAt
      FROM tracked_wallets WHERE owner_id = ? ORDER BY updated_at DESC LIMIT 100`)
      .bind(user.userId)
      .all();
    return json({
      wallets: result.results.map((row) => ({
        ...row,
        archived: Boolean(row.archived),
        favorite: Boolean(row.favorite),
      })),
    });
  } catch {
    return json({ error: 'Tracker storage temporarily unavailable.' }, 503);
  }
}

export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return json({ error: 'Sign in to save tracked wallets.' }, 401);
  if (
    !request.headers
      .get('content-type')
      ?.toLowerCase()
      .startsWith('application/json')
  )
    return json({ error: 'JSON required.' }, 415);
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin)
    return json({ error: 'Cross-origin write rejected.' }, 403);
  let storageStarted = false;
  try {
    const text = await request.text();
    if (text.length > 20_000)
      return json({ error: 'Batch is too large.' }, 413);
    const body = JSON.parse(text);
    const updatedAt = new Date().toISOString();
    if (body.action === 'add') {
      const wallets = validateWalletBatch(body.wallets);
      storageStarted = true;
      // One statement admits the entire batch or none of it. Existing addresses
      // are skipped; archived entries must be restored explicitly.
      const documents = JSON.stringify(wallets);
      const result = await getD1()
        .prepare(`WITH incoming AS (
        SELECT json_extract(value, '$.address') AS address, json_extract(value, '$.network') AS network,
          json_extract(value, '$.label') AS label, json_extract(value, '$.group') AS group_name,
          json_extract(value, '$.icon') AS icon, json_extract(value, '$.favorite') AS favorite FROM json_each(?)
      ), fresh AS (
        SELECT * FROM incoming WHERE NOT EXISTS (SELECT 1 FROM tracked_wallets w
          WHERE w.owner_id = ? AND w.address = incoming.address AND w.network = incoming.network)
      ) INSERT INTO tracked_wallets (owner_id, address, network, label, group_name, icon, favorite, archived, updated_at)
      SELECT ?, address, network, label, group_name, icon, favorite, 0, ? FROM fresh
      WHERE (SELECT COUNT(*) FROM tracked_wallets WHERE owner_id = ?) + (SELECT COUNT(*) FROM fresh) <= ?`)
        .bind(
          documents,
          user.userId,
          user.userId,
          updatedAt,
          user.userId,
          MAX_TRACKED_WALLETS,
        )
        .run();
      if (!result.meta.changes)
        return json(
          {
            error:
              'Addresses already saved or the 100-wallet limit would be exceeded. Check active and archived wallets.',
          },
          409,
        );
      return json({ added: result.meta.changes });
    }
    if (!['edit', 'archive', 'restore'].includes(body.action))
      throw new Error('Invalid tracker action.');
    const wallet = validateTrackedWallet({
      ...body,
      label: body.action === 'edit' ? body.label : '',
    });
    if (
      typeof body.expectedUpdatedAt !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(
        body.expectedUpdatedAt,
      ) ||
      !Number.isFinite(Date.parse(body.expectedUpdatedAt))
    )
      throw new Error('Invalid wallet revision.');
    const revision = new Date(
      Math.max(Date.now(), Date.parse(body.expectedUpdatedAt) + 1),
    ).toISOString();
    storageStarted = true;
    if (body.action === 'edit') {
      const result = await getD1()
        .prepare(`UPDATE tracked_wallets SET label = ?, group_name = ?, icon = ?, favorite = ?, updated_at = ?
      WHERE owner_id = ? AND address = ? AND network = ? AND updated_at = ?`)
        .bind(
          wallet.label,
          wallet.group,
          wallet.icon,
          wallet.favorite ? 1 : 0,
          revision,
          user.userId,
          wallet.address,
          wallet.network,
          body.expectedUpdatedAt,
        )
        .run();
      if (!result.meta.changes)
        return json(
          { error: 'Wallet changed in another tab. Reload the tracker first.' },
          409,
        );
      return json({ updated: true });
    }
    const result = await getD1()
      .prepare(`UPDATE tracked_wallets SET archived = ?, updated_at = ?
      WHERE owner_id = ? AND address = ? AND network = ? AND updated_at = ?`)
      .bind(
        body.action === 'archive' ? 1 : 0,
        revision,
        user.userId,
        wallet.address,
        wallet.network,
        body.expectedUpdatedAt,
      )
      .run();
    if (!result.meta.changes)
      return json(
        { error: 'Wallet changed in another tab. Reload the tracker first.' },
        409,
      );
    return json({ updated: true });
  } catch (error) {
    return storageStarted
      ? json({ error: 'Tracker storage temporarily unavailable.' }, 503)
      : json(
          {
            error:
              error instanceof Error
                ? error.message
                : 'Invalid tracker request.',
          },
          400,
        );
  }
}
