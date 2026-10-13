import {
  decodeSessionEntryOutcomes,
  type SessionEntryOutcomes,
} from './session-entry-outcomes';

export function sessionOutcomeSummary(value: SessionEntryOutcomes) {
  const page = decodeSessionEntryOutcomes(
    value,
    value.session,
    value.sourceEventId,
  );
  const counts = {
    verified: 0,
    awaitingSignature: 0,
    awaitingSettlement: 0,
    finalizedWithoutReceipt: 0,
    failedOrCancelled: 0,
    noApprovalRecord: 0,
    unknownApproval: 0,
  };
  let verifiedInput = 0n;
  const signatures = new Set<string>();
  const receipts = new Set<string>();
  for (const row of page.entries) {
    if (row.receiptEvidence === 'matching') {
      const receipt = row.receipt!;
      if (
        receipts.has(receipt.id) ||
        signatures.has(receipt.document.signature)
      )
        throw new Error(
          'Repeated receipt evidence cannot establish session progress.',
        );
      receipts.add(receipt.id);
      signatures.add(receipt.document.signature);
      verifiedInput += BigInt(row.unitsRaw);
      counts.verified++;
    } else if (page.missingSources.includes('approval')) {
      counts.unknownApproval++;
    } else if (!row.approval) {
      counts.noApprovalRecord++;
    } else if (row.approval.state === 'finalized') {
      counts.finalizedWithoutReceipt++;
    } else if (row.approval.state === 'awaiting_signature') {
      counts.awaitingSignature++;
    } else if (
      row.approval.state === 'signed' ||
      row.approval.state === 'submitted'
    ) {
      counts.awaitingSettlement++;
    } else {
      counts.failedOrCancelled++;
    }
  }
  const total = BigInt(page.session.terms.totalRaw);
  return {
    counts,
    entries: page.entries.length,
    totalInputRaw: total.toString(),
    verifiedInputRaw: verifiedInput.toString(),
    unverifiedInputRaw: (total - verifiedInput).toString(),
    verifiedBudgetBasisPoints: Number((verifiedInput * 10000n) / total),
  };
}
