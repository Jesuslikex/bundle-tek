import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getD1 } from '@/db';
import {
  folderId,
  walletFolderColor,
  DEFAULT_FOLDER_COLOR,
  walletChain,
  walletText,
  walletRole,
  walletTags,
  walletAddress,
  walletRevision,
  workspaceWalletBatch,
  MAX_WALLET_FOLDERS,
  MAX_WORKSPACE_WALLETS,
} from '@/lib/wallet-workspace';
export const dynamic = 'force-dynamic';
const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
export async function GET() {
  const user = await getChatGPTUser();
  if (!user)
    return json({ error: 'Sign in to open your wallet workspace.' }, 401);
  try {
    const db = getD1();
    const result = await db.batch<Record<string, unknown>>([
      db
        .prepare(
          'SELECT id,name,color,chain,archived,revision,updated_at AS updatedAt FROM wallet_folders WHERE owner_id=? ORDER BY name,id LIMIT 100',
        )
        .bind(user.userId),
      db
        .prepare(
          'SELECT chain,address,folder_id AS folderId,COALESCE(folder_ids,json_array(folder_id)) AS folderIds,label,tags,role,archived,revision,updated_at AS updatedAt FROM workspace_wallets WHERE owner_id=? ORDER BY updated_at DESC,address LIMIT 500',
        )
        .bind(user.userId),
      db
        .prepare(
          'SELECT document FROM wallet_balance_snapshots WHERE owner_id=? LIMIT 500',
        )
        .bind(user.userId),
      db
        .prepare(
          'SELECT chain,address,verified_at AS verifiedAt FROM wallet_ownership_proofs WHERE owner_id=? LIMIT 500',
        )
        .bind(user.userId),
    ]);
    return json({
      folders: result[0].results.map((r) => ({
        ...r,
        archived: Boolean(r.archived),
      })),
      wallets: result[1].results.map((r) => ({
        ...r,
        folderIds: JSON.parse(String(r.folderIds)),
        tags: walletTags(JSON.parse(String(r.tags))),
        archived: Boolean(r.archived),
      })),
      balances: result[2].results.map((r) => JSON.parse(String(r.document))),
      proofs: result[3].results,
    });
  } catch {
    return json({ error: 'Wallet workspace temporarily unavailable.' }, 503);
  }
}
export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return json({ error: 'Sign in to save wallets.' }, 401);
  if (
    !request.headers
      .get('content-type')
      ?.toLowerCase()
      .startsWith('application/json')
  )
    return json({ error: 'JSON required.' }, 415);
  if (
    request.headers.get('origin') &&
    request.headers.get('origin') !== new URL(request.url).origin
  )
    return json({ error: 'Cross-origin write rejected.' }, 403);
  let storage = false;
  try {
    const text = await request.text();
    if (text.length > 40_000) return json({ error: 'Request too large.' }, 413);
    const body = JSON.parse(text);
    const chain = walletChain(body.chain);
    const now = new Date().toISOString();
    const owner = user.userId;
    const db = getD1();
    let folderSnapshot = '[]';
    const changingFolderName = [
      'folder.create',
      'folder.update',
      'folder.rename',
    ].includes(body.action);
    if (changingFolderName) {
      const name = walletText(body.name, 'Folder name', 40, true);
      if (body.action !== 'folder.create') {
        folderId(body.id);
        walletRevision(body.revision);
      }
      if (body.color !== undefined || body.action === 'folder.update')
        walletFolderColor(body.color);
      storage = true;
      const existing = await db
        .prepare(
          'SELECT id,name,revision FROM wallet_folders WHERE owner_id=? AND chain=? LIMIT 100',
        )
        .bind(owner, chain)
        .all<{ id: string; name: string; revision: number }>();
      storage = false;
      if (
        existing.results.some(
          (folder) =>
            folder.id !==
              (body.action === 'folder.create' ? undefined : body.id) &&
            folder.name.toLowerCase() === name.toLowerCase(),
        )
      )
        return json({ error: 'A folder with this name already exists.' }, 409);
      folderSnapshot = JSON.stringify(
        existing.results.map(({ id, revision }) => ({ id, revision })),
      );
    }
    const folderNameGuard = `(SELECT COUNT(*) FROM wallet_folders WHERE owner_id=? AND chain=?)=json_array_length(?)
      AND (SELECT COUNT(*) FROM wallet_folders f JOIN json_each(?) snap ON f.id=json_extract(snap.value,'$.id') AND f.revision=json_extract(snap.value,'$.revision') WHERE f.owner_id=? AND f.chain=?)=json_array_length(?)`;
    const folderNameBindings = [
      owner,
      chain,
      folderSnapshot,
      folderSnapshot,
      owner,
      chain,
      folderSnapshot,
    ];
    let statement: D1PreparedStatement;
    if (body.action === 'folder.delete') {
      const id = folderId(body.id);
      const revision = walletRevision(body.revision);
      storage = true;
      const result = await db.batch([
        db
          .prepare(`WITH patches AS MATERIALIZED (
          SELECT w.address,(SELECT json_group_array(value) FROM json_each(COALESCE(w.folder_ids,CASE WHEN w.folder_id='' THEN '[]' ELSE json_array(w.folder_id) END)) WHERE value<>?) ids
          FROM workspace_wallets w WHERE w.owner_id=? AND w.chain=? AND (w.folder_id=? OR EXISTS(SELECT 1 FROM json_each(COALESCE(w.folder_ids,json_array(w.folder_id))) WHERE value=?))
        ) UPDATE workspace_wallets SET
          folder_ids=(SELECT ids FROM patches p WHERE p.address=workspace_wallets.address),
          folder_id=CASE WHEN folder_id<>? THEN folder_id ELSE COALESCE(json_extract((SELECT ids FROM patches p WHERE p.address=workspace_wallets.address),'$[0]'),'') END,
          revision=revision+1,updated_at=?
        WHERE owner_id=? AND chain=? AND address IN (SELECT address FROM patches)
          AND EXISTS(SELECT 1 FROM wallet_folders WHERE owner_id=? AND id=? AND chain=? AND revision=?)`)
          .bind(
            id,
            owner,
            chain,
            id,
            id,
            id,
            now,
            owner,
            chain,
            owner,
            id,
            chain,
            revision,
          ),
        db
          .prepare(
            'DELETE FROM wallet_folders WHERE owner_id=? AND id=? AND chain=? AND revision=?',
          )
          .bind(owner, id, chain, revision),
      ]);
      if (!result[1].meta.changes)
        return json(
          {
            error:
              'Folder changed or was already removed. Reload before deleting it.',
          },
          409,
        );
      return json({
        deleted: result[1].meta.changes,
        walletsUpdated: result[0].meta.changes,
      });
    } else if (body.action === 'folder.create') {
      const id = folderId(body.id);
      const name = walletText(body.name, 'Folder name', 40, true);
      const color =
        body.color === undefined
          ? DEFAULT_FOLDER_COLOR
          : walletFolderColor(body.color);
      statement = db
        .prepare(`INSERT OR IGNORE INTO wallet_folders (owner_id,id,name,color,chain,archived,revision,updated_at)
        SELECT ?,?,?,?,?,0,1,? WHERE (SELECT COUNT(*) FROM wallet_folders WHERE owner_id=?)<? AND ${folderNameGuard}`)
        .bind(
          owner,
          id,
          name,
          color,
          chain,
          now,
          owner,
          MAX_WALLET_FOLDERS,
          ...folderNameBindings,
        );
    } else if (
      [
        'folder.update',
        'folder.rename',
        'folder.archive',
        'folder.restore',
      ].includes(body.action)
    ) {
      const id = folderId(body.id);
      const revision = walletRevision(body.revision);
      statement =
        body.action === 'folder.rename' || body.action === 'folder.update'
          ? db
              .prepare(
                `UPDATE wallet_folders SET name=?,color=COALESCE(?,color),revision=revision+1,updated_at=? WHERE owner_id=? AND id=? AND chain=? AND revision=? AND ${folderNameGuard}`,
              )
              .bind(
                walletText(body.name, 'Folder name', 40, true),
                body.color === undefined && body.action === 'folder.rename'
                  ? null
                  : walletFolderColor(body.color),
                now,
                owner,
                id,
                chain,
                revision,
                ...folderNameBindings,
              )
          : db
              .prepare(
                'UPDATE wallet_folders SET archived=?,revision=revision+1,updated_at=? WHERE owner_id=? AND id=? AND chain=? AND revision=?',
              )
              .bind(
                body.action === 'folder.archive' ? 1 : 0,
                now,
                owner,
                id,
                chain,
                revision,
              );
    } else if (body.action === 'wallet.add') {
      const id =
        body.folderId === '' || body.folderId === undefined
          ? ''
          : folderId(body.folderId);
      const entries = workspaceWalletBatch(body.wallets, chain);
      statement = db
        .prepare(`WITH incoming AS (SELECT json_extract(value,'$.address') AS address,json_extract(value,'$.label') AS label,json_extract(value,'$.role') AS role,json_extract(value,'$.tags') AS tags FROM json_each(?)),
        fresh AS (SELECT * FROM incoming WHERE NOT EXISTS (SELECT 1 FROM workspace_wallets w WHERE w.owner_id=? AND w.chain=? AND w.address=incoming.address))
        INSERT INTO workspace_wallets (owner_id,chain,address,folder_id,folder_ids,label,role,tags,archived,revision,updated_at)
        SELECT ?,?,address,?,?,label,role,tags,0,1,? FROM fresh WHERE
        (?='' OR EXISTS (SELECT 1 FROM wallet_folders WHERE owner_id=? AND id=? AND chain=? AND archived=0))
        AND (SELECT COUNT(*) FROM workspace_wallets WHERE owner_id=?)+(SELECT COUNT(*) FROM fresh)<=?`)
        .bind(
          JSON.stringify(entries),
          owner,
          chain,
          owner,
          chain,
          id,
          JSON.stringify(id ? [id] : []),
          now,
          id,
          owner,
          id,
          chain,
          owner,
          MAX_WORKSPACE_WALLETS,
        );
    } else if (body.action === 'wallet.folder-toggle') {
      if (
        !Array.isArray(body.wallets) ||
        !body.wallets.length ||
        body.wallets.length > 100 ||
        typeof body.member !== 'boolean'
      )
        throw new Error(
          'Select 1 to 100 wallets and a folder membership state.',
        );
      const id = folderId(body.folder?.id),
        revision = walletRevision(body.folder?.revision);
      const wallets = body.wallets.map(
        (raw: { address: unknown; revision: unknown }) => ({
          address: walletAddress(raw?.address, chain),
          revision: walletRevision(raw?.revision),
        }),
      );
      if (
        new Set(wallets.map((w: { address: string }) => w.address)).size !==
        wallets.length
      )
        throw new Error('Remove duplicate selected wallets.');
      statement = db
        .prepare(`WITH selected AS (SELECT json_extract(value,'$.address') address,json_extract(value,'$.revision') revision FROM json_each(?)),
        eligible AS (SELECT w.* FROM workspace_wallets w JOIN selected s ON s.address=w.address AND s.revision=w.revision WHERE w.owner_id=? AND w.chain=? AND w.archived=0),
        membership AS (SELECT e.*,COALESCE(e.folder_ids,json_array(e.folder_id)) old_ids,EXISTS(SELECT 1 FROM json_each(COALESCE(e.folder_ids,json_array(e.folder_id))) WHERE value=?) has_member FROM eligible e),
        patches AS (SELECT m.address,has_member<>? changed,CASE WHEN has_member=? THEN old_ids WHEN ?=1 THEN json_insert(old_ids,'$[#]',?) ELSE (SELECT json_group_array(value) FROM json_each(old_ids) WHERE value<>?) END ids FROM membership m)
        UPDATE workspace_wallets SET folder_ids=(SELECT ids FROM patches p WHERE p.address=workspace_wallets.address),
          folder_id=CASE WHEN folder_id IN(SELECT value FROM json_each((SELECT ids FROM patches p WHERE p.address=workspace_wallets.address))) THEN folder_id ELSE COALESCE(json_extract((SELECT ids FROM patches p WHERE p.address=workspace_wallets.address),'$[0]'),'') END,
          revision=revision+(SELECT changed FROM patches p WHERE p.address=workspace_wallets.address),
          updated_at=CASE WHEN (SELECT changed FROM patches p WHERE p.address=workspace_wallets.address)=1 THEN ? ELSE updated_at END
        WHERE owner_id=? AND chain=? AND address IN(SELECT address FROM eligible)
        AND (SELECT COUNT(*) FROM eligible)=(SELECT COUNT(*) FROM selected)
        AND EXISTS(SELECT 1 FROM wallet_folders WHERE owner_id=? AND chain=? AND id=? AND revision=? AND archived=0)`)
        .bind(
          JSON.stringify(wallets),
          owner,
          chain,
          id,
          body.member ? 1 : 0,
          body.member ? 1 : 0,
          body.member ? 1 : 0,
          id,
          id,
          now,
          owner,
          chain,
          owner,
          chain,
          id,
          revision,
        );
    } else if (body.action === 'wallet.folders') {
      if (
        !Array.isArray(body.wallets) ||
        !body.wallets.length ||
        body.wallets.length > 100 ||
        !Array.isArray(body.folders) ||
        body.folders.length > 100
      )
        throw new Error('Select 1 to 100 wallets and up to 100 folders.');
      const wallets = body.wallets.map(
        (raw: { address: unknown; revision: unknown }) => ({
          address: walletAddress(raw?.address, chain),
          revision: walletRevision(raw?.revision),
        }),
      );
      const folders = body.folders.map(
        (raw: { id: unknown; revision: unknown }) => ({
          id: folderId(raw?.id),
          revision: walletRevision(raw?.revision),
        }),
      );
      if (
        new Set(wallets.map((w: { address: string }) => w.address)).size !==
          wallets.length ||
        new Set(folders.map((f: { id: string }) => f.id)).size !==
          folders.length
      )
        throw new Error('Remove duplicate wallets or folders.');
      statement = db
        .prepare(`WITH selected AS (SELECT json_extract(value,'$.address') address,json_extract(value,'$.revision') revision FROM json_each(?)),
        destinations AS (SELECT json_extract(value,'$.id') id,json_extract(value,'$.revision') revision FROM json_each(?)),
        eligible AS (SELECT w.address FROM workspace_wallets w JOIN selected s ON s.address=w.address AND s.revision=w.revision WHERE w.owner_id=? AND w.chain=? AND w.archived=0)
        UPDATE workspace_wallets SET folder_id=?,folder_ids=?,revision=revision+1,updated_at=? WHERE owner_id=? AND chain=? AND address IN(SELECT address FROM eligible)
        AND (SELECT COUNT(*) FROM eligible)=(SELECT COUNT(*) FROM selected)
        AND (SELECT COUNT(*) FROM destinations d JOIN wallet_folders f ON f.id=d.id AND f.revision=d.revision WHERE f.owner_id=? AND f.chain=? AND f.archived=0)=(SELECT COUNT(*) FROM destinations)`)
        .bind(
          JSON.stringify(wallets),
          JSON.stringify(folders),
          owner,
          chain,
          folders[0]?.id ?? '',
          JSON.stringify(folders.map((f: { id: string }) => f.id)),
          now,
          owner,
          chain,
          owner,
          chain,
        );
    } else if (body.action === 'wallet.edit') {
      const address = walletAddress(body.address, chain);
      const id =
        body.folderId === '' || body.folderId === undefined
          ? ''
          : folderId(body.folderId);
      statement = db
        .prepare(`UPDATE workspace_wallets SET label=?,role=?,tags=CASE WHEN ? THEN ? ELSE tags END,folder_id=?,folder_ids=CASE WHEN folder_id=? THEN folder_ids ELSE CASE WHEN ?='' THEN json('[]') ELSE json_array(?) END END,revision=revision+1,updated_at=? WHERE owner_id=? AND chain=? AND address=? AND revision=? AND archived=0
        AND (folder_id=? OR ?='' OR EXISTS (SELECT 1 FROM wallet_folders WHERE owner_id=? AND id=? AND chain=? AND archived=0))`)
        .bind(
          walletText(body.label, 'Label', 60),
          walletRole(body.role),
          body.tags !== undefined ? 1 : 0,
          JSON.stringify(body.tags === undefined ? [] : walletTags(body.tags)),
          id,
          id,
          id,
          id,
          now,
          owner,
          chain,
          address,
          walletRevision(body.revision),
          id,
          id,
          owner,
          id,
          chain,
        );
    } else if (
      ['wallet.move', 'wallet.archive', 'wallet.restore'].includes(body.action)
    ) {
      if (
        !Array.isArray(body.wallets) ||
        !body.wallets.length ||
        body.wallets.length > 100
      )
        throw new Error('Select between 1 and 100 wallets.');
      const entries = body.wallets.map(
        (raw: { address?: unknown; revision?: unknown }) => ({
          address: walletAddress(raw?.address, chain),
          revision: walletRevision(raw?.revision),
        }),
      );
      if (
        new Set(entries.map((w: { address: string }) => w.address)).size !==
        entries.length
      )
        throw new Error('Remove duplicate selected wallets.');
      const moving = body.action === 'wallet.move';
      const id = moving ? folderId(body.folderId) : '';
      // A single statement changes the entire selected set only if every revision
      // still matches. Folder eligibility is checked inside that same statement.
      statement = db
        .prepare(`WITH selected AS (SELECT json_extract(value,'$.address') AS address,json_extract(value,'$.revision') AS revision FROM json_each(?)),
        eligible AS (SELECT w.address FROM workspace_wallets w JOIN selected s ON s.address=w.address AND s.revision=w.revision WHERE w.owner_id=? AND w.chain=?)
        UPDATE workspace_wallets SET ${moving ? 'folder_id=?,folder_ids=json_array(?)' : 'archived=?'},revision=revision+1,updated_at=? WHERE owner_id=? AND chain=? AND address IN (SELECT address FROM eligible)
        AND (SELECT COUNT(*) FROM eligible)=(SELECT COUNT(*) FROM selected)
        ${moving ? 'AND archived=0 AND NOT EXISTS (SELECT 1 FROM workspace_wallets w JOIN selected s ON s.address=w.address WHERE w.owner_id=? AND w.chain=? AND w.archived=1) AND EXISTS (SELECT 1 FROM wallet_folders WHERE owner_id=? AND id=? AND chain=? AND archived=0)' : ''}
`)
        .bind(
          JSON.stringify(entries),
          owner,
          chain,
          moving ? id : body.action === 'wallet.archive' ? 1 : 0,
          ...(moving ? [id] : []),
          now,
          owner,
          chain,
          ...(moving ? [owner, chain, owner, id, chain] : []),
        );
    } else throw new Error('Invalid wallet workspace action.');
    storage = true;
    const result = await statement.run();
    if (!result.meta.changes)
      return json(
        {
          error:
            'Nothing changed. Reload to check revisions, duplicates, archived folders and account limits.',
        },
        409,
      );
    return json({ changed: result.meta.changes });
  } catch (error) {
    return storage
      ? json({ error: 'Wallet storage temporarily unavailable.' }, 503)
      : json(
          {
            error:
              error instanceof Error
                ? error.message
                : 'Invalid wallet request.',
          },
          400,
        );
  }
}
