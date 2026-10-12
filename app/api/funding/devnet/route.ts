import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getD1 } from '@/db';
import {
  devnetFundingDocument,
  savedFundingIntent,
  fundingLink,
} from '@/lib/devnet-saved-funding';
export const dynamic = 'force-dynamic';
const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { 'cache-control': 'no-store' } });
export async function GET(request: Request) {
  const user = await getChatGPTUser();
  if (!user)
    return json({ error: 'Sign in to review saved devnet funding.' }, 401);
  const params = new URL(request.url).searchParams,
    id = params.get('id'),
    revision = params.get('revision');
  if (
    !id ||
    !/^[a-zA-Z0-9-]{1,64}$/.test(id) ||
    !revision ||
    !/^[1-9]\d{0,9}$/.test(revision) ||
    Number(revision) > 1000000000
  )
    return json({ error: 'Choose a saved funding revision.' }, 400);
  try {
    const db = getD1(),
      saved = await db
        .prepare(
          'SELECT document,revision,archived FROM funding_plans WHERE owner_id=? AND id=?',
        )
        .bind(user.userId, id)
        .first<{ document: string; revision: number; archived: number }>();
    if (!saved) return json({ error: 'Saved funding draft not found.' }, 404);
    if (saved.archived || saved.revision !== Number(revision))
      return json(
        { error: 'Funding draft changed. Reload it before continuing.' },
        409,
      );
    const { document, asset } = devnetFundingDocument(
      JSON.parse(saved.document),
    );
    const rows = await Promise.all(
      document.recipients.map(async (row) => {
        const intent = await savedFundingIntent(
          document,
          id,
          saved.revision,
          row.address,
        );
        return {
          address: row.address,
          amount: row.amount,
          key: fundingLink(intent)!.key,
        };
      }),
    );
    const completed = await db
      .prepare(`SELECT DISTINCT json_extract(details,'$.fundingKey') AS key FROM wallet_audit_events
      WHERE owner_id=? AND wallet_address=? AND network='devnet' AND event_type IN ('native_transfer_finalized','token_transfer_finalized') AND json_valid(details)
      AND json_extract(details,'$.fundingKey') IN (${rows.map(() => '?').join(',')})`)
      .bind(user.userId, document.funderAddress, ...rows.map((row) => row.key))
      .all<{ key: string }>();
    const current = await db
      .prepare(
        'SELECT revision,archived FROM funding_plans WHERE owner_id=? AND id=?',
      )
      .bind(user.userId, id)
      .first<{ revision: number; archived: number }>();
    if (!current || current.archived || current.revision !== saved.revision)
      return json({ error: 'Funding draft changed during review.' }, 409);
    return json({
      id,
      revision: saved.revision,
      network: 'devnet',
      document,
      asset,
      recipients: rows,
      completed: completed.results.map((row) => row.key),
    });
  } catch {
    return json(
      { error: 'Saved devnet funding review temporarily unavailable.' },
      503,
    );
  }
}
