import { buildMarketplaceControlEvidence } from './marketplace-control-evidence';
import { operatorListingSelection } from './marketplace-operator-review';
import { MarketplaceSaleInspectionChangedError } from './marketplace-sale-inspection';
/** One owned SELECT only. Callers must authenticate and authorize the operator. No writes or provider/key access. */
export async function readMarketplaceControlEvidence(
  db: D1Database,
  owner: string,
  input: unknown,
  siteOrigin: string,
  signal: AbortSignal,
  now?: number,
) {
  const selection = operatorListingSelection.parse(input);
  if (typeof owner !== 'string' || owner.length < 1 || owner.length > 128)
    throw Error('Choose a verified seller identity.');
  signal.throwIfAborted();
  const row = await db
    .prepare(`SELECT w.address,w.revision,w.updated_at AS walletUpdatedAt,
 p.verified_at AS proofVerifiedAt,p.challenge_id AS proofChallengeId,c.id AS challengeId,
 c.message,c.expires_at AS challengeExpiresAt,c.used_at AS usedAt,c.claim_id AS claimId
 FROM workspace_wallets w
 LEFT JOIN wallet_ownership_proofs p ON p.owner_id=w.owner_id AND p.chain=w.chain AND p.address=w.address
 LEFT JOIN wallet_ownership_challenges c ON c.id=p.challenge_id AND c.owner_id=p.owner_id AND c.chain=p.chain AND c.address=p.address
 WHERE w.owner_id=? AND w.chain='Solana' AND w.address=? AND w.revision=? AND w.archived=0`)
    .bind(owner, selection.address, selection.walletRevision)
    .first();
  signal.throwIfAborted();
  if (!row)
    throw new MarketplaceSaleInspectionChangedError(
      'Seller wallet changed. Reload inventory.',
    );
  const result = await buildMarketplaceControlEvidence(
    row,
    selection,
    siteOrigin,
    now ?? Date.now(),
  );
  signal.throwIfAborted();
  return result;
}
