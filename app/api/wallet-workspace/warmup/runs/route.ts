import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getD1 } from '@/db';
import { UUID } from '@/lib/wallet-operation';
import { observeWarmupHistory } from '@/lib/wallet-warmup-history';
import type { SavedWarmup } from '@/lib/wallet-warmup-storage';
import {
  HISTORY_RUN_COLUMNS,
  historyRun,
  historyRunControl,
  historyRunNext,
  type HistoryRunRow,
  type WarmupHistoryRun,
} from '@/lib/warmup-history-run';
export const dynamic = 'force-dynamic';
const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
const readRun = async (db: D1Database, owner: string, id: string) => {
  const row = await db
    .prepare(
      `SELECT ${HISTORY_RUN_COLUMNS} FROM warmup_history_runs WHERE owner_id=? AND id=?`,
    )
    .bind(owner, id)
    .first<HistoryRunRow>();
  return row ? historyRun(row) : null;
};
// Eligibility is rechecked in the same SQL statement that admits each write.
const eligible = `EXISTS (SELECT 1 FROM wallet_warmup_plans p WHERE p.owner_id=warmup_history_runs.owner_id AND p.id=warmup_history_runs.plan_id AND p.revision=warmup_history_runs.plan_revision AND p.archived=0)
AND NOT EXISTS (SELECT 1 FROM json_each(warmup_history_runs.document,'$.wallets') j WHERE NOT EXISTS (SELECT 1 FROM workspace_wallets w WHERE w.owner_id=warmup_history_runs.owner_id AND w.chain=json_extract(warmup_history_runs.document,'$.chain') AND w.address=json_extract(j.value,'$.address') AND w.revision=json_extract(j.value,'$.revision') AND w.archived=0))`;
export async function GET(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return json({ error: 'Sign in to view history runs.' }, 401);
  const planId = new URL(request.url).searchParams.get('planId');
  if (!planId || !UUID.test(planId))
    return json({ error: 'Choose a saved warmup plan.' }, 400);
  try {
    const db = getD1();
    if (
      !(await db
        .prepare('SELECT id FROM wallet_warmup_plans WHERE owner_id=? AND id=?')
        .bind(user.userId, planId)
        .first())
    )
      return json({ error: 'Plan unavailable.' }, 404);
    const rows = await db
      .prepare(
        `SELECT ${HISTORY_RUN_COLUMNS} FROM warmup_history_runs WHERE owner_id=? AND plan_id=? ORDER BY created_at DESC,id DESC LIMIT 20`,
      )
      .bind(user.userId, planId)
      .all<HistoryRunRow>();
    return json({
      planId,
      runs: rows.results.map(historyRun),
      executionAllowed: false,
    });
  } catch {
    return json({ error: 'History run storage unavailable.' }, 503);
  }
}
export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return json({ error: 'Sign in to manage history runs.' }, 401);
  if (
    request.headers.get('origin') &&
    request.headers.get('origin') !== new URL(request.url).origin
  )
    return json({ error: 'Cross-origin request rejected.' }, 403);
  if (
    !request.headers
      .get('content-type')
      ?.toLowerCase()
      .startsWith('application/json')
  )
    return json({ error: 'JSON required.' }, 415);
  let input: { action: string; id: string; revision: number };
  try {
    const text = await request.text();
    if (text.length > 1000) return json({ error: 'Request too large.' }, 413);
    input = JSON.parse(text);
    if (
      !input ||
      !['create', 'advance', 'pause', 'resume', 'cancel'].includes(
        input.action,
      ) ||
      typeof input.id !== 'string' ||
      !UUID.test(input.id) ||
      !Number.isSafeInteger(input.revision) ||
      input.revision < 1 ||
      input.revision > 1e9
    )
      throw new Error();
  } catch {
    return json({ error: 'Choose a current plan or run revision.' }, 400);
  }
  try {
    const db = getD1(),
      owner = user.userId,
      now = Date.now(),
      timestamp = new Date(now).toISOString();
    if (input.action === 'create') {
      const plan = await db
        .prepare(
          'SELECT document FROM wallet_warmup_plans WHERE owner_id=? AND id=? AND revision=? AND archived=0',
        )
        .bind(owner, input.id, input.revision)
        .first<{ document: string }>();
      if (!plan)
        return json(
          { error: 'Plan changed or is archived. Reload plans.' },
          409,
        );
      const document = JSON.parse(plan.document) as SavedWarmup['document'];
      if (
        document.walletRevisions.length < 1 ||
        document.walletRevisions.length > 20 ||
        new Set(document.walletRevisions.map((w) => w.address)).size !==
          document.walletRevisions.length
      )
        return json(
          { error: 'History runs support 1 to 20 distinct wallets.' },
          400,
        );
      const id = crypto.randomUUID(),
        doc = JSON.stringify({
          chain: document.chain,
          wallets: document.walletRevisions,
          results: [],
        });
      const insert = await db
        .prepare(`INSERT INTO warmup_history_runs(owner_id,id,plan_id,plan_revision,document,state,revision,created_at,updated_at,last_event)
        SELECT ?,?,?,?,?,'planned',1,?,?,'run.created' WHERE EXISTS (SELECT 1 FROM wallet_warmup_plans WHERE owner_id=? AND id=? AND revision=? AND archived=0)
        AND NOT EXISTS (SELECT 1 FROM json_each(?,'$.wallets') j WHERE NOT EXISTS (SELECT 1 FROM workspace_wallets w WHERE w.owner_id=? AND w.chain=? AND w.address=json_extract(j.value,'$.address') AND w.revision=json_extract(j.value,'$.revision') AND w.archived=0))
        AND NOT EXISTS (SELECT 1 FROM warmup_history_runs WHERE owner_id=? AND plan_id=? AND state IN ('planned','running','paused'))
        AND (SELECT COUNT(*) FROM warmup_history_runs WHERE owner_id=?)<100`)
        .bind(
          owner,
          id,
          input.id,
          input.revision,
          doc,
          timestamp,
          timestamp,
          owner,
          input.id,
          input.revision,
          doc,
          owner,
          document.chain,
          owner,
          input.id,
          owner,
        )
        .run();
      if (!insert.meta.changes)
        return json(
          {
            error:
              'Plan or wallets changed, an active run exists, or the 100-run account limit was reached.',
          },
          409,
        );
      return json({
        run: await readRun(db, owner, id),
        executionAllowed: false,
      });
    }
    const run = await readRun(db, owner, input.id);
    if (!run || run.revision !== input.revision)
      return json(
        { error: 'Run changed or is unavailable. Reload runs.' },
        409,
      );
    if (run.revision >= 1000 && input.action !== 'cancel')
      return json(
        {
          error:
            'Run transition limit reached. Cancel this run and create a new one.',
        },
        409,
      );
    if (input.action !== 'advance') {
      const next = historyRunControl(run.state, input.action);
      if (!next)
        return json({ error: 'This run cannot perform that transition.' }, 409);
      const changed = await db
        .prepare(
          `UPDATE warmup_history_runs SET state=?,last_event=?,revision=revision+1,lease_nonce=NULL,lease_until=NULL,updated_at=? WHERE owner_id=? AND id=? AND revision=? ${input.action === 'resume' ? `AND ${eligible}` : ''}`,
        )
        .bind(
          next,
          `run.${input.action}`,
          timestamp,
          owner,
          input.id,
          input.revision,
        )
        .run();
      if (!changed.meta.changes)
        return json(
          { error: 'Run, plan or wallets changed. Reload runs.' },
          409,
        );
      return json({
        run: await readRun(db, owner, input.id),
        executionAllowed: false,
      });
    }
    if (
      !['planned', 'running'].includes(run.state) ||
      (run.leaseUntil !== null && run.leaseUntil > now)
    )
      return json(
        { error: 'Run is paused, finished or has an active wallet read.' },
        409,
      );
    const next = historyRunNext(run);
    if (!next) return json({ error: 'No remaining wallet in this run.' }, 409);
    const gate = await db
      .prepare(
        'INSERT INTO wallet_balance_gates(owner_id,next_allowed_at) VALUES (?,?) ON CONFLICT(owner_id) DO UPDATE SET next_allowed_at=excluded.next_allowed_at WHERE wallet_balance_gates.next_allowed_at<=?',
      )
      .bind(owner, now + 15000, now)
      .run();
    if (!gate.meta.changes)
      return json({ error: 'Wait 15 seconds between wallet reads.' }, 429);
    const nonce = crypto.randomUUID();
    const claim = await db
      .prepare(
        `UPDATE warmup_history_runs SET state='running',last_event=?,revision=revision+1,lease_nonce=?,lease_until=?,updated_at=? WHERE owner_id=? AND id=? AND revision=? AND state IN ('planned','running') AND (lease_until IS NULL OR lease_until<=?) AND ${eligible}`,
      )
      .bind(
        run.leaseUntil === null ? 'run.read_started' : 'run.read_recovered',
        nonce,
        now + 45000,
        timestamp,
        owner,
        input.id,
        input.revision,
        now,
      )
      .run();
    if (!claim.meta.changes)
      return json({ error: 'Run, plan or wallets changed. Reload runs.' }, 409);
    const signal = AbortSignal.any([
      request.signal,
      AbortSignal.timeout(25000),
    ]);
    let result: WarmupHistoryRun['document']['results'][number];
    try {
      const observation = await observeWarmupHistory(
        run.document.chain,
        next.address,
        signal,
      );
      if (
        observation.address !== next.address ||
        observation.chain !== run.document.chain
      )
        throw new Error();
      result = { address: next.address, observation };
    } catch {
      result = {
        address: next.address,
        error: request.signal.aborted
          ? 'History check interrupted. No readiness conclusion.'
          : 'History provider unavailable. No readiness conclusion.',
      };
    }
    const doc = { ...run.document, results: [...run.document.results, result] };
    const finished = doc.results.length === doc.wallets.length;
    const saved = await db
      .prepare(
        `UPDATE warmup_history_runs SET document=?,state=?,last_event=?,revision=revision+1,lease_nonce=NULL,lease_until=NULL,updated_at=? WHERE owner_id=? AND id=? AND revision=? AND state='running' AND lease_nonce=? AND lease_until>? AND ${eligible}`,
      )
      .bind(
        JSON.stringify(doc),
        finished ? 'completed' : 'planned',
        result.error ? 'run.read_failed' : 'run.read_completed',
        new Date().toISOString(),
        owner,
        input.id,
        input.revision + 1,
        nonce,
        Date.now(),
      )
      .run();
    if (!saved.meta.changes) {
      await db
        .prepare(
          "UPDATE warmup_history_runs SET state='paused',last_event='run.interrupted',revision=revision+1,lease_nonce=NULL,lease_until=NULL,updated_at=? WHERE owner_id=? AND id=? AND state='running' AND lease_nonce=?",
        )
        .bind(new Date().toISOString(), owner, input.id, nonce)
        .run();
      return json(
        {
          error:
            'Run was interrupted or its plan/wallets changed. The in-flight observation was not saved.',
        },
        409,
      );
    }
    return json({
      run: await readRun(db, owner, input.id),
      executionAllowed: false,
    });
  } catch {
    return json(
      { error: 'History run storage unavailable. Reload before retrying.' },
      503,
    );
  }
}
