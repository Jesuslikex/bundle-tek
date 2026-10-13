import { requireJitoManifest, type JitoBundleManifest } from './jito-bundle';
import {
  requireJitoFinalization,
  type JitoFinalization,
} from './jito-finalization';
import { matchingJitoSwapReceipt } from './jito-swap-receipt';
import type { ImportedTradeReceipt } from './imported-trade-ledger';
import { emptyBundleExpenses, type BundleExpenses } from './bundle-expenses';
export type { BundleExpenses } from './bundle-expenses';
export async function jitoCostStorageAvailable(db: D1Database) {
  const row = await db
    .prepare(
      "SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name IN ('jito_bundles','jito_bundle_packets','jito_bundle_finalizations')",
    )
    .first<{ n: number }>();
  if (!row || !Number.isInteger(row.n) || row.n < 0 || row.n > 3)
    throw new Error('Bundle cost storage metadata unavailable.');
  return row.n === 3;
}
export function jitoPerformanceStatement(
  db: D1Database,
  owner: string,
  projectId?: string,
) {
  const sql = `SELECT b.id,b.state,b.document,f.document AS finalizationDocument,(SELECT json_group_array(json_object('packet',p.packet,'signature',p.signature)) FROM jito_bundle_packets p WHERE p.owner_id=b.owner_id AND p.bundle_id=b.id AND p.signature IS NOT NULL) AS packets FROM jito_bundles b LEFT JOIN jito_bundle_finalizations f ON f.owner_id=b.owner_id AND f.bundle_id=b.id WHERE b.owner_id=?${projectId ? " AND json_extract(b.document,'$.projectId')=?" : ''} LIMIT ?`;
  return projectId
    ? db.prepare(sql).bind(owner, projectId, 4001)
    : db.prepare(sql).bind(owner, 4001);
}

export type JitoPerformanceRow = {
  id: string;
  state: string;
  document: string;
  finalizationDocument: string | null;
  packets: string;
};
/** One owner-scoped database snapshot; no provider reads or transaction actions. */
export async function jitoPerformanceCosts(
  rows: JitoPerformanceRow[],
  receipts: ImportedTradeReceipt[],
) {
  const bySignature = new Map(receipts.map((r) => [r.document.signature, r]));
  if (
    bySignature.size !== receipts.length ||
    new Set(rows.map((r) => r.id)).size !== rows.length
  )
    throw new Error('Unique bundle cost evidence required.');
  const result = new Map<string, BundleExpenses>();
  const assigned = new Set<string>();
  for (const row of rows) {
    const manifest = JSON.parse(row.document) as JitoBundleManifest;
    await requireJitoManifest(manifest, false);
    if (manifest.id !== row.id) throw new Error('Bundle cost context differs.');
    const packets = JSON.parse(row.packets) as Array<{
      packet: number;
      signature: string;
    }>;
    if (
      !Array.isArray(packets) ||
      packets.length > 5 ||
      new Set(packets.map((p) => p.packet)).size !== packets.length
    )
      throw new Error('Bundle packet costs differ.');
    const signatures = Array<string | null>(manifest.swaps.length + 1).fill(
      null,
    );
    for (const p of packets) {
      if (
        !Number.isSafeInteger(p.packet) ||
        p.packet < 0 ||
        p.packet >= signatures.length ||
        typeof p.signature !== 'string'
      )
        throw new Error('Bundle packet costs differ.');
      signatures[p.packet] = p.signature;
    }
    const swaps = manifest.swaps.map((review, i) => {
      const receipt = bySignature.get(signatures[i] ?? '');
      if (
        receipt &&
        !matchingJitoSwapReceipt(
          receipt,
          manifest.projectId,
          review,
          signatures[i]!,
          receipt.document.slot,
        )
      )
        throw new Error('Bundle swap cost evidence differs.');
      return receipt;
    });
    if (!swaps.some(Boolean)) {
      if (row.state === 'finalized')
        throw new Error('Finalized bundle trade receipts missing.');
      continue;
    }
    const expenses = result.get(manifest.projectId) ?? emptyBundleExpenses();
    result.set(manifest.projectId, expenses);
    for (const receipt of swaps)
      if (receipt) {
        if (assigned.has(receipt.id))
          throw new Error('Bundle execution costs duplicated.');
        assigned.add(receipt.id);
      }
    if (row.state !== 'finalized' || !row.finalizationDocument) {
      expenses.missingBundleCostCount++;
      continue;
    }
    const proof = JSON.parse(row.finalizationDocument) as JitoFinalization;
    await requireJitoFinalization(proof, manifest, signatures);
    if (swaps.some((r) => !r || r.document.slot !== proof.slot))
      throw new Error('Finalized bundle cost slot differs.');
    if (!proof.tipReceipt) {
      expenses.missingBundleCostCount++;
      continue;
    }
    const tip = BigInt(proof.tipReceipt.amountRaw),
      fee = BigInt(proof.tipReceipt.networkFeeLamports);
    expenses.bundleTipLamports = (
      BigInt(expenses.bundleTipLamports) + tip
    ).toString();
    expenses.bundleFeeLamports = (
      BigInt(expenses.bundleFeeLamports) + fee
    ).toString();
    // Equal packet shares; first packets receive indivisible residual lamports.
    const total = tip + fee,
      count = BigInt(swaps.length),
      share = total / count,
      residual = total % count;
    swaps.forEach((receipt, i) => {
      expenses.executionCosts[receipt!.id] = (
        share + (BigInt(i) < residual ? 1n : 0n)
      ).toString();
    });
  }
  return result;
}
