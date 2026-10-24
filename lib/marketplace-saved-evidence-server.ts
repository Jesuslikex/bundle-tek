import {
  buildMarketplaceOwnedInventory,
  marketplaceInventoryHistoryDocument,
} from './marketplace-owned-inventory';
import {
  admitSavedEvidencePage,
  savedEvidenceAuthority,
  savedEvidenceCursor,
  savedEvidenceRequest,
  savedEvidenceUrl,
  savedHistoryCursor,
  savedWalletCursor,
  SAVED_EVIDENCE_DOCUMENT_BYTES,
  SAVED_EVIDENCE_DOCUMENT_CHARS,
  SAVED_EVIDENCE_HISTORY_BYTES,
  SAVED_EVIDENCE_PAGE_LIMIT,
  type SavedEvidencePage,
  type SavedEvidenceRecord,
  type SavedEvidenceRequest,
  type SavedEvidenceWallet,
} from './marketplace-saved-evidence';

export class SavedEvidenceStoredError extends Error {
  constructor(readonly status: number) {
    super(
      status === 404
        ? 'The selected saved wallet is unavailable for this account.'
        : status === 409
          ? 'The saved wallet changed. Reload saved wallets and select it again.'
          : 'Saved wallet evidence is unavailable. No partial page is shown.',
    );
    this.name = 'SavedEvidenceStoredError';
  }
}
type WalletRow = {
  address: string;
  label: string;
  revision: number;
  updatedAt: string;
  addressChars: number;
  labelChars: number;
  updatedAtChars: number;
  archived?: number;
};
type HistoryRow = {
  id: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  idChars: number;
  createdAtChars: number;
  updatedAtChars: number;
  documentChars: number;
  documentBytes: number;
  ordinal: number;
  prefixBytes: number;
  invalidPrefix: number;
  document: string | null;
};
const fail = (): never => {
  throw new SavedEvidenceStoredError(503);
};
const walletColumns =
  'substr(address,1,45) AS address,length(address) AS addressChars,substr(label,1,81) AS label,length(label) AS labelChars,revision,substr(updated_at,1,25) AS updatedAt,length(updated_at) AS updatedAtChars';
function wallet(row: WalletRow, now: number): SavedEvidenceWallet {
  if (
    !row ||
    !Number.isSafeInteger(row.addressChars) ||
    row.addressChars !== row.address.length ||
    !Number.isSafeInteger(row.labelChars) ||
    row.labelChars > 80 ||
    row.updatedAtChars !== 24 ||
    row.updatedAt.length !== 24
  )
    return fail();
  const value = buildMarketplaceOwnedInventory(
    {
      wallets: [
        {
          address: row.address,
          label: row.label,
          revision: row.revision,
          updatedAt: row.updatedAt,
        },
      ],
      proofs: [],
      runs: [],
      receipts: [],
    },
    now,
  ).wallets[0];
  return {
    address: value.address,
    label: value.label,
    revision: value.revision,
    updatedAt: value.updatedAt,
  };
}
function historyMetadata(row: HistoryRow, index: number, now: number) {
  if (
    !row ||
    typeof row.id !== 'string' ||
    !/^[\u0020-\u007e]{1,64}$/.test(row.id) ||
    row.idChars !== row.id.length ||
    !Number.isSafeInteger(row.revision) ||
    row.revision < 1 ||
    row.revision > 1e9 ||
    row.ordinal !== index + 1 ||
    ![
      row.documentChars,
      row.documentBytes,
      row.prefixBytes,
      row.invalidPrefix,
    ].every((v) => Number.isSafeInteger(v) && v >= 0)
  )
    return fail();
  for (const [value, length] of [
    [row.createdAt, row.createdAtChars],
    [row.updatedAt, row.updatedAtChars],
  ] as const)
    if (
      typeof value !== 'string' ||
      length !== 24 ||
      value.length !== 24 ||
      !Number.isFinite(Date.parse(value)) ||
      new Date(value).toISOString() !== value ||
      Date.parse(value) > now
    )
      return fail();
  if (row.createdAt > row.updatedAt) return fail();
}
/** Paged saved evidence only. Read-only pages are not a complete inventory or listing input. */
export async function readMarketplaceSavedEvidence(
  db: D1Database,
  owner: string,
  supplied: SavedEvidenceRequest,
  signal: AbortSignal,
  now = Date.now(),
): Promise<SavedEvidencePage> {
  try {
    signal.throwIfAborted();
    if (
      typeof owner !== 'string' ||
      !owner ||
      owner.length > 256 ||
      !Number.isSafeInteger(now)
    )
      return fail();
    const request = savedEvidenceRequest(
      new URL(savedEvidenceUrl(supplied), 'https://bundle.invalid')
        .searchParams,
    );
    const cursor = savedEvidenceCursor(request);
    const base = {
      format: 'marketplace-saved-evidence-page-v1',
      chain: 'Solana',
      observedAt: new Date(now).toISOString(),
      request,
      ...savedEvidenceAuthority,
    };
    if (request.view === 'wallets') {
      if (cursor && !('address' in cursor)) return fail();
      const rows = await db
        .prepare(
          `SELECT ${walletColumns} FROM workspace_wallets WHERE owner_id=? AND chain='Solana' AND archived=0${cursor ? ' AND address>?' : ''} ORDER BY address ASC LIMIT 21`,
        )
        .bind(owner, ...(cursor ? [cursor.address] : []))
        .all<WalletRow>();
      signal.throwIfAborted();
      if (
        !rows.success ||
        !Array.isArray(rows.results) ||
        rows.results.length > SAVED_EVIDENCE_PAGE_LIMIT + 1
      )
        return fail();
      const all = rows.results.map((row) => wallet(row, now)),
        wallets = all.slice(0, SAVED_EVIDENCE_PAGE_LIMIT);
      return admitSavedEvidencePage(
        {
          ...base,
          view: 'wallets',
          wallets,
          nextCursor:
            all.length > wallets.length
              ? savedWalletCursor(wallets.at(-1)!.address)
              : null,
        },
        request,
        now,
      );
    }
    if (cursor && !('createdAt' in cursor)) return fail();
    // The metadata-first CTE limits returned text independently of database scan
    // work. Full owner JSON membership still has to be inspected by SQLite.
    const history = db
      .prepare(`WITH candidates AS MATERIALIZED (
      SELECT h.id AS sourceId,h.created_at AS sourceCreatedAt,substr(h.id,1,65) AS id,length(h.id) AS idChars,h.revision,
        substr(h.created_at,1,25) AS createdAt,length(h.created_at) AS createdAtChars,substr(h.updated_at,1,25) AS updatedAt,length(h.updated_at) AS updatedAtChars,
        length(h.document) AS documentChars,length(CAST(h.document AS BLOB)) AS documentBytes,typeof(h.document) AS documentType
      FROM warmup_history_runs h WHERE h.owner_id=? AND json_extract(h.document,'$.chain')='Solana'
        AND EXISTS(SELECT 1 FROM json_each(h.document,'$.wallets') j WHERE json_extract(j.value,'$.address')=?)
        AND EXISTS(SELECT 1 FROM workspace_wallets w WHERE w.owner_id=h.owner_id AND w.chain='Solana' AND w.address=? AND w.revision=? AND w.archived=0)
        ${cursor ? 'AND (h.created_at<? OR (h.created_at=? AND h.id<?))' : ''}
      ORDER BY h.created_at DESC,h.id DESC LIMIT 21
    ), ranked AS (
      SELECT *,row_number() OVER(ORDER BY sourceCreatedAt DESC,sourceId DESC) AS ordinal,
        sum(documentBytes) OVER(ORDER BY sourceCreatedAt DESC,sourceId DESC ROWS UNBOUNDED PRECEDING) AS prefixBytes,
        sum(CASE WHEN documentType!='text' OR documentChars>${SAVED_EVIDENCE_DOCUMENT_CHARS} OR documentBytes>${SAVED_EVIDENCE_DOCUMENT_BYTES} THEN 1 ELSE 0 END) OVER(ORDER BY sourceCreatedAt DESC,sourceId DESC ROWS UNBOUNDED PRECEDING) AS invalidPrefix
      FROM candidates
    ) SELECT r.id,r.idChars,r.revision,r.createdAt,r.createdAtChars,r.updatedAt,r.updatedAtChars,r.documentChars,r.documentBytes,r.ordinal,r.prefixBytes,r.invalidPrefix,
      CASE WHEN r.ordinal<=${SAVED_EVIDENCE_PAGE_LIMIT} AND r.prefixBytes<=${SAVED_EVIDENCE_HISTORY_BYTES} AND r.invalidPrefix=0 THEN substr(h.document,1,${SAVED_EVIDENCE_DOCUMENT_CHARS + 1}) ELSE NULL END AS document
      FROM ranked r JOIN warmup_history_runs h ON h.owner_id=? AND h.id=r.sourceId ORDER BY r.ordinal`)
      .bind(
        owner,
        request.address,
        request.address,
        request.revision,
        ...(cursor ? [cursor.createdAt, cursor.createdAt, cursor.id] : []),
        owner,
      );
    const batch = await db.batch<WalletRow | HistoryRow>([
      db
        .prepare(
          `SELECT ${walletColumns},archived FROM workspace_wallets WHERE owner_id=? AND chain='Solana' AND address=?`,
        )
        .bind(owner, request.address),
      history,
    ]);
    signal.throwIfAborted();
    if (
      batch.length !== 2 ||
      batch.some((r) => !r.success || !Array.isArray(r.results)) ||
      batch[0].results.length > 1 ||
      batch[1].results.length > SAVED_EVIDENCE_PAGE_LIMIT + 1
    )
      return fail();
    const current = batch[0].results[0] as WalletRow | undefined;
    if (!current) throw new SavedEvidenceStoredError(404);
    if (current.archived !== 0 && current.archived !== 1) return fail();
    if (current.archived || current.revision !== request.revision)
      throw new SavedEvidenceStoredError(409);
    const selected = wallet(current, now);
    if (selected.address !== request.address) return fail();
    const rows = batch[1].results as HistoryRow[],
      records: SavedEvidenceRecord[] = [];
    let previousBytes = 0;
    for (const [index, row] of rows.entries()) {
      if (
        !row ||
        row.ordinal !== index + 1 ||
        ![row.documentBytes, row.prefixBytes].every(
          (value) => Number.isSafeInteger(value) && value >= 0,
        )
      )
        return fail();
      if (row.prefixBytes !== previousBytes + row.documentBytes) return fail();
      previousBytes = row.prefixBytes;
      if (index >= SAVED_EVIDENCE_PAGE_LIMIT) {
        if (row.document !== null) return fail();
        continue;
      }
      if (row.prefixBytes > SAVED_EVIDENCE_HISTORY_BYTES) {
        if (row.document !== null) return fail();
        continue;
      }
      historyMetadata(row, index, now);
      if (
        row.documentChars > SAVED_EVIDENCE_DOCUMENT_CHARS ||
        row.documentBytes > SAVED_EVIDENCE_DOCUMENT_BYTES ||
        row.invalidPrefix > 0
      )
        return fail();
      if (
        typeof row.document !== 'string' ||
        row.document.length > SAVED_EVIDENCE_DOCUMENT_CHARS ||
        new TextEncoder().encode(row.document).length !== row.documentBytes
      )
        return fail();
      const document = marketplaceInventoryHistoryDocument.parse(
        JSON.parse(row.document),
      );
      const membership = document.wallets.filter(
        (w) => w.address === request.address,
      );
      if (membership.length !== 1 || membership[0].revision > request.revision)
        return fail();
      const inventory = buildMarketplaceOwnedInventory(
        {
          wallets: [selected],
          proofs: [],
          receipts: [],
          runs: [
            {
              id: row.id,
              revision: row.revision,
              createdAt: row.createdAt,
              updatedAt: row.updatedAt,
              document: row.document,
            },
          ],
        },
        now,
      ).wallets[0];
      const observation = inventory.latestHistory;
      if (
        inventory.savedHistoryChecks + inventory.failedHistoryChecks > 1 ||
        (observation &&
          (observation.runId !== row.id ||
            observation.walletRevision !== membership[0].revision))
      )
        return fail();
      records.push({
        id: row.id,
        revision: row.revision,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        capturedWalletRevision: membership[0].revision,
        outcome:
          inventory.savedHistoryChecks === 1
            ? 'observation'
            : inventory.failedHistoryChecks === 1
              ? 'read-failed'
              : 'not-recorded',
        observation,
      });
    }
    if (rows.length && !records.length) return fail();
    signal.throwIfAborted();
    return admitSavedEvidencePage(
      {
        ...base,
        view: 'history',
        wallet: selected,
        records,
        nextCursor:
          rows.length > records.length
            ? savedHistoryCursor(
                request,
                records.at(-1)!.createdAt,
                records.at(-1)!.id,
              )
            : null,
      },
      request,
      now,
    );
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof SavedEvidenceStoredError) throw error;
    throw new SavedEvidenceStoredError(503);
  }
}
