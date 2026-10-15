import {
  requirePumpLaunchGroupReview,
  type PumpLaunchGroupReview,
} from './pump-launch-group-review';
import { verifyPumpLaunchGroupSignatures } from './pump-launch-group-signatures';
import {
  canonicalPumpHolderJson,
  pumpHolderDigest,
} from './pump-holder-review';
import type { observePumpLaunchGroupRecovery } from './pump-launch-group-recovery';

const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const idValid = (v: unknown): v is string =>
  typeof v === 'string' &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v);
const dateValid = (v: unknown): v is string =>
  typeof v === 'string' && v.length <= 32 && Number.isFinite(Date.parse(v));
const states = ['review', 'approved', 'signed', 'cancelled'] as const;
export type PumpGroupView = {
  review: PumpLaunchGroupReview;
  quoteDecimals: number;
  state: (typeof states)[number];
  signedEvidence: Awaited<
    ReturnType<typeof verifyPumpLaunchGroupSignatures>
  > | null;
};
const fail = (): never => {
  throw new Error(
    'Saved complete launch group is unavailable or differs. Reload its history.',
  );
};
function summary(value: unknown, projectId: string) {
  if (
    !record(value) ||
    value.format !== 'pump-launch-group-review-v1' ||
    !record(value.review) ||
    value.review.format !== value.format ||
    value.review.projectId !== projectId ||
    !idValid(value.review.id) ||
    !dateValid(value.review.expiresAt) ||
    !states.includes(value.state as (typeof states)[number]) ||
    value.durableReview !== true ||
    value.signingAllowed !== false ||
    value.executionAllowed !== false ||
    value.completeLaunch !== false ||
    value.approvalRequired !==
      !['approved', 'signed'].includes(String(value.state))
  )
    return fail();
  return {
    id: value.review.id,
    state: value.state as (typeof states)[number],
    expiresAt: value.review.expiresAt,
    createdAt: dateValid(value.createdAt) ? value.createdAt : null,
  };
}
export type PumpGroupSummary = ReturnType<typeof summary>;
export async function parsePumpGroupView(
  value: unknown,
  projectId: string,
  signal?: AbortSignal,
): Promise<PumpGroupView> {
  signal?.throwIfAborted();
  const brief = summary(value, projectId);
  if (!record(value)) return fail();
  const { review, built } = await requirePumpLaunchGroupReview(
    value.review as PumpLaunchGroupReview,
    false,
  );
  signal?.throwIfAborted();
  let signedEvidence: PumpGroupView['signedEvidence'] = null;
  if (brief.state === 'signed') {
    if (
      !record(value.signedEvidence) ||
      !Array.isArray(value.signedEvidence.packets)
    )
      return fail();
    signedEvidence = await verifyPumpLaunchGroupSignatures(
      review,
      value.signedEvidence.packets.map((p: unknown) =>
        record(p) && typeof p.transaction === 'string' ? p.transaction : '',
      ),
      signal,
    );
    if (
      canonicalPumpHolderJson(signedEvidence) !==
      canonicalPumpHolderJson(value.signedEvidence)
    )
      return fail();
  } else if (value.signedEvidence !== null) return fail();
  signal?.throwIfAborted();
  return {
    review,
    quoteDecimals: built.quote.decimals,
    state: brief.state,
    signedEvidence,
  };
}
export function parsePumpGroupPage(
  value: unknown,
  projectId: string,
  previous?: string,
) {
  if (
    !record(value) ||
    !Array.isArray(value.launches) ||
    value.launches.length > 20 ||
    !(
      value.nextCursor === null ||
      (typeof value.nextCursor === 'string' &&
        /^[A-Za-z0-9_-]{1,1024}$/.test(value.nextCursor))
    ) ||
    value.nextCursor === previous ||
    (value.nextCursor !== null && !value.launches.length)
  )
    return fail();
  const rows = value.launches.map((row) => summary(row, projectId));
  if (new Set(rows.map((row) => row.id)).size !== rows.length) return fail();
  return { rows, nextCursor: value.nextCursor as string | null };
}
type Observation = Awaited<ReturnType<typeof observePumpLaunchGroupRecovery>>;
export type PumpGroupObservationView = Observation & {
  id: string;
  createdAt: string;
  sha256: string;
  sourceState: 'approved' | 'signed';
};
export async function parsePumpGroupObservation(
  value: unknown,
  view: PumpGroupView,
): Promise<PumpGroupObservationView> {
  if (
    !record(value) ||
    !idValid(value.id) ||
    !dateValid(value.createdAt) ||
    !['approved', 'signed'].includes(String(value.sourceState)) ||
    !record(value.receipt) ||
    typeof value.sha256 !== 'string'
  )
    return fail();
  const receipt = value.receipt;
  if (!['approved', 'signed'].includes(view.state)) return fail();
  const signed = value.sourceState === 'signed' ? view.signedEvidence : null;
  if (value.sourceState === 'signed' && !signed) return fail();
  if (
    receipt.format !== 'pump-launch-group-recovery-observation-v1' ||
    receipt.reviewId !== view.review.id ||
    receipt.contextSha256 !== view.review.contextSha256 ||
    receipt.manifestSha256 !== view.review.manifestSha256 ||
    receipt.signedGroupSha256 !== (signed?.signedGroupSha256 ?? null) ||
    receipt.observedAt !== value.createdAt ||
    receipt.network !== 'mainnet' ||
    receipt.commitment !== 'finalized' ||
    receipt.mint !== view.review.input.create.mint ||
    receipt.signingAllowed !== false ||
    receipt.executionAllowed !== false ||
    receipt.completeLaunch !== false ||
    receipt.atomicityProven !== false ||
    receipt.reservationsMustRemainHeld !== true ||
    receipt.settlementVerificationRequired !== true ||
    receipt.durableTransitionRequired !== true ||
    !Array.isArray(receipt.packets) ||
    receipt.packets.length !== view.review.packets.length ||
    ![
      'complete',
      'failed',
      'partial',
      'expired-unobserved',
      'unknown',
      'pending',
    ].includes(String(value.state)) ||
    !/^(0|[1-9]\d{0,22})$/.test(String(receipt.knownNetworkFeeRaw)) ||
    typeof receipt.networkFeeUnresolved !== 'boolean'
  )
    return fail();
  for (const [index, packet] of receipt.packets.entries()) {
    if (
      !record(packet) ||
      packet.index !== index ||
      packet.unsignedPacketSha256 !== view.review.packets[index].sha256 ||
      packet.signature !== (signed?.packets[index].signature ?? null) ||
      packet.signedPacketSha256 !==
        (signed?.packets[index].signedPacketSha256 ?? null) ||
      typeof packet.finalized !== 'boolean' ||
      !(packet.succeeded === null || typeof packet.succeeded === 'boolean') ||
      !(
        packet.networkFeeRaw === null ||
        (typeof packet.networkFeeRaw === 'string' &&
          /^(0|[1-9]\d{0,19})$/.test(packet.networkFeeRaw))
      ) ||
      !(
        packet.slot === null ||
        (typeof packet.slot === 'string' &&
          /^(0|[1-9]\d{0,19})$/.test(packet.slot))
      ) ||
      packet.finalized !==
        (packet.succeeded !== null && packet.slot !== null) ||
      (!packet.finalized && packet.networkFeeRaw !== null) ||
      (!signed && packet.finalized)
    )
      return fail();
  }
  const packets = receipt.packets as Observation['receipt']['packets'];
  const observed = packets.filter((p) => p.finalized).length;
  const successes = packets.filter((p) => p.succeeded === true).length;
  const expiry = receipt.expiry;
  if (
    expiry !== null &&
    (!record(expiry) ||
      expiry.marginBlocks !== 32 ||
      typeof expiry.pastExpiryMargin !== 'boolean' ||
      !(expiry.mintAbsent === null || typeof expiry.mintAbsent === 'boolean') ||
      expiry.lastValidBlockHeight !==
        view.review.input.create.lastValidBlockHeight ||
      !/^(0|[1-9]\d{0,19})$/.test(String(expiry.finalizedBlockHeight)) ||
      expiry.pastExpiryMargin !==
        BigInt(String(expiry.finalizedBlockHeight)) >
          BigInt(view.review.input.create.lastValidBlockHeight) + 32n)
  )
    return fail();
  const state =
    observed === packets.length
      ? successes === packets.length
        ? 'complete'
        : successes === 0
          ? 'failed'
          : 'partial'
      : observed > 0
        ? 'partial'
        : record(expiry) && expiry.pastExpiryMargin
          ? expiry.mintAbsent === true
            ? 'expired-unobserved'
            : 'unknown'
          : 'pending';
  if (
    value.state !== state ||
    receipt.observedPacketCount !== observed ||
    receipt.successfulPacketCount !== successes ||
    receipt.allPacketsFinalized !== (observed === packets.length) ||
    receipt.allPacketsSucceeded !== (successes === packets.length) ||
    receipt.signatureKnown !== (signed !== null) ||
    receipt.networkFeeUnresolved !==
      packets.some((p) => p.networkFeeRaw === null) ||
    receipt.knownNetworkFeeRaw !==
      packets
        .reduce((sum, p) => sum + BigInt(p.networkFeeRaw ?? '0'), 0n)
        .toString()
  )
    return fail();
  const core = { state: value.state, receipt };
  if ((await pumpHolderDigest(core)) !== value.sha256) return fail();
  return structuredClone(value) as PumpGroupObservationView;
}
