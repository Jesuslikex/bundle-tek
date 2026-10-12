import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getD1 } from '@/db';
import { importedAcquisitionSnapshot } from '@/lib/imported-lot-links-server';
import { UUID } from '@/lib/wallet-operation';
import { walletRequest } from '@/lib/wallet-request';
import {
  proposedImportedLotLink,
  type ImportedLotLink,
} from '@/lib/imported-lot-links';
export const dynamic = 'force-dynamic';
const json = (v: unknown, status = 200) =>
  Response.json(v, { status, headers: { 'cache-control': 'no-store' } });
export async function GET(request: Request) {
  const user = await getChatGPTUser();
  if (!user)
    return json({ error: 'Sign in to review acquisition links.' }, 401);
  const projectId = new URL(request.url).searchParams.get('projectId');
  if (!projectId || !UUID.test(projectId))
    return json({ error: 'Choose an imported project.' }, 400);
  try {
    const s = await importedAcquisitionSnapshot(
      getD1(),
      user.userId,
      projectId,
    );
    return s
      ? json(s.page)
      : json({ error: 'Imported project unavailable.' }, 404);
  } catch {
    return json(
      {
        error:
          'Acquisition history unavailable. No partial accounting is shown.',
      },
      503,
    );
  }
}
export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user)
    return json({ error: 'Sign in to record an acquisition link.' }, 401);
  let input: {
    projectId: string;
    buyReceiptId: string;
    sellReceiptId: string;
    revision: number;
    buyDocumentSha256: string;
    sellDocumentSha256: string;
  };
  try {
    if (
      !request.headers
        .get('content-type')
        ?.toLowerCase()
        .startsWith('application/json')
    )
      throw new Error();
    const b = await walletRequest(request, 1000);
    if (
      Object.keys(b).sort().join(',') !==
        'buyDocumentSha256,buyReceiptId,projectId,revision,sellDocumentSha256,sellReceiptId' ||
      ![b.projectId, b.buyReceiptId, b.sellReceiptId].every(
        (v) => typeof v === 'string' && UUID.test(v),
      ) ||
      !Number.isSafeInteger(b.revision) ||
      (b.revision as number) < 0 ||
      (b.revision as number) >= 1e9 ||
      ![b.buyDocumentSha256, b.sellDocumentSha256].every(
        (v) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v),
      )
    )
      throw new Error();
    input = b as typeof input;
  } catch {
    return json(
      {
        error:
          'Review valid finalized receipts before recording an acquisition link.',
      },
      400,
    );
  }
  try {
    const db = getD1(),
      s = await importedAcquisitionSnapshot(db, user.userId, input.projectId);
    if (!s) return json({ error: 'Imported project unavailable.' }, 404);
    const existing = s.page.links.find(
      (l) => l.sellReceiptId === input.sellReceiptId,
    );
    if (existing)
      return existing.buyReceiptId === input.buyReceiptId &&
        s.page.links.filter((l) => l.sellReceiptId === input.sellReceiptId)
          .length === 1
        ? json(s.page)
        : json(
            { error: 'This sell already has an immutable acquisition link.' },
            409,
          );
    if (s.page.revision !== input.revision)
      return json(
        { error: 'Acquisition history changed. Reload and review again.' },
        409,
      );
    if (
      s.page.receiptDocumentHashes[input.buyReceiptId] !==
        input.buyDocumentSha256 ||
      s.page.receiptDocumentHashes[input.sellReceiptId] !==
        input.sellDocumentSha256
    )
      return json(
        {
          error: 'Reviewed receipt evidence changed. Reload and review again.',
        },
        409,
      );
    let link: ImportedLotLink;
    try {
      link = proposedImportedLotLink(
        s.page.receipts,
        s.page.links,
        input.projectId,
        input.buyReceiptId,
        input.sellReceiptId,
        crypto.randomUUID(),
        new Date().toISOString(),
      );
    } catch {
      return json(
        {
          error:
            'Choose an earlier buy from the same wallet with sufficient unassigned units.',
        },
        422,
      );
    }
    const nonce = crypto.randomUUID();
    const buyWallet = s.page.receipts.find((r) => r.id === link.buyReceiptId)!
      .document.wallet;
    if (
      await db
        .prepare(
          'SELECT 1 FROM solana_execution_reservations WHERE owner_id=? AND wallet_address=?',
        )
        .bind(user.userId, buyWallet)
        .first()
    )
      return json(
        {
          error:
            'Recover or cancel the active wallet approval before assigning acquisition accounting.',
        },
        409,
      );
    const result = await db.batch([
      db
        .prepare(
          'INSERT OR IGNORE INTO imported_trade_lot_gates(owner_id,project_id,revision) VALUES(?,?,0)',
        )
        .bind(user.userId, input.projectId),
      db
        .prepare(
          'UPDATE imported_trade_lot_gates SET revision=revision+1,write_token=? WHERE owner_id=? AND project_id=? AND revision=?',
        )
        .bind(nonce, user.userId, input.projectId, input.revision),
      db
        .prepare(`INSERT INTO imported_trade_lot_links(id,owner_id,project_id,buy_receipt_id,sell_receipt_id,units_raw,buy_signature,sell_signature,buy_preparation_sha256,sell_preparation_sha256,created_at,write_token)
        SELECT ?,?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM imported_trade_lot_gates WHERE owner_id=? AND project_id=? AND write_token=?)
        AND NOT EXISTS(SELECT 1 FROM solana_execution_reservations WHERE owner_id=? AND wallet_address=?)
        AND EXISTS(SELECT 1 FROM imported_swap_receipts WHERE owner_id=? AND project_id=? AND id=? AND document=?)
        AND EXISTS(SELECT 1 FROM imported_swap_receipts WHERE owner_id=? AND project_id=? AND id=? AND document=?)`)
        .bind(
          link.id,
          user.userId,
          link.projectId,
          link.buyReceiptId,
          link.sellReceiptId,
          link.unitsRaw,
          link.buySignature,
          link.sellSignature,
          link.buyPreparationSha256,
          link.sellPreparationSha256,
          link.createdAt,
          nonce,
          user.userId,
          link.projectId,
          nonce,
          user.userId,
          buyWallet,
          user.userId,
          link.projectId,
          link.buyReceiptId,
          s.stored.find((r) => r.id === link.buyReceiptId)!.document,
          user.userId,
          link.projectId,
          link.sellReceiptId,
          s.stored.find((r) => r.id === link.sellReceiptId)!.document,
        ),
    ]);
    if (!result[2].meta.changes)
      return json(
        { error: 'Acquisition history changed. Reload and review again.' },
        409,
      );
    return json(
      (await importedAcquisitionSnapshot(db, user.userId, input.projectId))!
        .page,
    );
  } catch {
    return json(
      {
        error:
          'Acquisition link could not be confirmed. Reload history before retrying.',
      },
      503,
    );
  }
}
