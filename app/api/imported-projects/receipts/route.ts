import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getD1 } from '@/db';
import { UUID } from '@/lib/wallet-operation';
import { walletAddress } from '@/lib/wallet-workspace';
import {
  IMPORTED_LEDGER_LIMIT,
  importedTradeReceipt,
  summarizeImportedTrades,
  importedTradeCsv,
  type ImportedTradeReceipt,
} from '@/lib/imported-trade-ledger';
import { importedTradePerformance } from '@/lib/imported-trade-performance';
export const dynamic = 'force-dynamic';
const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { 'cache-control': 'no-store' } });
export async function GET(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return json({ error: 'Sign in to view finalized trades.' }, 401);
  const params = new URL(request.url).searchParams,
    projectId = params.get('projectId'),
    cursor = params.get('cursor'),
    format = params.get('format');
  if (
    !projectId ||
    !UUID.test(projectId) ||
    (cursor !== null && !UUID.test(cursor)) ||
    (format !== null && format !== 'csv') ||
    (format === 'csv' && cursor !== null)
  )
    return json(
      { error: 'Choose a project and valid trade history cursor.' },
      400,
    );
  try {
    const db = getD1();
    const project = await db
      .prepare(
        'SELECT document FROM imported_token_projects WHERE owner_id=? AND id=?',
      )
      .bind(user.userId, projectId)
      .first<{ document: string }>();
    if (!project) return json({ error: 'Imported project unavailable.' }, 404);
    const token = JSON.parse(project.document).token as {
      chain: string;
      address: string;
      decimals: number;
    };
    if (token?.chain !== 'Solana')
      return json(
        { error: 'Finalized swap history is available for Solana imports.' },
        409,
      );
    walletAddress(token.address, 'Solana');
    if (
      !Number.isInteger(token.decimals) ||
      token.decimals < 0 ||
      token.decimals > 255
    )
      throw new Error();
    const result = await db
      .prepare(`SELECT r.id,r.project_id AS projectId,r.preparation_id AS preparationId,r.project_revision AS projectRevision,r.wallet_revision AS walletRevision,r.created_at AS createdAt,
   json_object('network',json_extract(r.document,'$.network'),'mint',json_extract(r.document,'$.mint'),'decimals',json_extract(r.document,'$.decimals'),'preparationSha256',json_extract(r.document,'$.preparationSha256'),'signature',json_extract(r.document,'$.signature'),'wallet',json_extract(r.document,'$.wallet'),'signatureVerified',json_extract(r.document,'$.signatureVerified'),'commitment',json_extract(r.document,'$.commitment'),'side',json_extract(r.document,'$.side'),'tokenUnitsRaw',json_extract(r.document,'$.tokenUnitsRaw'),'source',json_extract(r.document,'$.source'),'observedAt',json_extract(r.document,'$.observedAt'),'slot',json_extract(r.document,'$.slot'),'blockTime',json_extract(r.document,'$.blockTime'),'networkFeeLamports',json_extract(r.document,'$.networkFeeLamports'),'nativeChangeRaw',json_extract(r.document,'$.nativeChangeRaw'),'rentChangeRaw',json_extract(r.document,'$.rentChangeRaw'),'nativeSettlementRaw',json_extract(r.document,'$.nativeSettlementRaw')) AS document
   FROM imported_swap_receipts r WHERE r.owner_id=? AND r.project_id=? ORDER BY r.created_at DESC,r.id DESC LIMIT ?`)
      .bind(user.userId, projectId, IMPORTED_LEDGER_LIMIT + 1)
      .all<Omit<ImportedTradeReceipt, 'document'> & { document: string }>();
    if (result.results.length > IMPORTED_LEDGER_LIMIT)
      return json(
        {
          error:
            'Trade history exceeds the complete ledger limit. No partial totals are shown.',
        },
        503,
      );
    const receipts = result.results.map((row) => {
      const document = JSON.parse(row.document);
      document.signatureVerified = document.signatureVerified === 1;
      return importedTradeReceipt(
        { ...row, document },
        projectId,
        token.address,
        token.decimals,
      );
    });
    const summary = summarizeImportedTrades(receipts);
    if (format === 'csv')
      return new Response(importedTradeCsv(receipts), {
        headers: {
          'content-type': 'text/csv; charset=utf-8',
          'cache-control': 'no-store',
          'content-disposition': `attachment; filename="imported-trades-${projectId}.csv"`,
        },
      });
    const anchor = cursor ? receipts.findIndex((row) => row.id === cursor) : -1;
    if (cursor && anchor === -1)
      return json({ error: 'Trade history cursor unavailable.' }, 400);
    const page = receipts.slice(anchor + 1, anchor + 51);
    return json({
      projectId,
      mint: token.address,
      decimals: token.decimals,
      receipts: page,
      nextCursor:
        anchor + 1 + page.length < receipts.length ? page.at(-1)!.id : null,
      summary,
      performance: importedTradePerformance(receipts),
      observedAt: new Date().toISOString(),
    });
  } catch {
    return json(
      {
        error:
          'Finalized trade history unavailable. No partial totals are shown.',
      },
      503,
    );
  }
}
