import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getD1 } from '@/db';
import { importedWalletInventory } from '@/lib/imported-wallet-inventory';
import type { ImportedTokenProject } from '@/lib/imported-token-project';
import type { HoldingsSnapshot } from '@/lib/wallet-holdings';
import { importedMintInventory } from '@/lib/imported-mint-inventory';
import type { MintHoldingsSnapshot } from '@/lib/wallet-mint-holdings';
export const dynamic = 'force-dynamic';
const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
export async function GET(request: Request) {
  const user = await getChatGPTUser();
  if (!user)
    return json({ error: 'Sign in to review project inventory.' }, 401);
  const params = new URL(request.url).searchParams,
    id = params.get('id'),
    revision = params.get('revision'),
    mintScope = params.get('scope') === 'mint';
  if (
    !id ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
      id,
    ) ||
    !revision ||
    !/^[1-9]\d{0,15}$/.test(revision) ||
    !Number.isSafeInteger(Number(revision)) ||
    params.getAll('id').length !== 1 ||
    params.getAll('revision').length !== 1 ||
    params.getAll('scope').length > 1 ||
    (params.has('scope') && !mintScope) ||
    [...params.keys()].some((k) => !['id', 'revision', 'scope'].includes(k))
  )
    return json({ error: 'Choose a current project revision.' }, 400);
  try {
    const db = getD1();
    const result = await db.batch<{
      document: string | null;
      address: string;
      revision: number;
      totalBytes: number;
    }>([
      db
        .prepare(
          "SELECT document FROM imported_token_projects WHERE owner_id=? AND id=? AND revision=? AND chain='Solana' AND archived=0",
        )
        .bind(user.userId, id, Number(revision)),
      db
        .prepare(
          mintScope
            ? "WITH inventory AS (SELECT w.address,w.revision,s.document,COALESCE(SUM(LENGTH(CAST(s.document AS BLOB))) OVER (),0) AS totalBytes FROM workspace_wallets w LEFT JOIN wallet_mint_holdings_snapshots s ON s.owner_id=w.owner_id AND s.chain=w.chain AND s.address=w.address AND s.mint=(SELECT json_extract(document,'$.token.address') FROM imported_token_projects WHERE owner_id=?1 AND id=?2 AND revision=?3 AND chain='Solana' AND archived=0) WHERE w.owner_id=?1 AND w.chain='Solana' AND w.archived=0) SELECT address,revision,totalBytes,CASE WHEN totalBytes<=8388608 THEN document ELSE NULL END AS document FROM inventory ORDER BY address LIMIT 501"
            : "WITH inventory AS (SELECT w.address,w.revision,s.document,COALESCE(SUM(LENGTH(CAST(s.document AS BLOB))) OVER (),0) AS totalBytes FROM workspace_wallets w LEFT JOIN wallet_holdings_snapshots s ON s.owner_id=w.owner_id AND s.chain=w.chain AND s.address=w.address WHERE w.owner_id=? AND w.chain='Solana' AND w.archived=0) SELECT address,revision,totalBytes,CASE WHEN totalBytes<=8388608 THEN document ELSE NULL END AS document FROM inventory ORDER BY address LIMIT 501",
        )
        .bind(user.userId, ...(mintScope ? [id, Number(revision)] : [])),
    ]);
    if (result[0].results.length !== 1)
      return json(
        {
          error:
            'Project changed, is archived or unavailable. Reload projects.',
        },
        409,
      );
    if (result[1].results.length > 500) throw new Error();
    if (
      result[1].results.some(
        (row) =>
          !Number.isSafeInteger(row.totalBytes) ||
          row.totalBytes < 0 ||
          row.totalBytes > 8388608,
      )
    )
      throw new Error();
    const token = (
      JSON.parse(
        String(result[0].results[0].document),
      ) as ImportedTokenProject['document']
    ).token;
    if (token.chain !== 'Solana') throw new Error();
    const items = result[1].results.map((row) =>
      (mintScope && row.document
        ? importedMintInventory
        : importedWalletInventory)(
        row.document
          ? (JSON.parse(String(row.document)) as HoldingsSnapshot &
              MintHoldingsSnapshot)
          : null,
        String(row.address),
        Number(row.revision),
        token.address,
        token.decimals,
      ),
    );
    return json({
      id,
      revision: Number(revision),
      mint: token.address,
      decimals: token.decimals,
      executionAllowed: false,
      items,
      checkedAt: new Date().toISOString(),
    });
  } catch {
    return json(
      {
        error:
          'Saved project inventory is incomplete or unavailable. No partial balances returned.',
      },
      503,
    );
  }
}
