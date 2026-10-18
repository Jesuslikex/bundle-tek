import { LaunchLayerError } from './launch-layer-service';
import {
  layerTargetSourceSchema,
  parseImportedLayerTargets,
} from './launch-layer-targets';
import { validateProjectDocument } from './workspace-project';
type Source = {
  id: string;
  document: string;
  updated_at: string;
  archived: number;
};
type Target = {
  id: string;
  revision: number;
  chain: string;
  address: string;
  archived: number;
  format: string;
  executionAllowed: number;
  tokenChain: string;
  tokenAddress: string;
  name: string;
  symbol: string;
};
export async function listImportedLayerTargets(
  db: D1Database,
  owner: string,
  value: unknown,
) {
  const parsed = layerTargetSourceSchema.safeParse(value);
  if (!parsed.success)
    throw new LaunchLayerError('Choose the exact saved launch revision.', 400);
  const source = parsed.data;
  const read = () =>
    db
      .prepare(
        'SELECT id,document,updated_at,archived FROM workspace_projects WHERE owner_id=? AND id=?',
      )
      .bind(owner, source.projectId)
      .first<Source>();
  const row = await read();
  if (!row) throw new LaunchLayerError('Saved launch project not found.', 404);
  if (row.archived || row.updated_at !== source.projectUpdatedAt)
    throw new LaunchLayerError('Restore or reload the saved launch project.');
  const plan = validateProjectDocument(JSON.parse(row.document)).plan;
  if (
    plan.chain !== 'Solana' ||
    plan.mode !== 'Block-0' ||
    !['PumpFun', 'StonkFun'].includes(plan.launchpad) ||
    !plan.scheduled
  )
    throw new LaunchLayerError(
      'Save a scheduled Solana Block-0 launch before choosing an imported token.',
    );
  const rows = await db
    .prepare(
      `SELECT id,revision,chain,address,archived,json_extract(document,'$.format') AS format,json_extract(document,'$.executionAllowed') AS executionAllowed,json_extract(document,'$.token.chain') AS tokenChain,json_extract(document,'$.token.address') AS tokenAddress,json_extract(document,'$.token.name') AS name,json_extract(document,'$.token.symbol') AS symbol FROM imported_token_projects WHERE owner_id=? AND chain='Solana' AND archived=0 ORDER BY updated_at DESC,id LIMIT 101`,
    )
    .bind(owner)
    .all<Target>();
  const current = await read();
  if (
    !current ||
    current.archived ||
    current.updated_at !== row.updated_at ||
    current.document !== row.document
  )
    throw new LaunchLayerError(
      'Launch settings changed while loading tokens. Reload the saved launch.',
    );
  const items = rows.results.slice(0, 100).map((target) => {
    if (
      target.chain !== 'Solana' ||
      target.archived ||
      target.format !== 'imported-token-project-v1' ||
      target.executionAllowed !== 0 ||
      target.tokenChain !== 'Solana' ||
      target.tokenAddress !== target.address
    )
      throw new LaunchLayerError(
        'An imported token record is inconsistent. Refresh the imported token before planning.',
        503,
      );
    return {
      id: target.id,
      revision: target.revision,
      chain: 'Solana' as const,
      mint: target.address,
      name: target.name,
      symbol: target.symbol,
    };
  });
  try {
    return parseImportedLayerTargets(
      {
        ...source,
        items,
        hasMore: rows.results.length > 100,
        readOnly: true,
        fundingAllowed: false,
        signingAllowed: false,
        executionAllowed: false,
      },
      source,
    );
  } catch {
    throw new LaunchLayerError(
      'Imported token records could not be confirmed. Refresh them before planning.',
      503,
    );
  }
}
