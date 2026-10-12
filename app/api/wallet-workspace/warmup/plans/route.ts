import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getD1 } from '@/db';
import { buildWarmupPlan, type WarmupInput } from '@/lib/wallet-warmup';
export const dynamic = 'force-dynamic';
const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
export async function GET(request?: Request) {
  const user = await getChatGPTUser();
  if (!user) return json({ error: 'Sign in to open warmup plans.' }, 401);
  const id = request ? new URL(request.url).searchParams.get('id') : null;
  if (id !== null && !/^[a-zA-Z0-9-]{1,64}$/.test(id))
    return json({ error: 'Choose a saved warmup plan.' }, 400);
  try {
    if (id !== null) {
      const row = await getD1()
        .prepare(
          'SELECT id,document,revision,archived,updated_at AS updatedAt FROM wallet_warmup_plans WHERE owner_id=? AND id=?',
        )
        .bind(user.userId, id)
        .first<{
          id: string;
          document: string;
          revision: number;
          archived: number;
          updatedAt: string;
        }>();
      return row
        ? json({
            plan: {
              ...row,
              archived: Boolean(row.archived),
              document: JSON.parse(row.document),
            },
          })
        : json({ error: 'Warmup plan not found.' }, 404);
    }
    const rows = await getD1()
      .prepare(
        'SELECT id,document,revision,archived,updated_at AS updatedAt FROM wallet_warmup_plans WHERE owner_id=? ORDER BY updated_at DESC LIMIT 100',
      )
      .bind(user.userId)
      .all<{
        id: string;
        document: string;
        revision: number;
        archived: number;
        updatedAt: string;
      }>();
    return json({
      plans: rows.results.map((r) => ({
        ...r,
        archived: Boolean(r.archived),
        document: JSON.parse(r.document),
      })),
    });
  } catch {
    return json({ error: 'Warmup storage unavailable.' }, 503);
  }
}
export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return json({ error: 'Sign in to save warmup plans.' }, 401);
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
    return json({ error: 'Cross-origin write rejected.' }, 403);
  let writing = false;
  try {
    const text = await request.text();
    if (text.length > 10000)
      return json({ error: 'Warmup request too large.' }, 413);
    const b = JSON.parse(text);
    if (
      !b ||
      typeof b.id !== 'string' ||
      !/^[a-zA-Z0-9-]{1,64}$/.test(b.id) ||
      !Number.isSafeInteger(b.expectedRevision) ||
      b.expectedRevision < 0 ||
      b.expectedRevision >= 1000000000 ||
      !['save', 'archive', 'restore'].includes(b.action) ||
      (b.expectedRevision === 0 && b.action !== 'save')
    )
      throw new Error('Invalid warmup mutation.');
    const db = getD1(),
      now = new Date().toISOString(),
      mutationId = crypto.randomUUID();
    let statement;
    if (b.action === 'save') {
      if (
        !b.document ||
        typeof b.document.name !== 'string' ||
        b.document.name.trim().length < 1 ||
        b.document.name.trim().length > 80 ||
        [...b.document.name].some(
          (c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127,
        )
      )
        throw new Error('Enter a warmup plan name up to 80 characters.');
      const plan = buildWarmupPlan(b.document as WarmupInput);
      const revisions = b.document.walletRevisions as Array<{
        address: string;
        revision: number;
      }>;
      if (
        !Array.isArray(revisions) ||
        revisions.length !== plan.addresses.length ||
        revisions.some(
          (r, i) =>
            !r ||
            r.address !== plan.addresses[i] ||
            !Number.isSafeInteger(r.revision) ||
            r.revision < 1,
        )
      )
        throw new Error('Reload the selected wallet revisions.');
      const doc = {
        name: b.document.name.trim(),
        chain: plan.chain,
        addresses: plan.addresses,
        tokens: plan.tokens,
        amount: plan.buyAmount,
        feeReserve: plan.feeReserve,
        cycles: plan.cycles,
        intervalMinutes: plan.intervalMinutes,
        startAt: plan.startAt,
        walletRevisions: revisions.map((r) => ({
          address: r.address,
          revision: r.revision,
        })),
        totalBudget: plan.totalBudget,
      };
      // Wallet checks and mutation run in a single SQL statement, closing archive/revision races.
      const guard = `(SELECT COUNT(*) FROM json_each(?) j JOIN workspace_wallets w ON w.address=json_extract(j.value,'$.address') AND w.revision=json_extract(j.value,'$.revision') WHERE w.owner_id=? AND w.chain=? AND w.archived=0)=?`;
      const args = [
        JSON.stringify(doc.walletRevisions),
        user.userId,
        plan.chain,
        plan.addresses.length,
      ];
      statement =
        b.expectedRevision === 0
          ? db
              .prepare(
                `INSERT INTO wallet_warmup_plans(owner_id,id,document,revision,archived,updated_at,mutation_id) SELECT ?,?,?,1,0,?,? WHERE ${guard} AND (SELECT COUNT(*) FROM wallet_warmup_plans WHERE owner_id=?)<100 ON CONFLICT(owner_id,id) DO NOTHING`,
              )
              .bind(
                user.userId,
                b.id,
                JSON.stringify(doc),
                now,
                mutationId,
                ...args,
                user.userId,
              )
          : db
              .prepare(
                `UPDATE wallet_warmup_plans SET document=?,revision=revision+1,updated_at=?,mutation_id=? WHERE owner_id=? AND id=? AND revision=? AND archived=0 AND ${guard}`,
              )
              .bind(
                JSON.stringify(doc),
                now,
                mutationId,
                user.userId,
                b.id,
                b.expectedRevision,
                ...args,
              );
    } else {
      statement = db
        .prepare(
          'UPDATE wallet_warmup_plans SET archived=?,revision=revision+1,updated_at=?,mutation_id=? WHERE owner_id=? AND id=? AND revision=? AND archived=?',
        )
        .bind(
          b.action === 'archive' ? 1 : 0,
          now,
          mutationId,
          user.userId,
          b.id,
          b.expectedRevision,
          b.action === 'archive' ? 0 : 1,
        );
    }
    writing = true;
    const results = await db.batch([
      statement,
      db
        .prepare(
          'INSERT INTO wallet_warmup_plan_events(id,owner_id,plan_id,type,revision,document,created_at) SELECT ?,owner_id,id,?,revision,document,? FROM wallet_warmup_plans WHERE owner_id=? AND id=? AND mutation_id=?',
        )
        .bind(
          crypto.randomUUID(),
          b.action === 'save'
            ? b.expectedRevision === 0
              ? 'plan.create'
              : 'plan.save'
            : 'plan.' + b.action,
          now,
          user.userId,
          b.id,
          mutationId,
        ),
    ]);
    if (!results[0].meta.changes)
      return json(
        {
          error:
            'Plan or selected wallets changed, plan is archived, or 100-plan limit reached. Reload before saving.',
        },
        409,
      );
    return json({ id: b.id, revision: b.expectedRevision + 1 });
  } catch (e) {
    return writing
      ? json({ error: 'Warmup storage unavailable.' }, 503)
      : json(
          { error: e instanceof Error ? e.message : 'Invalid warmup plan.' },
          400,
        );
  }
}
