import type {
  PumpGroupView,
  PumpGroupObservationView,
} from './pump-launch-group-client';
import type { PumpGroupBroadcastState } from './pump-group-broadcast';

const u64 = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^(0|[1-9]\d{0,19})$/.test(value) &&
  BigInt(value) <= (1n << 64n) - 1n;
const fail = (): never => {
  throw new Error(
    'Saved launch cost evidence differs. No cost totals are shown.',
  );
};

/** Project already parsed, owner-selected immutable receipts into fees/tips only. */
export function reconcilePumpGroupRecordedCosts(
  group: PumpGroupView,
  broadcast: PumpGroupBroadcastState,
  observation: PumpGroupObservationView,
) {
  const closure = group.receipt,
    recovery = broadcast.recovery;
  if (
    !closure ||
    closure.format !== 'pump-launch-group-broadcast-terminal-v1' ||
    !recovery ||
    !broadcast.reservationsReleased ||
    closure.reviewId !== group.review.id ||
    closure.contextSha256 !== group.review.contextSha256 ||
    closure.signedGroupSha256 !== broadcast.review.signedGroupSha256 ||
    closure.broadcastId !== broadcast.review.id ||
    closure.broadcastSha256 !== broadcast.review.sha256 ||
    closure.observationId !== recovery.id ||
    closure.observationSha256 !== recovery.sha256 ||
    closure.observedAt !== recovery.observedAt ||
    recovery.reviewId !== group.review.id ||
    recovery.groupObservationId !== observation.id ||
    recovery.groupObservationSha256 !== observation.sha256 ||
    Date.parse(observation.createdAt) > Date.parse(closure.observedAt) ||
    observation.sourceState !== 'signed' ||
    observation.receipt.reviewId !== group.review.id ||
    observation.receipt.signedGroupSha256 !==
      group.signedEvidence?.signedGroupSha256 ||
    recovery.economicSettlementVerified !== false ||
    recovery.completeLaunch !== false ||
    closure.economicSettlementVerified !== false ||
    closure.signingAllowed !== false ||
    closure.executionAllowed !== false ||
    closure.completeLaunch !== false
  )
    return fail();
  const packets = observation.receipt.packets;
  if (
    !packets.length ||
    packets.length > 4 ||
    packets.length !== group.review.packets.length
  )
    return fail();
  const tip = recovery.tip;
  if (
    tip.signature !== (broadcast.tip?.signature ?? null) ||
    typeof tip.finalized !== 'boolean' ||
    (tip.finalized
      ? !broadcast.tip ||
        typeof tip.succeeded !== 'boolean' ||
        !u64(tip.slot) ||
        !u64(tip.networkFeeRaw) ||
        !u64(tip.tipDebitRaw)
      : tip.succeeded !== null ||
        tip.slot !== null ||
        tip.networkFeeRaw !== null ||
        tip.tipDebitRaw !== null)
  )
    return fail();
  if (
    tip.finalized &&
    (tip.tipDebitRaw !== (tip.succeeded ? broadcast.review.tipRaw : '0') ||
      BigInt(tip.networkFeeRaw!) < 1n ||
      BigInt(tip.networkFeeRaw!) > BigInt(broadcast.review.tipFeeLimitRaw) ||
      BigInt(tip.slot!) === 0n ||
      BigInt(tip.slot!) > BigInt(Number.MAX_SAFE_INTEGER))
  )
    return fail();
  const packetRows = packets.map((packet, index) => {
    if (
      packet.index !== index ||
      (packet.networkFeeRaw !== null && !u64(packet.networkFeeRaw)) ||
      (!packet.finalized && packet.networkFeeRaw !== null) ||
      (packet.finalized
        ? typeof packet.succeeded !== 'boolean' || !u64(packet.slot)
        : packet.succeeded !== null || packet.slot !== null)
    )
      return fail();
    return {
      index,
      outcome: packet.finalized
        ? packet.succeeded
          ? ('success' as const)
          : ('failed' as const)
        : ('unobserved' as const),
      networkFeeLamports: packet.networkFeeRaw,
    };
  });
  const groupFees = packetRows
    .reduce((sum, p) => sum + BigInt(p.networkFeeLamports ?? '0'), 0n)
    .toString();
  const knownFees = (
    BigInt(groupFees) + BigInt(tip.networkFeeRaw ?? '0')
  ).toString();
  if (
    groupFees !== observation.receipt.knownNetworkFeeRaw ||
    groupFees !== closure.groupNetworkFeeRaw ||
    knownFees !== closure.knownNetworkFeeRaw ||
    tip.networkFeeRaw !== closure.tipNetworkFeeRaw ||
    tip.tipDebitRaw !== closure.tipDebitRaw
  )
    return fail();
  const landed = packets.filter((p) => p.finalized).length,
    succeeded = packets.filter((p) => p.succeeded === true).length;
  const allKnown =
    packets.every((p) => p.networkFeeRaw !== null) &&
    tip.networkFeeRaw !== null;
  const expiry = recovery.expiry;
  if (
    expiry !== null &&
    expiry !== undefined &&
    (expiry.marginBlocks !== 32 ||
      expiry.lastValidBlockHeight !== broadcast.review.lastValidBlockHeight ||
      !u64(expiry.finalizedBlockHeight) ||
      !u64(expiry.expiryBankSlot) ||
      BigInt(expiry.finalizedBlockHeight) > BigInt(expiry.expiryBankSlot) ||
      expiry.pastExpiryMargin !==
        BigInt(expiry.finalizedBlockHeight) >
          BigInt(expiry.lastValidBlockHeight) + 32n)
  )
    return fail();
  const settled =
    (landed > 0 ||
      (observation.state === 'expired-unobserved' && tip.finalized)) &&
    packets.every((p) =>
      p.finalized
        ? p.networkFeeRaw !== null
        : observation.receipt.expiry?.pastExpiryMargin === true,
    ) &&
    (tip.finalized || recovery.expiry?.pastExpiryMargin === true);
  const expectedState =
    observation.state === 'complete' &&
    tip.finalized &&
    tip.succeeded === true &&
    packets.every((p) => p.slot === tip.slot) &&
    allKnown
      ? 'finalized'
      : observation.state === 'failed' &&
          tip.finalized &&
          tip.succeeded === false &&
          allKnown
        ? 'failed'
        : observation.state === 'expired-unobserved' && !tip.finalized
          ? 'expired-unobserved'
          : settled
            ? 'partial-final'
            : null;
  if (
    !expectedState ||
    recovery.state !== expectedState ||
    closure.kind !==
      (expectedState === 'partial-final' ? 'partial' : expectedState) ||
    closure.networkFeeUnresolved !==
      (expectedState === 'partial-final' ? false : !allKnown) ||
    (expectedState === 'partial-final' &&
      (closure.packetCount !== packets.length ||
        closure.landedPacketCount !== landed ||
        closure.succeededPacketCount !== succeeded))
  )
    return fail();
  return {
    format: 'pump-group-recorded-costs-v1' as const,
    reviewId: group.review.id,
    mint: group.review.input.create.mint,
    observedAt: closure.observedAt,
    outcome: closure.kind,
    packets: packetRows,
    groupNetworkFeeLamports: groupFees,
    tipNetworkFeeLamports: tip.networkFeeRaw,
    tipLamports: tip.tipDebitRaw,
    knownTotalLamports: (
      BigInt(knownFees) + BigInt(tip.tipDebitRaw ?? '0')
    ).toString(),
    feeAndTipCoverageComplete: allKnown && tip.tipDebitRaw !== null,
    economicSettlementVerified: false as const,
    profitCalculated: false as const,
    purchasePrincipalIncluded: false as const,
    rentIncluded: false as const,
    signingAllowed: false as const,
    executionAllowed: false as const,
    reservationsChanged: false as const,
  };
}
export type PumpGroupRecordedCosts = ReturnType<
  typeof reconcilePumpGroupRecordedCosts
>;

/** Validate the public projection and bind it to the exact selected account row. */
export function validatedPumpGroupRecordedCosts(
  value: unknown,
  selected: { reviewId: string; mint: string },
): PumpGroupRecordedCosts {
  const v = value as PumpGroupRecordedCosts;
  if (
    !v ||
    v.format !== 'pump-group-recorded-costs-v1' ||
    v.reviewId !== selected.reviewId ||
    v.mint !== selected.mint ||
    typeof v.observedAt !== 'string' ||
    !Number.isFinite(Date.parse(v.observedAt)) ||
    new Date(v.observedAt).toISOString() !== v.observedAt ||
    !['finalized', 'failed', 'expired-unobserved', 'partial'].includes(
      v.outcome,
    ) ||
    !Array.isArray(v.packets) ||
    !v.packets.length ||
    v.packets.length > 4 ||
    [
      v.economicSettlementVerified,
      v.profitCalculated,
      v.purchasePrincipalIncluded,
      v.rentIncluded,
      v.signingAllowed,
      v.executionAllowed,
      v.reservationsChanged,
    ].some((flag) => flag !== false) ||
    (v.tipNetworkFeeLamports !== null && !u64(v.tipNetworkFeeLamports)) ||
    (v.tipLamports !== null && !u64(v.tipLamports))
  )
    return fail();
  for (const [index, p] of v.packets.entries()) {
    if (
      !p ||
      p.index !== index ||
      !['success', 'failed', 'unobserved'].includes(p.outcome) ||
      (p.networkFeeLamports !== null && !u64(p.networkFeeLamports)) ||
      (p.outcome === 'unobserved' && p.networkFeeLamports !== null)
    )
      return fail();
  }
  const groupFees = v.packets
    .reduce((sum, p) => sum + BigInt(p.networkFeeLamports ?? '0'), 0n)
    .toString();
  if (
    v.groupNetworkFeeLamports !== groupFees ||
    v.knownTotalLamports !==
      (
        BigInt(groupFees) +
        BigInt(v.tipNetworkFeeLamports ?? '0') +
        BigInt(v.tipLamports ?? '0')
      ).toString() ||
    v.feeAndTipCoverageComplete !==
      (v.packets.every((p) => p.networkFeeLamports !== null) &&
        v.tipNetworkFeeLamports !== null &&
        v.tipLamports !== null)
  )
    return fail();
  return v;
}
