import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getD1 } from '@/db';
import { UUID } from '@/lib/wallet-operation';
import {
  requirePoolTradeMovement,
  type PoolTradeMovementContext,
} from '@/lib/pool-trade-movement';
import { observePoolTradeMovement } from '@/lib/pool-trade-movement-server';
import type { PoolTrades } from '@/lib/pool-trades';
import type { ImportedTokenDocument } from '@/lib/imported-token-project';
import { walletAddress } from '@/lib/wallet-workspace';
import { transactionSignature } from '@/lib/tracked-wallet-transaction';
import { poolTradeMovementError } from '@/lib/pool-trade-movement-error';
export const dynamic = 'force-dynamic';
const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { 'cache-control': 'no-store' } });
type Selection = {
  id: string;
  revision: number;
  pool: string;
  tradeId: string;
  tapeObservedAt: string;
};
type ContextRow = {
  address: string;
  revision: number;
  archived: number;
  document: string;
  tape: string | null;
};
function readContext(db: D1Database, owner: string, id: string) {
  return db
    .prepare(
      "SELECT p.address,p.revision,p.archived,p.document,m.document AS tape FROM imported_token_projects p LEFT JOIN imported_pool_trades m ON m.owner_id=p.owner_id AND m.project_id=p.id WHERE p.owner_id=? AND p.id=? AND p.chain='Solana'",
    )
    .bind(owner, id)
    .first<ContextRow>();
}
function selectionContext(
  row: ContextRow,
  input: Selection,
): PoolTradeMovementContext {
  if (row.archived || row.revision !== input.revision)
    throw new Error('Project changed or is archived. Reload its trade tape.');
  const document = JSON.parse(row.document) as ImportedTokenDocument;
  if (
    document.token.chain !== 'Solana' ||
    document.token.address !== row.address ||
    !Number.isSafeInteger(document.token.decimals) ||
    document.token.decimals < 0 ||
    document.token.decimals > 255
  )
    throw new Error('Token identity unavailable.');
  const observations = row.tape ? (JSON.parse(row.tape) as PoolTrades[]) : [];
  if (!Array.isArray(observations) || observations.length > 10)
    throw new Error('Saved trade tape unavailable.');
  const tape = observations.find(
    (o) => o.pool === input.pool && o.observedAt === input.tapeObservedAt,
  );
  if (
    !tape ||
    tape.chain !== 'Solana' ||
    tape.address !== row.address ||
    tape.projectRevision !== row.revision ||
    !Array.isArray(tape.trades) ||
    tape.trades.length > 100
  )
    throw new Error('Choose a trade from the current saved project tape.');
  const matches = tape.trades.filter((t) => t.id === input.tradeId);
  if (matches.length !== 1) throw new Error('Choose one saved trade record.');
  const trade = matches[0];
  walletAddress(trade.sender, 'Solana');
  transactionSignature(trade.transaction);
  if (
    !['Buy', 'Sell'].includes(trade.side) ||
    !Number.isSafeInteger(trade.block) ||
    trade.block < 0
  )
    throw new Error('Saved trade identity differs.');
  return {
    projectId: input.id,
    revision: input.revision,
    pool: input.pool,
    tapeObservedAt: input.tapeObservedAt,
    mint: row.address,
    decimals: document.token.decimals,
    trade,
  };
}
export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user)
    return json({ error: 'Sign in to inspect wallet movements.' }, 401);
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
  let input: Selection;
  try {
    const text = await request.text();
    if (text.length > 1000) return json({ error: 'Request too large.' }, 413);
    input = JSON.parse(text);
    if (
      !input ||
      Object.keys(input).sort().join(',') !==
        'id,pool,revision,tapeObservedAt,tradeId' ||
      !UUID.test(input.id) ||
      !Number.isSafeInteger(input.revision) ||
      input.revision < 1 ||
      input.revision >= 1e9 ||
      typeof input.tradeId !== 'string' ||
      !input.tradeId ||
      input.tradeId.length > 256 ||
      !Number.isFinite(Date.parse(input.tapeObservedAt))
    )
      throw new Error();
    walletAddress(input.pool, 'Solana');
  } catch {
    return json({ error: 'Choose a current saved Solana pool trade.' }, 400);
  }
  const db = getD1();
  let row: ContextRow, context: PoolTradeMovementContext;
  try {
    const captured = await readContext(db, user.userId, input.id);
    if (!captured)
      return json({ error: 'Owned Solana project unavailable.' }, 404);
    row = captured;
    context = selectionContext(row, input);
    const now = Date.now();
    const gate = await db
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
  } catch {
    return json(
      {
        error: 'Project or trade tape changed. Reload the current observation.',
      },
      409,
    );
  }
  try {
    const result = requirePoolTradeMovement(
      await observePoolTradeMovement(
        context,
        AbortSignal.any([request.signal, AbortSignal.timeout(20000)]),
      ),
      context,
    );
    const after = await readContext(db, user.userId, input.id);
    if (
      !after ||
      after.revision !== row.revision ||
      after.archived ||
      after.address !== row.address ||
      after.document !== row.document ||
      after.tape !== row.tape
    )
      return json(
        {
          error:
            'Project or trade tape changed during inspection. Reload before checking again.',
        },
        409,
      );
    return json({ result });
  } catch (error) {
    return json(poolTradeMovementError(error), 502);
  }
}
