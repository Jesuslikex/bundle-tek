import bs58 from 'bs58';
import { validSolanaSigningKey } from './solana-signature';
import { validateProjectDocument } from './workspace-project';
import {
  buildPumpHolderTargets,
  type PumpHolderObservation,
} from './pump-holder-targets';
import { PumpPreflightError } from './owned-pump-preflight';
type Terms = {
  projectId: string;
  updatedAt: string;
  observation: PumpHolderObservation;
};
type WalletRow = {
  slot: number;
  revision: number;
  folderId: string;
  folderIds: string | null;
  selectedFolderId: string | null;
  folderRevision: number | null;
  folderArchived: number | null;
  folderChain: string | null;
};

/** Read-only owned holder manifest. Caller must recheck its binding around simulation and approval. */
export async function readOwnedPumpHolderWallets(
  db: D1Database,
  owner: string,
  supplied: Pick<Terms, 'projectId' | 'updatedAt'>,
) {
  const terms = structuredClone(supplied);
  const read = () =>
    db
      .prepare(
        'SELECT document,updated_at,archived FROM workspace_projects WHERE owner_id=? AND id=?',
      )
      .bind(owner, terms.projectId)
      .first<{ document: string; updated_at: string; archived: number }>();
  const project = await read();
  if (!project || project.archived || project.updated_at !== terms.updatedAt)
    throw new PumpPreflightError('Reload the active owned holder launch.', 409);
  const document = validateProjectDocument(JSON.parse(project.document));
  const selection = document.options.wallets;
  if (
    document.plan.chain !== 'Solana' ||
    document.plan.launchpad !== 'PumpFun' ||
    document.plan.scheduled ||
    !selection ||
    selection.chain !== 'Solana' ||
    !selection.deployer ||
    selection.recipients.length !== document.plan.holderCount
  )
    throw new PumpPreflightError(
      'Save the complete unscheduled Pump holder wallet selection.',
      409,
    );
  const refs = selection.recipients;
  for (const ref of refs)
    if (!validSolanaSigningKey(bs58.decode(ref.address)))
      throw new PumpPreflightError(
        'Select valid holder signing identities.',
        409,
      );
  const wallets = async () => {
    const { results } = await db
      .prepare(`SELECT CAST(r.key AS INTEGER) AS slot,w.revision,w.folder_id AS folderId,w.folder_ids AS folderIds,
      f.id AS selectedFolderId,f.revision AS folderRevision,f.archived AS folderArchived,f.chain AS folderChain
      FROM json_each(?) r JOIN workspace_wallets w ON w.owner_id=? AND w.chain='Solana' AND w.role='Recipient'
      AND w.address=json_extract(r.value,'$.address') AND w.revision=json_extract(r.value,'$.revision') AND w.archived=0
      LEFT JOIN wallet_folders f ON f.owner_id=w.owner_id AND f.id=COALESCE(json_extract(r.value,'$.folderId'),w.folder_id)
      WHERE EXISTS(SELECT 1 FROM wallet_ownership_proofs o WHERE o.owner_id=w.owner_id AND o.chain=w.chain AND o.address=w.address)
      ORDER BY slot`)
      .bind(JSON.stringify(refs), owner)
      .all<WalletRow>();
    if (results.length !== refs.length)
      throw new PumpPreflightError(
        'Every saved holder slot needs its exact active owned wallet revision.',
        409,
      );
    for (const row of results) {
      const ref = refs[row.slot];
      const ids: unknown =
        row.folderIds === null
          ? row.folderId
            ? [row.folderId]
            : []
          : JSON.parse(row.folderIds);
      if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string'))
        throw new PumpPreflightError('Reload holder wallet folders.', 409);
      if (
        ref.root !== true &&
        !(ref.folderRevision === 0 && ref.folderId === undefined
          ? ids.length === 0
          : row.folderChain === 'Solana' &&
            row.folderArchived === 0 &&
            row.folderRevision === ref.folderRevision &&
            row.selectedFolderId === (ref.folderId ?? row.folderId) &&
            ids.includes(row.selectedFolderId))
      )
        throw new PumpPreflightError(
          'A selected holder folder changed. Select it again.',
          409,
        );
    }
    return results;
  };
  const rows = await wallets();
  if (
    JSON.stringify(await read()) !== JSON.stringify(project) ||
    JSON.stringify(await wallets()) !== JSON.stringify(rows)
  )
    throw new PumpPreflightError(
      'Holder project or selection changed while reading.',
      409,
    );
  const binding = JSON.stringify({ project, refs, rows });
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(binding)),
  );
  return {
    projectId: terms.projectId,
    projectUpdatedAt: terms.updatedAt,
    document,
    bindingSha256: Array.from(digest, (b) =>
      b.toString(16).padStart(2, '0'),
    ).join(''),
    signingAllowed: false as const,
    executionAllowed: false as const,
  };
}

export async function readOwnedPumpHolderSelection(
  db: D1Database,
  owner: string,
  supplied: Terms,
) {
  const terms = structuredClone(supplied);
  const wallets = await readOwnedPumpHolderWallets(db, owner, terms);
  const targets = buildPumpHolderTargets(wallets.document, terms.observation);
  const bytes = new Uint8Array(
    await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(
        JSON.stringify({ walletBinding: wallets.bindingSha256, targets }),
      ),
    ),
  );
  return {
    projectId: wallets.projectId,
    projectUpdatedAt: wallets.projectUpdatedAt,
    targets,
    bindingSha256: Array.from(bytes, (b) =>
      b.toString(16).padStart(2, '0'),
    ).join(''),
    signingAllowed: false as const,
    executionAllowed: false as const,
  };
}
