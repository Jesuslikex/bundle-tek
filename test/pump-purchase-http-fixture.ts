import { readFileSync } from 'node:fs';
import type { Client } from '@libsql/client';
import type { MockedFunction } from 'vitest';
import type { preflightOwnedPumpCreate } from '../lib/owned-pump-preflight';
import { pumpPurchaseSettlementFixture } from './pump-purchase-settlement-fixture';
import { pumpGroupPaymentFixture } from './pump-group-payment-fixture';
import { recoverOwnedPumpGroupBroadcast } from '../lib/pump-group-broadcast-recovery';
import { retainOwnedPumpGroupReceiptEvidence } from '../lib/pump-group-receipt-evidence-service';
import type { PumpLaunchRpc } from '../lib/pump-launch-simulation';
/** Full owned protocol in disposable SQLite, synthetic keys/RPC only. No submit. */
export async function pumpPurchaseHttpFixture(
  mocked: MockedFunction<typeof preflightOwnedPumpCreate>,
  clients: Client[],
) {
  const f = await pumpPurchaseSettlementFixture(mocked, clients),
    signal = () => new AbortController().signal;
  await f.ready();
  const signed = f.group.signedEvidence!,
    payment = await pumpGroupPaymentFixture(false, 'create', {
      review: f.group.review,
      signed,
      group: { review: f.group.review, signedEvidence: signed },
      rpc: f.rpc,
    });
  f.control.chain = true;
  const rpc: PumpLaunchRpc = async (m, p, s) => {
    if (
      m === 'getTransaction' &&
      signed.packets.some((t) => t.signature === p[0])
    ) {
      const result = (await payment.rpc(m, p, s)) as { slot: string };
      result.slot = '250';
      return result;
    }
    return f.rpc(m, p, s);
  };
  await recoverOwnedPumpGroupBroadcast(
    f.db,
    'alice',
    f.group.review.id,
    signal(),
    rpc,
    f.jito,
  );
  await f.client.execute(
    'CREATE TABLE imported_token_project_gates(owner_id TEXT PRIMARY KEY,next_allowed_at INTEGER)',
  );
  for (const name of [
    '0113_pump_group_receipt_evidence',
    '0114_pump_purchase_cost_sources',
  ])
    for (const sql of readFileSync(`drizzle/${name}.sql`, 'utf8').split(
      '--> statement-breakpoint',
    ))
      if (sql.trim())
        await f.client.execute(
          sql.replaceAll(
            "julianday('now')",
            "julianday('2026-10-15T12:00:00.000Z')",
          ),
        );
  const receiptId = crypto.randomUUID(),
    receipt = await retainOwnedPumpGroupReceiptEvidence(
      f.db,
      'alice',
      f.group.review.id,
      receiptId,
      signal(),
      rpc,
    );
  return {
    ...f,
    receiptId,
    receiptSha256: receipt.entry!.sha256,
    reviewId: f.group.review.id,
    mint: f.group.review.input.create.mint,
  };
}
