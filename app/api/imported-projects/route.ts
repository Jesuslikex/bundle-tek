import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getD1 } from '@/db';
import { inspectToken } from '@/lib/token-import';
import { validateTokenSource } from '@/lib/token-source';
import {
  importedTokenDocument,
  importedTradeSettings,
  type ImportedTokenDocument,
  type ImportedTradeSettings,
} from '@/lib/imported-token-project';
export const dynamic = 'force-dynamic';
const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
type Row = {
  id: string;
  chain: string;
  address: string;
  revision: number;
  archived: number;
  document: string;
  updatedAt: string;
};
const parse = (row: Row) => ({
  id: row.id,
  revision: row.revision,
  archived: Boolean(row.archived),
  updatedAt: row.updatedAt,
  document: JSON.parse(row.document),
});
export async function GET() {
  const user = await getChatGPTUser();
  if (!user)
    return json({ error: 'Sign in to open imported token projects.' }, 401);
  try {
    const rows = await getD1()
      .prepare(
        'SELECT id,chain,address,revision,archived,document,updated_at AS updatedAt FROM imported_token_projects WHERE owner_id=? ORDER BY updated_at DESC,id LIMIT 100',
      )
      .bind(user.userId)
      .all<Row>();
    return json({ projects: rows.results.map(parse) });
  } catch {
    return json({ error: 'Imported project storage unavailable.' }, 503);
  }
}
export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return json({ error: 'Sign in to import a token.' }, 401);
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
  let body: Record<string, unknown>;
  try {
    const text = await request.text();
    if (text.length > 2048)
      return json({ error: 'Import request too large.' }, 413);
    body = JSON.parse(text);
    if (
      !body ||
      !['import', 'refresh', 'archive', 'restore', 'settings'].includes(
        String(body.action),
      )
    )
      throw new Error();
    if (
      body.action !== 'import' &&
      (typeof body.id !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
          body.id,
        ) ||
        !Number.isSafeInteger(body.expectedRevision) ||
        Number(body.expectedRevision) < 1 ||
        Number(body.expectedRevision) > 1000000000)
    )
      throw new Error();
    if (body.action === 'import') validateTokenSource(body);
  } catch {
    return json(
      { error: 'Choose a token or current saved project revision.' },
      400,
    );
  }
  try {
    const db = getD1();
    const read = (id: string) =>
      db
        .prepare(
          'SELECT id,chain,address,revision,archived,document,updated_at AS updatedAt FROM imported_token_projects WHERE owner_id=? AND id=?',
        )
        .bind(user.userId, id)
        .first<Row>();
    const existing =
      body.action === 'import' ? null : await read(String(body.id));
    if (body.action !== 'import' && !existing)
      return json({ error: 'Imported token project not found.' }, 404);
    if (
      existing &&
      (existing.revision !== body.expectedRevision ||
        Boolean(existing.archived) !== (body.action === 'restore'))
    )
      return json(
        { error: 'Project changed or is archived. Reload and try again.' },
        409,
      );
    const source = existing
      ? validateTokenSource(existing)
      : validateTokenSource(body);
    if (!existing) {
      const duplicate = await db
        .prepare(
          'SELECT id FROM imported_token_projects WHERE owner_id=? AND chain=? AND address=?',
        )
        .bind(user.userId, source.chain, source.address)
        .first();
      if (duplicate)
        return json(
          {
            error:
              'This token is already imported. Open or restore its saved project.',
          },
          409,
        );
    }
    let document = existing?.document ?? '';
    let settings: ImportedTradeSettings | undefined;
    if (body.action === 'settings' && existing) {
      const previous = JSON.parse(existing.document) as ImportedTokenDocument;
      try {
        settings = importedTradeSettings(body.settings, previous.token);
      } catch {
        return json(
          { error: 'Choose an exact amount and active Solana wallet.' },
          400,
        );
      }
      const wallet = await db
        .prepare(
          "SELECT revision FROM workspace_wallets WHERE owner_id=? AND chain='Solana' AND address=? AND revision=? AND archived=0",
        )
        .bind(user.userId, settings.wallet, settings.walletRevision)
        .first();
      if (!wallet)
        return json(
          { error: 'Wallet changed or is unavailable. Reload trade wallets.' },
          409,
        );
      document = JSON.stringify({ ...previous, tradeSettings: settings });
    }
    if (body.action === 'import' || body.action === 'refresh') {
      const now = Date.now();
      const gate = await db
        .prepare(
          'INSERT INTO imported_token_project_gates(owner_id,next_allowed_at) VALUES (?,?) ON CONFLICT(owner_id) DO UPDATE SET next_allowed_at=excluded.next_allowed_at WHERE imported_token_project_gates.next_allowed_at<=?',
        )
        .bind(user.userId, now + 15000, now)
        .run();
      if (!gate.meta.changes)
        return json(
          { error: 'Wait 15 seconds between token identity reads.' },
          429,
        );
      try {
        const identity = importedTokenDocument(
          source,
          await inspectToken(source),
        );
        const previous = existing
          ? (JSON.parse(existing.document) as ImportedTokenDocument)
          : undefined;
        document = JSON.stringify({
          ...identity,
          ...(previous?.tradeSettings
            ? {
                tradeSettings: importedTradeSettings(
                  previous.tradeSettings,
                  identity.token,
                ),
              }
            : {}),
        });
      } catch {
        return json(
          {
            error:
              'Token identity lookup unavailable. No imported project was changed.',
          },
          502,
        );
      }
    }
    const id = existing?.id ?? crypto.randomUUID(),
      mutation = crypto.randomUUID(),
      now = new Date().toISOString();
    const write = !existing
      ? db
          .prepare(
            'INSERT INTO imported_token_projects(owner_id,id,chain,address,document,mutation_id,updated_at) SELECT ?,?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM imported_token_projects WHERE owner_id=?)<100 ON CONFLICT DO NOTHING',
          )
          .bind(
            user.userId,
            id,
            source.chain,
            source.address,
            document,
            mutation,
            now,
            user.userId,
          )
      : db
          .prepare(
            "UPDATE imported_token_projects SET document=?,revision=revision+1,archived=?,mutation_id=?,updated_at=? WHERE owner_id=? AND id=? AND revision=? AND archived=? AND (?=0 OR EXISTS (SELECT 1 FROM workspace_wallets w WHERE w.owner_id=? AND w.chain='Solana' AND w.address=? AND w.revision=? AND w.archived=0))",
          )
          .bind(
            document,
            body.action === 'archive' ? 1 : 0,
            mutation,
            now,
            user.userId,
            id,
            existing.revision,
            existing.archived,
            settings ? 1 : 0,
            user.userId,
            settings?.wallet ?? '',
            settings?.walletRevision ?? 0,
          );
    const results = await db.batch([
      write,
      db
        .prepare(
          'INSERT INTO imported_token_project_events(id,owner_id,project_id,type,revision,document,created_at) SELECT ?,owner_id,id,?,revision,document,? FROM imported_token_projects WHERE owner_id=? AND id=? AND mutation_id=?',
        )
        .bind(
          crypto.randomUUID(),
          `project.${String(body.action)}`,
          now,
          user.userId,
          id,
          mutation,
        ),
    ]);
    if (!results[0].meta.changes)
      return json(
        {
          error:
            'Project changed, was already imported or the 100-project limit was reached. Reload and try again.',
        },
        409,
      );
    const saved = await read(id);
    return json({ project: saved ? parse(saved) : null });
  } catch {
    return json(
      {
        error:
          'Imported project storage unavailable. Reload to check its state.',
      },
      503,
    );
  }
}
