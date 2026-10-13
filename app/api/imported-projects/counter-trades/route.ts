import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getD1 } from '@/db';
import { UUID } from '@/lib/wallet-operation';
import {
  initialCounterLedger,
  evaluateCounterTrade,
  type CounterRules,
} from '@/lib/counter-trade';
import {
  readCounterPlan,
  listCounterPlans,
  type CounterPlan,
} from '@/lib/counter-trade-store';
import {
  readPoolTradeContext,
  selectedPoolTradeContext,
  type PoolTradeSelection,
} from '@/lib/pool-trade-context';
import { observePoolTradeMovement } from '@/lib/pool-trade-movement-server';
import { walletAddress } from '@/lib/wallet-workspace';
export const dynamic = 'force-dynamic';
const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
const keySet = (v: object, keys: string) =>
  Object.keys(v).sort().join(',') === keys;
type Input = {
  action: string;
  id: string;
  projectId: string;
  projectRevision?: number;
  revision?: number;
  rules?: CounterRules;
  selection?: PoolTradeSelection;
  state?: CounterPlan['state'];
};
export async function GET(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return json({ error: 'Sign in to read Counter plans.' }, 401);
  const q = new URL(request.url).searchParams,
    projectId = q.get('projectId'),
    id = q.get('id');
  if (
    !projectId ||
    !UUID.test(projectId) ||
    (id === null ? q.size !== 1 : q.size !== 2 || !UUID.test(id))
  )
    return json({ error: 'Choose a project or one saved Counter plan.' }, 400);
  try {
    if (id === null) {
      const plans = await listCounterPlans(getD1(), user.userId, projectId);
      return json({ projectId, plans, executionAllowed: false });
    }
    const plan = await readCounterPlan(getD1(), user.userId, projectId, id);
    return plan
      ? json({ plan, executionAllowed: false })
      : json({ error: 'Owned Counter plan unavailable.' }, 404);
  } catch {
    return json({ error: 'Counter history unavailable.' }, 503);
  }
}
export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user)
    return json({ error: 'Sign in to configure Counter evaluation.' }, 401);
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
  let input: Input;
  try {
    const text = await request.text();
    if (text.length > 8192) return json({ error: 'Request too large.' }, 413);
    input = JSON.parse(text);
    if (!input || !UUID.test(input.id) || !UUID.test(input.projectId))
      throw new Error();
    if (input.action === 'create') {
      if (
        !keySet(input, 'action,id,projectId,projectRevision,rules') ||
        !Number.isSafeInteger(input.projectRevision) ||
        input.projectRevision! < 1 ||
        !input.rules ||
        !keySet(
          input.rules,
          'format,ignoredWallets,minimumResponseTokenRaw,replicationPercent,responseSide,trigger',
        ) ||
        !Array.isArray(input.rules.ignoredWallets) ||
        input.rules.ignoredWallets.length > 100 ||
        !input.rules.trigger ||
        !keySet(
          input.rules.trigger,
          input.rules.trigger.kind === 'rate'
            ? 'kind,percent'
            : 'kind,minimumRaw',
        )
      )
        throw new Error();
    } else if (input.action === 'evaluate') {
      if (
        !keySet(input, 'action,id,projectId,revision,selection') ||
        !Number.isSafeInteger(input.revision) ||
        input.revision! < 1 ||
        !input.selection ||
        !keySet(input.selection, 'id,pool,revision,tapeObservedAt,tradeId') ||
        input.selection.id !== input.projectId ||
        typeof input.selection.tradeId !== 'string' ||
        !input.selection.tradeId ||
        input.selection.tradeId.length > 256 ||
        !Number.isSafeInteger(input.selection.revision) ||
        input.selection.revision < 1 ||
        !Number.isFinite(Date.parse(input.selection.tapeObservedAt))
      )
        throw new Error();
      walletAddress(input.selection.pool, 'Solana');
    } else if (input.action === 'control') {
      if (
        !keySet(input, 'action,id,projectId,revision,state') ||
        !Number.isSafeInteger(input.revision) ||
        input.revision! < 1 ||
        !['active', 'paused', 'ended'].includes(input.state!)
      )
        throw new Error();
    } else throw new Error();
  } catch {
    return json(
      { error: 'Choose valid Counter rules or a saved trade selection.' },
      400,
    );
  }
  try {
    const db = getD1(),
      project = await readPoolTradeContext(db, user.userId, input.projectId);
    const old = await readCounterPlan(
      db,
      user.userId,
      input.projectId,
      input.id,
    );
    if (input.action === 'control') {
      if (!old) return json({ error: 'Owned Counter plan unavailable.' }, 404);
      if (old.revision !== input.revision || old.state === 'ended')
        return json(
          { error: 'Counter state changed or ended. Reload history.' },
          409,
        );
      if (
        input.state === 'active' &&
        (!project ||
          project.archived ||
          project.document !== old.projectDocument ||
          project.revision !== old.ledger.scope.revision)
      )
        return json(
          { error: 'Project changed. A new reviewed plan is required.' },
          409,
        );
      const plan: CounterPlan = {
        ...old,
        revision: old.revision + 1,
        state: input.state!,
        updatedAt: new Date().toISOString(),
      };
      const write = await db
        .prepare(
          "UPDATE counter_trade_plans SET revision=?,state=?,document=? WHERE owner_id=? AND project_id=? AND id=? AND revision=? AND document=? AND (?<>'active' OR (EXISTS(SELECT 1 FROM imported_token_projects WHERE owner_id=? AND id=? AND revision=? AND archived=0 AND document=?) AND NOT EXISTS(SELECT 1 FROM wallet_ownership_proofs WHERE owner_id=? AND chain='Solana' AND address NOT IN (SELECT value FROM json_each(?)))))",
        )
        .bind(
          plan.revision,
          plan.state,
          JSON.stringify(plan),
          user.userId,
          input.projectId,
          input.id,
          old.revision,
          JSON.stringify(old),
          plan.state,
          user.userId,
          input.projectId,
          old.ledger.scope.revision,
          old.projectDocument,
          user.userId,
          JSON.stringify(old.rules.ignoredWallets),
        )
        .run();
      return write.meta.changes
        ? json({ plan, executionAllowed: false })
        : json({ error: 'Counter control changed. Reload history.' }, 409);
    }
    if (!project)
      return json({ error: 'Owned Solana project unavailable.' }, 404);
    if (project.archived)
      return json(
        { error: 'Project archived. Counter history remains readable.' },
        409,
      );
    if (input.action === 'create') {
      if (project.revision !== input.projectRevision)
        return json({ error: 'Project revision changed.' }, 409);
      const owned = await db
        .prepare(
          "SELECT address FROM wallet_ownership_proofs WHERE owner_id=? AND chain='Solana' ORDER BY address",
        )
        .bind(user.userId)
        .all<{ address: string }>();
      const selectedWallet = (
        JSON.parse(project.document) as {
          tradeSettings?: { wallet?: unknown };
        }
      ).tradeSettings?.wallet;
      const tradingWallet =
        selectedWallet === undefined
          ? []
          : [walletAddress(selectedWallet, 'Solana')];
      const rules: CounterRules = {
        ...input.rules!,
        ignoredWallets: [
          ...new Set([
            ...input.rules!.ignoredWallets,
            ...tradingWallet,
            ...owned.results.map((w) => w.address),
          ]),
        ].sort(),
      };
      const token = JSON.parse(project.document).token;
      if (token.chain !== 'Solana' || token.address !== project.address)
        throw new Error();
      let ledger;
      try {
        ledger = initialCounterLedger(rules, {
          projectId: input.projectId,
          revision: project.revision,
          mint: project.address,
          decimals: token.decimals,
        });
      } catch {
        return json(
          {
            error:
              'Counter rule amounts, percentages or addresses are invalid.',
          },
          400,
        );
      }
      if (old)
        return old.projectDocument === project.document &&
          old.ledger.rulesKey === ledger.rulesKey
          ? json({ plan: old, executionAllowed: false, replayed: true })
          : json(
              { error: 'Saved plan identity belongs to different rules.' },
              409,
            );
      const now = new Date().toISOString(),
        plan: CounterPlan = {
          format: 'counter-plan-v1',
          executionAllowed: false,
          id: input.id,
          projectId: input.projectId,
          revision: 1,
          state: 'active',
          projectDocument: project.document,
          rules,
          ledger,
          createdAt: now,
          updatedAt: now,
        };
      const write = await db
        .prepare(
          "INSERT INTO counter_trade_plans(owner_id,project_id,id,revision,state,document) SELECT ?,?,?,1,'active',? WHERE EXISTS(SELECT 1 FROM imported_token_projects WHERE owner_id=? AND id=? AND revision=? AND archived=0 AND document=?) AND (SELECT COUNT(*) FROM counter_trade_plans WHERE owner_id=? AND project_id=?)<20 AND NOT EXISTS(SELECT 1 FROM wallet_ownership_proofs WHERE owner_id=? AND chain='Solana' AND address NOT IN (SELECT value FROM json_each(?))) ON CONFLICT DO NOTHING",
        )
        .bind(
          user.userId,
          input.projectId,
          input.id,
          JSON.stringify(plan),
          user.userId,
          input.projectId,
          project.revision,
          project.document,
          user.userId,
          input.projectId,
          user.userId,
          JSON.stringify(rules.ignoredWallets),
        )
        .run();
      return write.meta.changes
        ? json({ plan, executionAllowed: false })
        : json(
            {
              error:
                'Counter plan or wallet context changed, or plan history is full.',
            },
            409,
          );
    }
    if (!old) return json({ error: 'Owned Counter plan unavailable.' }, 404);
    if (
      old.state !== 'active' ||
      old.projectDocument !== project.document ||
      old.ledger.scope.revision !== project.revision
    )
      return json(
        { error: 'Counter is paused, ended or its project changed.' },
        409,
      );
    const context = selectedPoolTradeContext(project, input.selection!);
    const roster = await db
      .prepare(
        "SELECT address FROM wallet_ownership_proofs WHERE owner_id=? AND chain='Solana'",
      )
      .bind(user.userId)
      .all<{ address: string }>();
    if (
      roster.results.some((w) => !old.rules.ignoredWallets.includes(w.address))
    )
      return json(
        { error: 'Owned wallet context changed. Review a new exclusion set.' },
        409,
      );
    const identity = JSON.stringify([
      context.projectId,
      context.mint,
      context.trade.sender,
      context.trade.transaction,
    ]);
    const known = old.ledger.decisions.find((d) => d.identity === identity);
    if (known) {
      const fingerprint = JSON.parse(known.fingerprint);
      if (
        fingerprint[9] !== context.trade.block ||
        fingerprint[2] !== context.trade.side
      )
        return json(
          {
            error:
              'Saved signal metadata differs. Reload the recorded evidence.',
          },
          409,
        );
      return json({
        plan: old,
        decision: known,
        replayed: true,
        executionAllowed: false,
      });
    }
    if (old.revision !== input.revision || old.ledger.decisions.length >= 1000)
      return json(
        { error: 'Counter revision changed or evaluation history is full.' },
        409,
      );
    const now = Date.now(),
      gate = await db
        .prepare(
          'INSERT INTO wallet_balance_gates(owner_id,next_allowed_at) VALUES (?,?) ON CONFLICT(owner_id) DO UPDATE SET next_allowed_at=excluded.next_allowed_at WHERE wallet_balance_gates.next_allowed_at<=?',
        )
        .bind(user.userId, now + 15000, now)
        .run();
    if (!gate.meta.changes)
      return json(
        { error: 'Wait 15 seconds between wallet provider checks.' },
        429,
      );
    const movement = await observePoolTradeMovement(
      context,
      AbortSignal.any([request.signal, AbortSignal.timeout(20000)]),
    );
    const observedTime = Date.parse(movement.observedAt);
    if (
      movement.blockTime === null ||
      movement.blockTime * 1000 < Date.parse(old.createdAt) - 1000 ||
      movement.blockTime * 1000 > Date.now() + 1000 ||
      Date.now() - movement.blockTime * 1000 > 300000 ||
      observedTime > Date.now() + 1000 ||
      Date.now() - observedTime > 300000
    )
      return json(
        {
          error:
            'Trade is outside the reviewed activation or freshness window.',
        },
        409,
      );
    const result = evaluateCounterTrade(
      old.rules,
      old.ledger,
      movement,
      context,
    );
    const plan: CounterPlan = {
      ...old,
      revision: old.revision + 1,
      ledger: result.ledger,
      updatedAt: new Date().toISOString(),
    };
    const document = JSON.stringify(plan);
    if (new TextEncoder().encode(document).length > 1_000_000)
      return json(
        {
          error:
            'Counter history capacity reached. Previous decisions remain saved.',
        },
        409,
      );
    const write = await db
      .prepare(
        "UPDATE counter_trade_plans SET revision=?,document=? WHERE owner_id=? AND project_id=? AND id=? AND revision=? AND state='active' AND document=? AND EXISTS(SELECT 1 FROM imported_token_projects WHERE owner_id=? AND id=? AND revision=? AND archived=0 AND document=?) AND EXISTS(SELECT 1 FROM imported_pool_trades WHERE owner_id=? AND project_id=? AND document=?) AND NOT EXISTS(SELECT 1 FROM wallet_ownership_proofs WHERE owner_id=? AND chain='Solana' AND address NOT IN (SELECT value FROM json_each(?))) AND ? BETWEEN CAST(strftime('%s','now') AS INTEGER)-300 AND CAST(strftime('%s','now') AS INTEGER)+1 AND julianday(?) BETWEEN julianday('now','-300 seconds') AND julianday('now','+1 seconds')",
      )
      .bind(
        plan.revision,
        document,
        user.userId,
        input.projectId,
        input.id,
        old.revision,
        JSON.stringify(old),
        user.userId,
        input.projectId,
        project.revision,
        project.document,
        user.userId,
        input.projectId,
        project.tape,
        user.userId,
        JSON.stringify(old.rules.ignoredWallets),
        movement.blockTime,
        movement.observedAt,
      )
      .run();
    return write.meta.changes
      ? json({
          plan,
          decision: result.decision,
          replayed: false,
          executionAllowed: false,
        })
      : json(
          {
            error:
              'Counter, project, tape or wallet context changed. Reload retained decisions.',
          },
          409,
        );
  } catch {
    return json(
      { error: 'Counter evaluation unavailable. No execution was authorized.' },
      503,
    );
  }
}
