import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getD1 } from '@/db';
import { walletRequest } from '@/lib/wallet-request';
import { UUID } from '@/lib/wallet-operation';
import {
  decodeTradeSession,
  decodeTradeSessionControl,
  validatedTradeSessionControls,
  type TradeSessionControl,
  tradeSessionTerms,
} from '@/lib/imported-trade-session';
export const dynamic = 'force-dynamic';
const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
const columns =
  'id,revision,state,document,created_at AS createdAt,updated_at AS updatedAt';
type Row = {
  id: string;
  revision: number;
  state: string;
  document: string;
  createdAt: string;
  updatedAt: string;
};
const decode = (r: Row) =>
  decodeTradeSession({ ...r, terms: JSON.parse(r.document) });
const controlColumns =
  'session_id AS sessionId,project_id AS projectId,state,revision,created_at AS createdAt,updated_at AS updatedAt';
async function controlFor(db: D1Database, owner: string, id: unknown) {
  return decodeTradeSessionControl(
    await db
      .prepare(
        'SELECT ' +
          controlColumns +
          ' FROM imported_trade_session_controls WHERE owner_id=? AND session_id=?',
      )
      .bind(owner, id)
      .first(),
  );
}

export async function GET(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return json({ error: 'Sign in to view trade sessions.' }, 401);
  const projectId = new URL(request.url).searchParams.get('projectId');
  if (!projectId || !UUID.test(projectId))
    return json({ error: 'Choose an imported project.' }, 400);
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
    const rows = await db
      .prepare(
        `SELECT ${columns} FROM imported_trade_sessions WHERE owner_id=? AND project_id=? ORDER BY created_at DESC,id LIMIT 101`,
      )
      .bind(user.userId, projectId)
      .all<Row>();
    if (rows.results.length > 100) throw new Error();
    const activity = await db
      .prepare(
        "SELECT json_extract(p.document,'$.session.sessionId') AS sessionId,json_extract(p.document,'$.session.entry') AS entry,i.id AS intentId,i.state,i.signature,r.id AS receiptId FROM imported_swap_signing_intents i JOIN imported_swap_preparations p ON p.owner_id=i.owner_id AND p.id=i.preparation_id LEFT JOIN imported_swap_receipts r ON r.owner_id=i.owner_id AND r.intent_id=i.id WHERE i.owner_id=? AND p.project_id=? AND json_type(p.document,'$.session') IS NOT NULL ORDER BY i.created_at DESC,i.id DESC LIMIT 201",
      )
      .bind(user.userId, projectId)
      .all();
    if (activity.results.length > 200) throw new Error();
    const sessions = rows.results.map(decode),
      controls = await db
        .prepare(
          'SELECT ' +
            controlColumns +
            ' FROM imported_trade_session_controls WHERE owner_id=? AND project_id=? LIMIT 101',
        )
        .bind(user.userId, projectId)
        .all<TradeSessionControl>();
    return json({
      projectId,
      controls: validatedTradeSessionControls(controls.results, sessions),
      sessions,
      activity: activity.results,
      executionAllowed: false,
    });
  } catch {
    return json({ error: 'Trade session history unavailable.' }, 503);
  }
}
export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return json({ error: 'Sign in to manage trade sessions.' }, 401);
  let body: Record<string, unknown>;
  try {
    if (
      !request.headers
        .get('content-type')
        ?.toLowerCase()
        .startsWith('application/json')
    )
      throw new Error();
    body = await walletRequest(request, 12000);
    if (
      !['create', 'cancel', 'pause', 'resume'].includes(String(body.action)) ||
      typeof body.id !== 'string' ||
      !UUID.test(body.id) ||
      typeof body.projectId !== 'string' ||
      !UUID.test(body.projectId)
    )
      throw new Error();
    if (
      body.action !== 'create' &&
      (!Number.isSafeInteger(body.revision) ||
        Number(body.revision) < 1 ||
        Number(body.revision) >= 1e9)
    )
      throw new Error();
    if (
      Object.keys(body).sort().join(',') !==
      (body.action === 'create'
        ? Object.hasOwn(body, 'schedule')
          ? 'action,entries,id,projectId,projectRevision,schedule,side'
          : 'action,entries,id,projectId,projectRevision,side'
        : 'action,id,projectId,revision')
    )
      throw new Error();
  } catch {
    return json({ error: 'Review exact session terms.' }, 400);
  }
  try {
    const db = getD1(),
      owner = user.userId;
    const old = await db
      .prepare(
        `SELECT ${columns} FROM imported_trade_sessions WHERE owner_id=? AND project_id=? AND id=?`,
      )
      .bind(owner, body.projectId, body.id)
      .first<Row>();

    if (body.action === 'pause' || body.action === 'resume') {
      if (!old || old.state !== 'active')
        return json({ error: 'Session changed or cancelled.' }, 409);
      const target = body.action === 'pause' ? 'paused' : 'ready',
        current = await controlFor(db, owner, body.id);
      if (
        current.state === target &&
        (current.revision === body.revision ||
          current.revision === Number(body.revision) + 1)
      )
        return json({ control: current, executionAllowed: false });
      if (current.revision !== body.revision)
        return json(
          { error: 'Session control changed. Reload before retrying.' },
          409,
        );
      const result = await db
        .prepare(
          "UPDATE imported_trade_session_controls SET state=?,revision=revision+1,updated_at=? WHERE owner_id=? AND project_id=? AND session_id=? AND revision=? AND state<>? AND EXISTS(SELECT 1 FROM imported_trade_sessions t WHERE t.owner_id=imported_trade_session_controls.owner_id AND t.id=imported_trade_session_controls.session_id AND t.state='active')",
        )
        .bind(
          target,
          new Date().toISOString(),
          owner,
          body.projectId,
          body.id,
          body.revision,
          target,
        )
        .run();
      const control = await controlFor(db, owner, body.id);
      if (
        !result.meta.changes &&
        (control.state !== target ||
          control.revision !== Number(body.revision) + 1)
      )
        return json(
          { error: 'Session control changed. Reload before retrying.' },
          409,
        );
      return json({ control, executionAllowed: false });
    }
    if (body.action === 'cancel') {
      if (!old || old.revision !== body.revision || old.state !== 'active')
        return json({ error: 'Session changed.' }, 409);
      const result = await db
        .prepare(
          "UPDATE imported_trade_sessions SET state='cancelled',revision=revision+1,updated_at=? WHERE owner_id=? AND project_id=? AND id=? AND revision=? AND state='active' AND NOT EXISTS(SELECT 1 FROM imported_swap_signing_intents i JOIN imported_swap_preparations p ON p.owner_id=i.owner_id AND p.id=i.preparation_id WHERE i.owner_id=imported_trade_sessions.owner_id AND json_extract(p.document,'$.session.sessionId')=imported_trade_sessions.id AND i.state IN ('awaiting_signature','signed','submitted'))",
        )
        .bind(
          new Date().toISOString(),
          owner,
          body.projectId,
          body.id,
          body.revision,
        )
        .run();
      return result.meta.changes
        ? json({ cancelled: true })
        : json(
            { error: 'Recover live approvals before cancelling the session.' },
            409,
          );
    }
    const project = await db
      .prepare(
        "SELECT revision,archived,document FROM imported_token_projects WHERE owner_id=? AND id=? AND chain='Solana'",
      )
      .bind(owner, body.projectId)
      .first<{ revision: number; archived: number; document: string }>();
    if (!project) return json({ error: 'Solana project unavailable.' }, 404);
    const token = JSON.parse(project.document).token;
    let terms;
    try {
      terms = tradeSessionTerms(body, token);
    } catch {
      return json(
        { error: 'Choose exact amounts for 1 to 25 distinct current wallets.' },
        400,
      );
    }
    const text = JSON.stringify(terms);
    if (old)
      return old.document === text
        ? json({
            session: decode(old),
            control: await controlFor(db, owner, body.id),
            executionAllowed: false,
          })
        : json(
            { error: 'Request ID already has different immutable terms.' },
            409,
          );
    if (
      terms.schedule &&
      (Date.parse(terms.schedule.startAt) < Date.now() - 60000 ||
        Date.parse(terms.schedule.startAt) > Date.now() + 365 * 86400000)
    )
      return json(
        {
          error:
            'Choose a start within the next year. Saved session retries remain available.',
        },
        400,
      );
    if (project.archived || project.revision !== body.projectRevision)
      return json({ error: 'Project changed.' }, 409);
    const entries = JSON.stringify(terms.entries),
      now = new Date().toISOString();
    // A single INSERT SELECT checks every owned wallet and the project atomically.
    const write = await db
      .prepare(
        "INSERT OR IGNORE INTO imported_trade_sessions SELECT ?,?,?,?,'active',1,?,? WHERE EXISTS(SELECT 1 FROM imported_token_projects WHERE owner_id=? AND id=? AND revision=? AND archived=0 AND chain='Solana' AND document=?) AND (? IS NULL OR (julianday(?)>=julianday('now','-1 minute') AND julianday(?)<=julianday('now','+365 days'))) AND NOT EXISTS(SELECT 1 FROM json_each(?) e WHERE NOT EXISTS(SELECT 1 FROM workspace_wallets w WHERE w.owner_id=? AND w.chain='Solana' AND w.archived=0 AND w.address=json_extract(e.value,'$.wallet') AND w.revision=json_extract(e.value,'$.walletRevision')))",
      )
      .bind(
        owner,
        body.id,
        body.projectId,
        text,
        now,
        now,
        owner,
        body.projectId,
        body.projectRevision,
        project.document,
        terms.schedule?.startAt ?? null,
        terms.schedule?.startAt ?? null,
        terms.schedule?.startAt ?? null,
        entries,
        owner,
      )
      .run();
    if (!write.meta.changes)
      return json(
        {
          error: 'Wallets or project changed. Retry the same session request.',
        },
        409,
      );
    return json({
      control: await controlFor(db, owner, body.id),
      session: decode({
        id: String(body.id),
        revision: 1,
        state: 'active',
        document: text,
        createdAt: now,
        updatedAt: now,
      }),
      executionAllowed: false,
    });
  } catch {
    return json(
      { error: 'Trade session storage unavailable. No trades started.' },
      503,
    );
  }
}
