import {
  tradeSessionWriteGuard,
  type TradeSessionGuard,
} from './imported-trade-session-server';
import type { SwapFailureReceipt } from './swap-failure';
import type { SavedSwapPreparation } from './imported-swap-preparation-history';
import type { WarmupSigningReview } from './warmup-signing';
import {
  conditionalSigningWriteGuard,
  type ConditionalPreparationGuard,
} from './conditional-preparation-server';
import {
  validatedConditionalSigning,
  sameConditionalTerms,
} from './conditional-signing';
import {
  importedAcquisitionWriteGuard,
  type ImportedAcquisitionGuard,
} from './imported-acquisition-server';
export type ImportedSwapApproval = {
  id: string;
  preparationId: string;
  wallet: string;
  state: string;
  signature: string | null;
  failureReceipt?: SwapFailureReceipt | null;
  document: WarmupSigningReview;
  createdAt: string;
  updatedAt: string;
};
export async function currentImportedPreparation(
  db: D1Database,
  owner: string,
  id: string,
) {
  return db
    .prepare(
      `SELECT s.id,s.project_id AS projectId,s.project_revision AS projectRevision,s.wallet_revision AS walletRevision,s.created_at AS createdAt,s.document FROM imported_swap_preparations s JOIN imported_token_projects p ON p.owner_id=s.owner_id AND p.id=s.project_id AND p.revision=s.project_revision JOIN workspace_wallets w ON w.owner_id=s.owner_id AND w.chain='Solana' AND w.address=s.wallet_address AND w.revision=s.wallet_revision WHERE s.owner_id=? AND s.id=? AND p.chain='Solana' AND p.archived=0 AND w.archived=0 AND json_extract(s.document,'$.wallet')=s.wallet_address AND p.address=CASE json_extract(s.document,'$.side') WHEN 'Buy' THEN json_extract(s.document,'$.outputMint') WHEN 'Sell' THEN json_extract(s.document,'$.inputMint') END`,
    )
    .bind(owner, id)
    .first<Omit<SavedSwapPreparation, 'document'> & { document: string }>();
}
export { verifyExactSwapSignature } from './exact-swap-signature';
export async function reserveImportedApproval(
  db: D1Database,
  owner: string,
  captured: { id: string; document: string },
  review: WarmupSigningReview,
  acquisitionGuard?: ImportedAcquisitionGuard,
  conditionalGuard?: ConditionalPreparationGuard,
  sessionGuard?: TradeSessionGuard,
) {
  const session = JSON.parse(captured.document).session;
  if (
    JSON.stringify(session) !== JSON.stringify(review.session) ||
    JSON.stringify(session) !== JSON.stringify(sessionGuard?.selection)
  )
    throw new Error('Trade session approval binding differs.');
  const sessionWrite = tradeSessionWriteGuard(owner, sessionGuard);
  const conditional = JSON.parse(captured.document).conditional;
  if (
    JSON.stringify(conditional) !== JSON.stringify(review.conditional) ||
    Boolean(conditional) !== Boolean(conditionalGuard)
  )
    throw new Error('Conditional approval binding differs.');
  if (conditional) {
    validatedConditionalSigning(conditional, review.inputRaw, Date.now());
    if (!sameConditionalTerms(conditional, conditionalGuard!.selection))
      throw new Error('Conditional approval terms differ.');
    validatedConditionalSigning(
      conditionalGuard!.selection,
      review.inputRaw,
      Date.now(),
    );
  }
  if (
    JSON.stringify(review.acquisition) !==
    JSON.stringify(acquisitionGuard?.selection)
  )
    throw new Error('Approved acquisition differs.');
  const now = new Date().toISOString(),
    text = JSON.stringify(review),
    sourceGuard = importedAcquisitionWriteGuard(owner, acquisitionGuard);
  const conditionGuard = conditionalSigningWriteGuard(
    owner,
    conditionalGuard ? JSON.parse(conditionalGuard.document).projectId : '',
    conditionalGuard,
  );
  if (text.length > 8192)
    throw new Error('Approval capture exceeds the retained document limit.');
  // The shared reservation trigger commits with this context-checked insert.
  return db
    .prepare(
      `INSERT OR IGNORE INTO imported_swap_signing_intents(id,owner_id,preparation_id,wallet_address,document,state,created_at,updated_at) SELECT ?,?,?,?,?, 'awaiting_signature',?,? WHERE EXISTS(SELECT 1 FROM imported_swap_preparations s JOIN imported_token_projects p ON p.owner_id=s.owner_id AND p.id=s.project_id AND p.revision=s.project_revision JOIN workspace_wallets w ON w.owner_id=s.owner_id AND w.chain='Solana' AND w.address=s.wallet_address AND w.revision=s.wallet_revision WHERE s.owner_id=? AND s.id=? AND s.document=? AND p.chain='Solana' AND p.archived=0 AND w.archived=0 AND json_extract(s.document,'$.wallet')=s.wallet_address AND p.address=CASE json_extract(s.document,'$.side') WHEN 'Buy' THEN json_extract(s.document,'$.outputMint') WHEN 'Sell' THEN json_extract(s.document,'$.inputMint') END) AND ?>? AND NOT EXISTS(SELECT 1 FROM solana_swap_reservations WHERE owner_id=? AND wallet_address=?)${sourceGuard.sql}${conditionGuard.sql}${sessionWrite.sql}`,
    )
    .bind(
      review.id,
      owner,
      captured.id,
      review.wallet,
      text,
      now,
      now,
      owner,
      captured.id,
      captured.document,
      Date.parse(review.expiresAt),
      Date.now(),
      owner,
      review.wallet,
      ...sourceGuard.bindings,
      ...conditionGuard.bindings,
      ...sessionWrite.bindings,
    )
    .run();
}
