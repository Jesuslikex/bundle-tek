import { validateProjectDocument } from './workspace-project';
import { quoteCatalog, validateQuoteSelection } from './quote-catalog';
import { artworkIdValid } from './artwork';
import { buildSavedPumpCreateComponent } from './pump-launch-preparation';
import {
  simulatePumpCreate,
  type PumpLaunchRpc,
} from './pump-launch-simulation';

export type OwnedPumpTerms = {
  projectId: string;
  updatedAt: string;
  releaseId: string;
  origin: string;
  payer: string;
  payerRevision: number;
  mint: string;
  feeAndRentLimitRaw: string;
};
export class PumpPreflightError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
type Row = {
  document: string;
  updated_at: string;
  archived: number;
  walletRevision: number;
  walletFolderId: string;
  walletFolderIds: string | null;
  selectedFolderId: string | null;
  folderRevision: number | null;
  folderArchived: number | null;
  folderChain: string | null;
};

/** Authenticated callers supply owner from the session, never from request JSON. */
export async function preflightOwnedPumpCreate(
  db: D1Database,
  owner: string,
  terms: OwnedPumpTerms,
  signal: AbortSignal,
  options: { rpc?: PumpLaunchRpc; beforeRpc?: () => Promise<void> } = {},
) {
  const t = structuredClone(terms),
    origin = new URL(t.origin);
  if (
    !artworkIdValid(t.releaseId) ||
    origin.protocol !== 'https:' ||
    origin.origin !== t.origin ||
    !Number.isSafeInteger(t.payerRevision) ||
    t.payerRevision < 1
  )
    throw new PumpPreflightError(
      'Review a saved project, payer and public metadata release.',
      400,
    );
  const read = () =>
    db
      .prepare(`SELECT p.document,p.updated_at,p.archived,w.revision AS walletRevision,w.folder_id AS walletFolderId,w.folder_ids AS walletFolderIds,
    f.id AS selectedFolderId,f.revision AS folderRevision,f.archived AS folderArchived,f.chain AS folderChain
    FROM workspace_projects p JOIN launch_metadata_releases m ON m.owner_id=p.owner_id AND m.project_id=p.id AND m.id=?
    JOIN workspace_wallets w ON w.owner_id=p.owner_id AND w.chain='Solana' AND w.address=? AND w.revision=? AND w.archived=0
    LEFT JOIN wallet_folders f ON f.owner_id=w.owner_id AND f.id=COALESCE(json_extract(p.document,'$.options.wallets.deployer.folderId'),w.folder_id)
    WHERE p.owner_id=? AND p.id=? AND EXISTS(SELECT 1 FROM wallet_ownership_proofs o WHERE o.owner_id=w.owner_id AND o.chain='Solana' AND o.address=w.address)`)
      .bind(t.releaseId, t.payer, t.payerRevision, owner, t.projectId)
      .first<Row>();
  const check = (row: Row | null) => {
    if (!row)
      throw new PumpPreflightError(
        'Owned project, released metadata or verified payer is unavailable.',
        404,
      );
    if (row.archived || row.updated_at !== t.updatedAt)
      throw new PumpPreflightError(
        'Reload and review the current active project.',
        409,
      );
    const doc = validateProjectDocument(JSON.parse(row.document)),
      deployer = doc.options.wallets?.deployer;
    if (doc.plan.chain !== 'Solana' || doc.plan.launchpad !== 'PumpFun')
      throw new PumpPreflightError(
        'Choose a PumpFun launch. StonkFun needs its own adapter.',
        400,
      );
    if (
      !deployer ||
      doc.options.wallets?.chain !== 'Solana' ||
      deployer.address !== t.payer ||
      deployer.revision !== t.payerRevision
    )
      throw new PumpPreflightError(
        'Save this exact verified payer as the launch deployer.',
        409,
      );
    const ids: unknown =
      row.walletFolderIds === null
        ? row.walletFolderId
          ? [row.walletFolderId]
          : []
        : JSON.parse(row.walletFolderIds);
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string'))
      throw new PumpPreflightError('Reload the wallet folder selection.', 409);
    const folderMatches =
      deployer.root === true ||
      (deployer.folderRevision === 0 && deployer.folderId === undefined
        ? ids.length === 0
        : row.folderChain === 'Solana' &&
          row.folderArchived === 0 &&
          row.folderRevision === deployer.folderRevision &&
          row.selectedFolderId === (deployer.folderId ?? row.walletFolderId) &&
          ids.includes(row.selectedFolderId));
    if (!folderMatches)
      throw new PumpPreflightError(
        'The selected deployer folder changed. Select it again.',
        409,
      );
    validateQuoteSelection(doc.plan);
    const quotes = quoteCatalog('Solana', 'PumpFun').assets.filter(
      (q) =>
        q.symbol === doc.plan.currency &&
        (!doc.plan.quoteAddress || q.address === doc.plan.quoteAddress),
    );
    if (quotes.length !== 1)
      throw new PumpPreflightError('Select one exact quote mint.', 409);
    return { row, doc, quote: quotes[0] };
  };
  const original = check(await read());
  if (signal.aborted)
    throw new PumpPreflightError('Pump preflight was cancelled.', 409);
  await options.beforeRpc?.();
  const intent = {
    name: original.doc.plan.tokenName,
    symbol: original.doc.plan.ticker,
    uri: `${t.origin}/api/launch/metadata/${t.releaseId}`,
    payer: t.payer,
    mint: t.mint,
    quoteMint: original.quote.address,
  };
  const reviewed = await simulatePumpCreate(
    intent,
    t.feeAndRentLimitRaw,
    signal,
    options.rpc,
  );
  const observed = await read();
  if (
    !observed ||
    JSON.stringify(observed) !== JSON.stringify(original.row) ||
    signal.aborted
  )
    throw new PumpPreflightError(
      'The project, payer proof or folder changed during simulation.',
      409,
    );
  check(observed);
  const component = await buildSavedPumpCreateComponent(db, owner, {
    projectId: t.projectId,
    updatedAt: t.updatedAt,
    releaseId: t.releaseId,
    origin: t.origin,
    context: reviewed.context,
  });
  if (component.packetSha256 !== reviewed.preparation.packetSha256)
    throw new PumpPreflightError(
      'Saved metadata or quote changed during preflight.',
      409,
    );
  const final = check(await read());
  if (
    JSON.stringify(final.row) !== JSON.stringify(original.row) ||
    signal.aborted
  )
    throw new PumpPreflightError(
      'The project, payer proof or folder changed. Review again.',
      409,
    );
  return {
    format: 'pump-create-preflight-v1' as const,
    executionAllowed: false as const,
    signingAllowed: false as const,
    completeLaunch: false as const,
    containsInitialBuy: false as const,
    network: 'mainnet' as const,
    projectId: t.projectId,
    projectUpdatedAt: t.updatedAt,
    payer: t.payer,
    payerRevision: t.payerRevision,
    mint: t.mint,
    metadataReleaseId: t.releaseId,
    metadataUri: component.metadataUri,
    requestedDeveloperBuy: component.requestedDeveloperBuy,
    requestedHoldersBuy: component.requestedHoldersBuy,
    requestedHoldersBuyQuote: component.requestedHoldersBuyQuote,
    quote: {
      mint: component.quoteMint,
      source: component.quote.source,
      tokenProgram: component.quote.tokenProgram,
      decimals: component.quote.decimals,
      tokenSupplyRaw: component.quote.tokenSupplyRaw,
      extensions: component.quote.extensions,
    },
    packet: {
      transaction: component.transaction,
      sha256: component.packetSha256,
      bytes: component.packetBytes,
      lastValidBlockHeight: component.lastValidBlockHeight,
    },
    simulation: reviewed.simulation,
  };
}
