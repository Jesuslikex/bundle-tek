import { z } from 'zod';
import { parseLaunchLayerHistory } from './launch-layer-history';
import { validateProjectDocument, projectIdValid } from './workspace-project';
import {
  createLaunchLayerTerms,
  verifyLaunchLayerTerms,
  parseLaunchLayerRequest,
  type LaunchLayerContext,
  type LaunchLayerEnvelope,
  type LaunchLayerRequest,
} from './launch-layer-terms';
import {
  walletAddress,
  type WalletWorkspace,
  type WorkspaceWallet,
  type WalletFolder,
} from './wallet-workspace';

export class LaunchLayerError extends Error {
  constructor(
    message: string,
    readonly status = 409,
  ) {
    super(message);
  }
}
const fail = (message: string, status = 409): never => {
  throw new LaunchLayerError(message, status);
};
const id = z.string().refine(projectIdValid),
  stamp = z
    .string()
    .refine(
      (s) => Number.isFinite(Date.parse(s)) && new Date(s).toISOString() === s,
    );
const publicKey = z.string().refine((s) => {
  try {
    return (
      walletAddress(s, 'Solana') === s &&
      s !== '11111111111111111111111111111111'
    );
  } catch {
    return false;
  }
});
const target = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('new'), mint: publicKey }).strict(),
  z
    .object({
      kind: z.literal('imported'),
      projectId: id,
      revision: z.number().int().positive(),
    })
    .strict(),
]);
const selection = z
  .object({ projectId: id, projectUpdatedAt: stamp, target })
  .strict();
const input = selection.extend({ layers: z.unknown() }).strict();
type Selection = z.infer<typeof selection>;
type Source = {
  id: string;
  document: string;
  updated_at: string;
  archived: number;
};
type Imported = {
  id: string;
  chain: string;
  address: string;
  document: string;
  revision: number;
  archived: number;
};
type Snapshot = {
  format: 'owned-launch-layer-plan-v1';
  sourceDocument: string;
  selection: Selection;
  context: LaunchLayerContext;
  targetDocument: string | null;
  envelope: LaunchLayerEnvelope;
};
type Row = {
  id: string;
  owner_id: string;
  project_id: string;
  project_revision: string;
  source_document: string;
  document: string;
  sha256: string;
  created_at: string;
};
const parse = <T>(schema: z.ZodType<T>, value: unknown) => {
  const p = schema.safeParse(value);
  return p.success
    ? p.data
    : fail('Choose an exact saved project, target and layer plan.', 400);
};
const hash = async (text: string) =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)),
    ),
    (b) => b.toString(16).padStart(2, '0'),
  ).join('');
const members = (layers: LaunchLayerRequest) => [
  layers.roles.funder,
  ...(layers.roles.developer ? [layers.roles.developer] : []),
  ...layers.roles.front,
  ...layers.roles.back,
  ...layers.roles.temporary,
  ...layers.roles.holders,
];
const referenceKey = (ref: LaunchLayerRequest['roles']['funder']['wallet']) =>
  JSON.stringify([
    ref.address,
    ref.revision,
    ref.folderRevision,
    ref.folderId ?? null,
    ref.root === true,
  ]);

async function load(db: D1Database, owner: string, s: Selection) {
  const source = await db
    .prepare(
      'SELECT id,document,updated_at,archived FROM workspace_projects WHERE owner_id=? AND id=?',
    )
    .bind(owner, s.projectId)
    .first<Source>();
  if (!source) return fail('Saved launch project not found.', 404);
  if (source.archived || source.updated_at !== s.projectUpdatedAt)
    return fail('Restore or reload the current saved launch project.');
  let imported: Imported | null = null;
  if (s.target.kind === 'imported') {
    imported = await db
      .prepare(
        'SELECT id,chain,address,document,revision,archived FROM imported_token_projects WHERE owner_id=? AND id=?',
      )
      .bind(owner, s.target.projectId)
      .first<Imported>();
    if (!imported) return fail('Owned imported target not found.', 404);
    const token = (
      JSON.parse(imported.document) as {
        token?: { chain?: string; address?: string };
      }
    ).token;
    if (
      imported.archived ||
      imported.revision !== s.target.revision ||
      imported.chain !== 'Solana' ||
      token?.chain !== 'Solana' ||
      token.address !== imported.address
    )
      return fail('Restore or reload the current Solana imported target.');
    publicKey.parse(imported.address);
  }
  const results = await db.batch<Record<string, unknown>>([
    db
      .prepare(
        "SELECT chain,address,folder_id AS folderId,COALESCE(folder_ids,iif(folder_id='',json('[]'),json_array(folder_id))) AS folderIds,revision,archived,updated_at AS updatedAt,label,role FROM workspace_wallets WHERE owner_id=? AND chain='Solana' ORDER BY address LIMIT 501",
      )
      .bind(owner),
    db
      .prepare(
        "SELECT id,chain,name,revision,archived,updated_at AS updatedAt FROM wallet_folders WHERE owner_id=? AND chain='Solana' ORDER BY id LIMIT 101",
      )
      .bind(owner),
  ]);
  if (results[0].results.length > 500 || results[1].results.length > 100)
    return fail('Wallet workspace exceeds the supported planning bounds.');
  const workspace: WalletWorkspace = {
    wallets: results[0].results.map((r) => ({
      ...r,
      archived: Boolean(r.archived),
      folderIds: JSON.parse(String(r.folderIds)),
    })) as WorkspaceWallet[],
    folders: results[1].results.map((r) => ({
      ...r,
      archived: Boolean(r.archived),
    })) as WalletFolder[],
  };
  const document = validateProjectDocument(JSON.parse(source.document));
  const context: LaunchLayerContext = {
    ownerId: owner,
    savedPlan: { ...document.plan, updatedAt: source.updated_at },
    workspace,
    target: {
      kind: s.target.kind,
      mint:
        imported?.address ??
        (s.target.kind === 'new'
          ? s.target.mint
          : fail('Imported target is unavailable.')),
    },
  };
  return {
    source,
    document,
    context,
    targetDocument: imported?.document ?? null,
  };
}

/** Roster membership is account ownership, not proof of control or funding readiness. */
export async function readLaunchLayerContext(
  db: D1Database,
  owner: string,
  value: unknown,
) {
  const s = parse(selection, value),
    loaded = await load(db, owner, s);
  return {
    projectId: s.projectId,
    projectUpdatedAt: s.projectUpdatedAt,
    document: loaded.document,
    workspace: loaded.context.workspace,
    target: loaded.context.target,
    fundingAllowed: false as const,
    signingAllowed: false as const,
    executionAllowed: false as const,
  };
}
export async function saveOwnedLaunchLayerPlan(
  db: D1Database,
  owner: string,
  value: unknown,
  now = Date.now,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const s = parse(input, structuredClone(value));
  let layers: LaunchLayerRequest;
  try {
    layers = parseLaunchLayerRequest(s.layers);
  } catch {
    return fail('Review exact per-wallet layer ceilings and delays.', 400);
  }
  const selected: Selection = {
    projectId: s.projectId,
    projectUpdatedAt: s.projectUpdatedAt,
    target: s.target,
  };
  const loaded = await load(db, owner, selected),
    assigned = loaded.document.options.wallets;
  if (
    !assigned ||
    assigned.chain !== 'Solana' ||
    JSON.stringify(assigned.recipients.map(referenceKey)) !==
      JSON.stringify(layers.roles.holders.map((m) => referenceKey(m.wallet))) ||
    (s.target.kind === 'new' &&
      (!assigned.deployer ||
        !layers.roles.developer ||
        referenceKey(assigned.deployer) !==
          referenceKey(layers.roles.developer.wallet)))
  )
    return fail(
      'Save the same developer and complete ordered holder selection in the launch project first.',
    );
  let envelope: LaunchLayerEnvelope;
  try {
    envelope = await createLaunchLayerTerms(layers, loaded.context);
  } catch (error) {
    return fail(
      error instanceof Error ? error.message : 'Layer terms are invalid.',
    );
  }
  const refs = members(layers).map((m) => m.wallet),
    addresses = new Set(refs.map((r) => r.address));
  const wallets = loaded.context.workspace.wallets
    .filter((w) => addresses.has(w.address))
    .map((w) => ({ ...w, label: '', role: 'Recipient' as const }));
  const folders = new Set(
    refs
      .filter((r) => r.folderRevision > 0)
      .map(
        (r) =>
          r.folderId ?? wallets.find((w) => w.address === r.address)!.folderId,
      ),
  );
  const context: LaunchLayerContext = {
    ...loaded.context,
    workspace: {
      wallets,
      folders: loaded.context.workspace.folders
        .filter((f) => folders.has(f.id))
        .map((f) => ({ ...f, name: '' })),
    },
  };
  const snapshot: Snapshot = {
    format: 'owned-launch-layer-plan-v1',
    sourceDocument: loaded.source.document,
    selection: selected,
    context,
    targetDocument: loaded.targetDocument,
    envelope,
  };
  const document = JSON.stringify(snapshot),
    sha256 = await hash(document);
  if (new TextEncoder().encode(document).byteLength > 524288)
    return fail('Layer snapshot is too large.', 413);
  const recordId = crypto.randomUUID(),
    createdAt = new Date(now()).toISOString();
  signal?.throwIfAborted();
  try {
    await db
      .prepare(
        'INSERT INTO launch_layer_plans(id,owner_id,project_id,project_revision,source_document,document,sha256,created_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(owner_id,project_id,sha256) DO NOTHING',
      )
      .bind(
        recordId,
        owner,
        s.projectId,
        s.projectUpdatedAt,
        loaded.source.document,
        document,
        sha256,
        createdAt,
      )
      .run();
  } catch {
    let capacity: { n: number; existing: number } | null;
    try {
      capacity = await db
        .prepare(
          'SELECT count(*) AS n,coalesce(max(sha256=?),0) AS existing FROM launch_layer_plans WHERE owner_id=? AND project_id=?',
        )
        .bind(sha256, owner, s.projectId)
        .first<{ n: number; existing: number }>();
    } catch {
      return fail(
        'Launch layer storage is unavailable. Complete the storage setup before saving.',
        503,
      );
    }
    if (capacity && capacity.n >= 100 && !capacity.existing)
      return fail(
        'This project already has 100 retained layer plans. Existing plans remain readable.',
      );
    return fail(
      'Layer plan was not saved. Reload the project, target and selected wallets before trying again; nothing was funded.',
    );
  }
  const saved = await db
    .prepare(
      'SELECT * FROM launch_layer_plans WHERE owner_id=? AND project_id=? AND sha256=?',
    )
    .bind(owner, s.projectId, sha256)
    .first<Row>();
  if (!saved) return fail('Layer plan could not be retained.', 503);
  return decode(db, owner, saved);
}
async function decode(db: D1Database, owner: string, row: Row) {
  let snapshot: Snapshot;
  try {
    snapshot = JSON.parse(row.document) as Snapshot;
    if (
      snapshot.format !== 'owned-launch-layer-plan-v1' ||
      snapshot.context.ownerId !== owner ||
      snapshot.selection.projectId !== row.project_id ||
      snapshot.selection.projectUpdatedAt !== row.project_revision ||
      snapshot.context.savedPlan.updatedAt !== row.project_revision ||
      snapshot.sourceDocument !== row.source_document ||
      (await hash(row.document)) !== row.sha256
    )
      throw new Error('Saved layer snapshot differs.');
    await verifyLaunchLayerTerms(snapshot.envelope, snapshot.context);
    const source = validateProjectDocument(JSON.parse(row.source_document));
    if (
      JSON.stringify(source.plan) !==
      snapshot.envelope.terms.binding.savedPlanJson
    )
      throw new Error('Saved source plan differs.');
    if (
      snapshot.selection.target.kind !== snapshot.context.target.kind ||
      (snapshot.selection.target.kind === 'new' &&
        snapshot.selection.target.mint !== snapshot.context.target.mint)
    )
      throw new Error('Saved target context differs.');
    const assigned = source.options.wallets,
      roles = snapshot.envelope.terms.roles;
    if (
      !assigned ||
      JSON.stringify(assigned.recipients.map(referenceKey)) !==
        JSON.stringify(roles.holders.map((m) => referenceKey(m.wallet))) ||
      (snapshot.selection.target.kind === 'new' &&
        (!assigned.deployer ||
          !roles.developer ||
          referenceKey(assigned.deployer) !==
            referenceKey(roles.developer.wallet)))
    )
      throw new Error('Saved role assignment differs.');
  } catch {
    return fail('Saved layer plan is inconsistent.', 503);
  }
  let current = false;
  try {
    const loaded = await load(db, owner, snapshot.selection);
    if (
      loaded.source.document === row.source_document &&
      loaded.targetDocument === snapshot.targetDocument
    ) {
      await verifyLaunchLayerTerms(snapshot.envelope, loaded.context);
      current = true;
    }
  } catch (error) {
    if (error instanceof LaunchLayerError && error.status === 503) throw error;
  }
  return {
    id: row.id,
    projectId: row.project_id,
    projectUpdatedAt: row.project_revision,
    createdAt: row.created_at,
    sha256: row.sha256,
    envelope: snapshot.envelope,
    current,
    planningOnly: true as const,
    fundingAllowed: false as const,
    signingAllowed: false as const,
    executionAllowed: false as const,
  };
}
export async function readOwnedLaunchLayerPlan(
  db: D1Database,
  owner: string,
  projectId: string,
  recordId?: string,
) {
  if (
    !projectIdValid(projectId) ||
    (recordId !== undefined && !z.uuid().safeParse(recordId).success)
  )
    return fail('Choose an owned saved layer plan.', 400);
  const row = await db
    .prepare(
      'SELECT * FROM launch_layer_plans WHERE owner_id=? AND project_id=?' +
        (recordId ? ' AND id=?' : '') +
        ' ORDER BY created_at DESC,id DESC LIMIT 1',
    )
    .bind(owner, projectId, ...(recordId ? [recordId] : []))
    .first<Row>();
  if (!row) {
    if (recordId) return fail('Saved layer plan not found.', 404);
    const owned = await db
      .prepare('SELECT id FROM workspace_projects WHERE owner_id=? AND id=?')
      .bind(owner, projectId)
      .first();
    if (!owned) return fail('Saved launch project not found.', 404);
    return null;
  }
  return decode(db, owner, row);
}

/** Bounded metadata index only. Opening a record still verifies its full snapshot. */
export async function listOwnedLaunchLayerPlans(
  db: D1Database,
  owner: string,
  projectId: string,
) {
  if (!projectIdValid(projectId))
    return fail('Choose an owned saved launch project.', 400);
  const owned = await db
    .prepare('SELECT id FROM workspace_projects WHERE owner_id=? AND id=?')
    .bind(owner, projectId)
    .first();
  if (!owned) return fail('Saved launch project not found.', 404);
  const rows = await db
    .prepare(`SELECT id,project_revision,created_at,sha256,
    json_extract(document,'$.envelope.terms.binding.target.kind') AS target_kind,
    json_extract(document,'$.envelope.terms.binding.target.mint') AS target_mint
    FROM launch_layer_plans WHERE owner_id=? AND project_id=? ORDER BY created_at DESC,id DESC LIMIT 101`)
    .bind(owner, projectId)
    .all<{
      id: string;
      project_revision: string;
      created_at: string;
      sha256: string;
      target_kind: string;
      target_mint: string;
    }>();
  try {
    return parseLaunchLayerHistory(
      {
        projectId,
        items: rows.results.map((row) => ({
          id: row.id,
          projectUpdatedAt: row.project_revision,
          createdAt: row.created_at,
          sha256: row.sha256,
          target: { kind: row.target_kind, mint: row.target_mint },
        })),
        complete: true,
        planningOnly: true,
        fundingAllowed: false,
        signingAllowed: false,
        executionAllowed: false,
      },
      projectId,
    );
  } catch {
    return fail(
      'Saved planning history is inconsistent. No snapshot was opened.',
      503,
    );
  }
}
