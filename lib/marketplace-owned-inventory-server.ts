import { buildMarketplaceOwnedInventory } from './marketplace-owned-inventory';

/** One owned database snapshot; no provider reads, grants, listings or key material. */
export async function readMarketplaceOwnedInventory(
  db: D1Database,
  owner: string,
  signal: AbortSignal,
  now?: number,
) {
  signal.throwIfAborted();
  const queries = [
    db
      .prepare(
        "SELECT address,label,revision,updated_at AS updatedAt FROM workspace_wallets WHERE owner_id=? AND chain='Solana' AND archived=0 ORDER BY address LIMIT 501",
      )
      .bind(owner),
    db
      .prepare(
        "SELECT p.address,p.verified_at AS verifiedAt FROM wallet_ownership_proofs p JOIN workspace_wallets w ON w.owner_id=p.owner_id AND w.chain=p.chain AND w.address=p.address WHERE p.owner_id=? AND p.chain='Solana' AND w.archived=0 ORDER BY p.address LIMIT 501",
      )
      .bind(owner),
    db
      .prepare(
        "SELECT h.id,h.revision,h.created_at AS createdAt,h.updated_at AS updatedAt,h.document FROM warmup_history_runs h WHERE h.owner_id=? AND json_extract(h.document,'$.chain')='Solana' AND EXISTS(SELECT 1 FROM json_each(h.document,'$.wallets') j JOIN workspace_wallets w ON w.owner_id=h.owner_id AND w.chain='Solana' AND w.address=json_extract(j.value,'$.address') AND w.archived=0) ORDER BY h.created_at,h.id LIMIT 101",
      )
      .bind(owner),
    db
      .prepare(
        "SELECT r.address,count(*) AS receiptCount,count(DISTINCT r.signature) AS uniqueSignatures FROM (SELECT wallet_address AS address,signature FROM warmup_buy_receipts WHERE owner_id=? UNION ALL SELECT json_extract(document,'$.wallet') AS address,signature FROM warmup_sell_receipts WHERE owner_id=?) r JOIN workspace_wallets w ON w.owner_id=? AND w.chain='Solana' AND w.address=r.address AND w.archived=0 GROUP BY r.address ORDER BY r.address LIMIT 501",
      )
      .bind(owner, owner, owner),
  ];
  const rows = await db.batch(queries);
  signal.throwIfAborted();
  return buildMarketplaceOwnedInventory(
    {
      wallets: rows[0].results,
      proofs: rows[1].results,
      runs: rows[2].results,
      receipts: rows[3].results,
    },
    now ?? Date.now(),
  );
}
