import type { PoolTradeMovementContext } from './pool-trade-movement';
import type { PoolTrades } from './pool-trades';
import type { ImportedTokenDocument } from './imported-token-project';
import { walletAddress } from './wallet-workspace';
import { transactionSignature } from './tracked-wallet-transaction';
export type PoolTradeSelection = {
  id: string;
  revision: number;
  pool: string;
  tradeId: string;
  tapeObservedAt: string;
};
export type PoolContextRow = {
  address: string;
  revision: number;
  archived: number;
  document: string;
  tape: string | null;
};
export function readPoolTradeContext(
  db: D1Database,
  owner: string,
  id: string,
) {
  return db
    .prepare(
      "SELECT p.address,p.revision,p.archived,p.document,m.document AS tape FROM imported_token_projects p LEFT JOIN imported_pool_trades m ON m.owner_id=p.owner_id AND m.project_id=p.id WHERE p.owner_id=? AND p.id=? AND p.chain='Solana'",
    )
    .bind(owner, id)
    .first<PoolContextRow>();
}
export function selectedPoolTradeContext(
  row: PoolContextRow,
  input: PoolTradeSelection,
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
