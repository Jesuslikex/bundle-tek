const uuid = (v: unknown): v is string =>
  typeof v === 'string' &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v);
export const launchEvidenceId = uuid;
export type AccountLaunchEvidence = {
  reviewId: string;
  mint: string;
  entry: null | {
    id: string;
    sha256: string;
    observedAt: string;
    packetCount: number;
    successfulPackets: number;
    failedPackets: number;
    missingPackets: number;
    instructionMetadataPackets: number;
    balanceCoverageComplete: boolean;
    acquisitionBasisVerified: false;
    executionAllowed: false;
    payments?: AccountLaunchPayments;
  };
};
export function validatedAccountLaunchEvidence(
  value: unknown,
  context: { reviewId: string; mint: string },
): AccountLaunchEvidence {
  const v = value as AccountLaunchEvidence;
  if (
    !v ||
    Object.keys(v).sort().join(',') !== 'entry,mint,reviewId' ||
    v.reviewId !== context.reviewId ||
    v.mint !== context.mint ||
    !uuid(v.reviewId) ||
    typeof v.mint !== 'string' ||
    !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v.mint) ||
    !Object.hasOwn(v, 'entry')
  )
    throw new Error('Saved launch receipt context differs.');
  const e = v.entry;
  if (e === null) return v;
  if (
    !e ||
    Object.keys(e)
      .filter((key) => key !== 'payments')
      .sort()
      .join(',') !==
      'acquisitionBasisVerified,balanceCoverageComplete,executionAllowed,failedPackets,id,instructionMetadataPackets,missingPackets,observedAt,packetCount,sha256,successfulPackets' ||
    !uuid(e.id) ||
    typeof e.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(e.sha256) ||
    typeof e.observedAt !== 'string' ||
    !Number.isFinite(Date.parse(e.observedAt)) ||
    new Date(e.observedAt).toISOString() !== e.observedAt ||
    ![
      e.packetCount,
      e.successfulPackets,
      e.failedPackets,
      e.missingPackets,
      e.instructionMetadataPackets,
    ].every((n) => Number.isSafeInteger(n) && n >= 0 && n <= 201) ||
    e.packetCount < 1 ||
    e.successfulPackets + e.failedPackets + e.missingPackets !==
      e.packetCount ||
    e.missingPackets === e.packetCount ||
    e.instructionMetadataPackets > e.packetCount - e.missingPackets ||
    typeof e.balanceCoverageComplete !== 'boolean' ||
    (e.balanceCoverageComplete && e.missingPackets !== 0) ||
    e.acquisitionBasisVerified !== false ||
    e.executionAllowed !== false
  )
    throw new Error('Saved launch receipt summary differs.');
  if (Object.hasOwn(e, 'payments')) {
    const payments = validatedAccountLaunchPayments(e.payments, {
      ...context,
      evidenceSha256: e.sha256,
    });
    if (
      payments.packets.length !== e.packetCount ||
      payments.packets.filter((p) => p.outcome === 'success').length !==
        e.successfulPackets ||
      payments.packets.filter((p) => p.outcome === 'failed').length !==
        e.failedPackets ||
      payments.packets.filter((p) => p.outcome === 'not-observed').length !==
        e.missingPackets
    )
      throw new Error(
        'Saved launch payment coverage differs from receipt coverage.',
      );
  }
  return v;
}
import {
  validatedAccountLaunchPayments,
  type AccountLaunchPayments,
} from './account-launch-payments';
