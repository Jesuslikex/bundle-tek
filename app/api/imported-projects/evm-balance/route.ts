import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getD1 } from '@/db';
import { evmChain } from '@/lib/evm-network';
import { observeEvmHoldings } from '@/lib/evm-holdings';
import { walletAddress } from '@/lib/wallet-workspace';
import type { ImportedTokenProject } from '@/lib/imported-token-project';
import type { ImportedEvmBalance } from '@/lib/imported-evm-balance';
export const dynamic = 'force-dynamic';
const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
function input(value: unknown) {
  const v = value as Record<string, unknown> | null;
  if (
    !v ||
    typeof v.id !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
      v.id,
    ) ||
    !Number.isSafeInteger(v.revision) ||
    Number(v.revision) < 1 ||
    Number(v.revision) >= 1000000000
  )
    throw new Error();
  return {
    id: v.id,
    revision: Number(v.revision),
    wallet: v.wallet,
    walletRevision: v.walletRevision,
  };
}
type Project = {
  chain: string;
  address: string;
  document: string;
  revision: number;
  archived: number;
};
const projectRow = (db: D1Database, owner: string, id: string) =>
  db
    .prepare(
      'SELECT chain,address,document,revision,archived FROM imported_token_projects WHERE owner_id=? AND id=?',
    )
    .bind(owner, id)
    .first<Project>();
const observations = async (db: D1Database, owner: string, id: string) =>
  (
    await db
      .prepare(
        'SELECT document FROM imported_evm_balances WHERE owner_id=? AND project_id=? ORDER BY observed_at DESC LIMIT 20',
      )
      .bind(owner, id)
      .all<{ document: string }>()
  ).results.map((r) => JSON.parse(r.document) as ImportedEvmBalance);
export async function GET(request: Request) {
  const user = await getChatGPTUser();
  if (!user)
    return json({ error: 'Sign in to read project wallet balances.' }, 401);
  let query;
  try {
    const p = new URL(request.url).searchParams;
    query = input({ id: p.get('id'), revision: Number(p.get('revision')) });
  } catch {
    return json({ error: 'Choose an imported project revision.' }, 400);
  }
  try {
    const db = getD1(),
      project = await projectRow(db, user.userId, query.id);
    if (!project) return json({ error: 'Imported project not found.' }, 404);
    if (project.revision !== query.revision)
      return json({ error: 'Project changed. Reload imported projects.' }, 409);
    try {
      evmChain(project.chain);
    } catch {
      return json({ error: 'Choose an EVM project.' }, 400);
    }
    return json({
      id: query.id,
      revision: query.revision,
      observations: await observations(db, user.userId, query.id),
      executionAllowed: false,
    });
  } catch {
    return json({ error: 'Project balance storage unavailable.' }, 503);
  }
}
export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user)
    return json({ error: 'Sign in to check project wallet balances.' }, 401);
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
  let query;
  try {
    const text = await request.text();
    if (text.length > 500) return json({ error: 'Request too large.' }, 413);
    query = input(JSON.parse(text));
    if (
      !Number.isSafeInteger(query.walletRevision) ||
      Number(query.walletRevision) < 1 ||
      Number(query.walletRevision) >= 1000000000
    )
      throw new Error();
  } catch {
    return json({ error: 'Choose current project and wallet revisions.' }, 400);
  }
  let db: D1Database, project: Project, address: string, prior: string | null;
  let chain: ReturnType<typeof evmChain>;
  try {
    db = getD1();
    const row = await projectRow(db, user.userId, query.id);
    if (!row) return json({ error: 'Imported project not found.' }, 404);
    if (row.revision !== query.revision || row.archived)
      return json({ error: 'Project changed or is archived.' }, 409);
    project = row;
    try {
      chain = evmChain(project.chain);
      address = walletAddress(query.wallet, chain);
    } catch {
      return json(
        { error: 'Choose a wallet on the project EVM network.' },
        400,
      );
    }
    const wallet = await db
      .prepare(
        'SELECT revision,archived FROM workspace_wallets WHERE owner_id=? AND chain=? AND address=?',
      )
      .bind(user.userId, chain, address)
      .first<{ revision: number; archived: number }>();
    if (!wallet) return json({ error: 'Saved wallet not found.' }, 404);
    if (wallet.archived || wallet.revision !== query.walletRevision)
      return json(
        { error: 'Wallet changed or is archived. Reload wallets.' },
        409,
      );
    prior =
      (
        await db
          .prepare(
            'SELECT document FROM imported_evm_balances WHERE owner_id=? AND project_id=? AND wallet_address=?',
          )
          .bind(user.userId, query.id, address)
          .first<{ document: string }>()
      )?.document ?? null;
    const now = Date.now();
    const gate = await db
      .prepare(
        'INSERT INTO wallet_balance_gates(owner_id,next_allowed_at) VALUES (?,?) ON CONFLICT(owner_id) DO UPDATE SET next_allowed_at=excluded.next_allowed_at WHERE wallet_balance_gates.next_allowed_at<=?',
      )
      .bind(user.userId, now + 15000, now)
      .run();
    if (!gate.meta.changes)
      return json({ error: 'Wait 15 seconds between wallet reads.' }, 429);
  } catch {
    return json({ error: 'Project wallet storage unavailable.' }, 503);
  }
  let report: ImportedEvmBalance;
  try {
    const snapshot = await observeEvmHoldings(
      { chain, address, contracts: [project.address] },
      AbortSignal.any([request.signal, AbortSignal.timeout(25000)]),
    );
    const token = (
      JSON.parse(project.document) as ImportedTokenProject['document']
    ).token;
    if (
      snapshot.chain !== chain ||
      snapshot.address !== address ||
      snapshot.holdings.length !== 1 ||
      snapshot.holdings[0].contract !== project.address ||
      snapshot.holdings[0].decimals !== token.decimals
    )
      return json(
        {
          error:
            'Token identity changed or balance context differs. Refresh project identity before retrying.',
        },
        409,
      );
    report = {
      projectRevision: query.revision,
      walletRevision: Number(query.walletRevision),
      snapshot,
    };
    if (
      prior &&
      (JSON.parse(prior) as ImportedEvmBalance).snapshot.blockNumber >
        snapshot.blockNumber
    )
      return json(
        { error: 'Balance block regressed. Saved observation retained.' },
        409,
      );
  } catch {
    return json(
      {
        error:
          'Token balance provider unavailable. Saved observations retained.',
      },
      502,
    );
  }
  try {
    const result = await db
      .prepare(`INSERT INTO imported_evm_balances(owner_id,project_id,wallet_address,document,observed_at)
    SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM imported_token_projects WHERE owner_id=? AND id=? AND revision=? AND archived=0)
    AND EXISTS(SELECT 1 FROM workspace_wallets WHERE owner_id=? AND chain=? AND address=? AND revision=? AND archived=0)
    AND (?='' AND NOT EXISTS(SELECT 1 FROM imported_evm_balances WHERE owner_id=? AND project_id=? AND wallet_address=?) OR EXISTS(SELECT 1 FROM imported_evm_balances WHERE owner_id=? AND project_id=? AND wallet_address=? AND document=?))
    AND (EXISTS(SELECT 1 FROM imported_evm_balances WHERE owner_id=? AND project_id=? AND wallet_address=?) OR (SELECT COUNT(*) FROM imported_evm_balances WHERE owner_id=? AND project_id=?)<20)
    ON CONFLICT(owner_id,project_id,wallet_address) DO UPDATE SET document=excluded.document,observed_at=excluded.observed_at WHERE imported_evm_balances.observed_at<excluded.observed_at`)
      .bind(
        user.userId,
        query.id,
        address,
        JSON.stringify(report),
        report.snapshot.observedAt,
        user.userId,
        query.id,
        query.revision,
        user.userId,
        chain,
        address,
        query.walletRevision,
        prior ?? '',
        user.userId,
        query.id,
        address,
        user.userId,
        query.id,
        address,
        prior ?? '',
        user.userId,
        query.id,
        address,
        user.userId,
        query.id,
      )
      .run();
    if (!result.meta.changes)
      return json(
        {
          error:
            'Project, wallet or saved balances changed, or the 20-wallet limit was reached. Reload before retrying.',
        },
        409,
      );
    return json({
      id: query.id,
      revision: query.revision,
      observations: await observations(db, user.userId, query.id),
      executionAllowed: false,
    });
  } catch {
    return json(
      { error: 'Could not retain balance. Previous observations retained.' },
      503,
    );
  }
}
