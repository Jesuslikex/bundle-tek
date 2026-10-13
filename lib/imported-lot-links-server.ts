import {
  importedLotPage,
  IMPORTED_LOT_LINK_LIMIT,
  type ImportedLotLink,
} from './imported-lot-links';
import {
  IMPORTED_LEDGER_LIMIT,
  importedTradeReceipt,
  type ImportedTradeReceipt,
} from './imported-trade-ledger';
import {
  jitoPerformanceCosts,
  jitoPerformanceStatement,
  jitoCostStorageAvailable,
  type JitoPerformanceRow,
} from './jito-performance-costs';
import { emptyBundleExpenses } from './bundle-expenses';
const fields = [
  'network',
  'mint',
  'decimals',
  'preparationSha256',
  'signature',
  'wallet',
  'signatureVerified',
  'commitment',
  'side',
  'tokenUnitsRaw',
  'source',
  'observedAt',
  'slot',
  'blockTime',
  'networkFeeLamports',
  'nativeChangeRaw',
  'rentChangeRaw',
  'nativeSettlementRaw',
];
type Stored = Omit<ImportedTradeReceipt, 'document'> & { document: string };
export async function importedAcquisitionSnapshot(
  db: D1Database,
  owner: string,
  projectId: string,
  includeExpenses = false,
) {
  const expenseStorage =
    includeExpenses && (await jitoCostStorageAvailable(db));
  const statements = [
    db
      .prepare(
        'SELECT document FROM imported_token_projects WHERE owner_id=? AND id=?',
      )
      .bind(owner, projectId),
    db
      .prepare(
        'SELECT id,project_id AS projectId,preparation_id AS preparationId,project_revision AS projectRevision,wallet_revision AS walletRevision,created_at AS createdAt,document FROM imported_swap_receipts WHERE owner_id=? AND project_id=? LIMIT ?',
      )
      .bind(owner, projectId, IMPORTED_LEDGER_LIMIT + 1),
    db
      .prepare(
        'SELECT id,project_id AS projectId,buy_receipt_id AS buyReceiptId,sell_receipt_id AS sellReceiptId,units_raw AS unitsRaw,buy_signature AS buySignature,sell_signature AS sellSignature,buy_preparation_sha256 AS buyPreparationSha256,sell_preparation_sha256 AS sellPreparationSha256,created_at AS createdAt FROM imported_trade_lot_links WHERE owner_id=? AND project_id=? LIMIT ?',
      )
      .bind(owner, projectId, IMPORTED_LOT_LINK_LIMIT + 1),
    db
      .prepare(
        'SELECT revision FROM imported_trade_lot_gates WHERE owner_id=? AND project_id=?',
      )
      .bind(owner, projectId),
  ];
  if (expenseStorage)
    statements.push(jitoPerformanceStatement(db, owner, projectId));
  const results = await db.batch(statements);
  if (
    results.some((r) => !r.success) ||
    results[1].results.length > IMPORTED_LEDGER_LIMIT ||
    results[2].results.length > IMPORTED_LOT_LINK_LIMIT ||
    (expenseStorage && results[4].results.length > IMPORTED_LEDGER_LIMIT)
  )
    throw new Error();
  const project = results[0].results[0] as { document: string } | undefined;
  if (!project) return null;
  const token = JSON.parse(project.document).token;
  if (token.chain !== 'Solana') throw new Error();
  const stored = results[1].results as Stored[];
  const receipts = stored.map((row) => {
    const raw = JSON.parse(row.document);
    return importedTradeReceipt(
      { ...row, document: Object.fromEntries(fields.map((k) => [k, raw[k]])) },
      projectId,
      token.address,
      token.decimals,
    );
  });
  const expenses = expenseStorage
    ? ((
        await jitoPerformanceCosts(
          results[4].results as JitoPerformanceRow[],
          receipts,
        )
      ).get(projectId) ?? emptyBundleExpenses())
    : includeExpenses
      ? { ...emptyBundleExpenses(), storageUnavailable: true }
      : undefined;
  const page = importedLotPage(
    {
      projectId,
      mint: token.address,
      decimals: token.decimals,
      receipts,
      ...(expenses ? { expenses } : {}),
      receiptDocumentHashes: Object.fromEntries(
        await Promise.all(
          stored.map(async (row) => [
            row.id,
            Array.from(
              new Uint8Array(
                await crypto.subtle.digest(
                  'SHA-256',
                  new TextEncoder().encode(row.document),
                ),
              ),
              (b) => b.toString(16).padStart(2, '0'),
            ).join(''),
          ]),
        ),
      ),
      links: results[2].results as ImportedLotLink[],
      revision:
        (results[3].results[0] as { revision: number } | undefined)?.revision ??
        0,
      observedAt: new Date().toISOString(),
    },
    projectId,
    token.address,
    token.decimals,
  );
  return { page, stored };
}
