import {
  requirePumpGroupBroadcastReview,
  verifyPumpGroupTip,
  type PumpGroupBroadcastState,
  type PumpGroupBroadcastReview,
  type PumpGroupBroadcastTip,
} from './pump-group-broadcast';
import { requirePumpRuntimePreview } from './pump-group-runtime-authorization';
import {
  canonicalPumpHolderJson,
  pumpHolderDigest,
} from './pump-holder-review';
import type { PumpGroupView } from './pump-launch-group-client';
export type PumpGroupTipSignAction = (
  r: PumpGroupBroadcastReview,
  group: PumpGroupView,
  current: () => void,
  signal: AbortSignal,
) => Promise<PumpGroupBroadcastTip>;
const rec = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const fail = (): never => {
  throw new Error(
    'Saved broadcast scope or retained evidence differs. Reload it before continuing.',
  );
};
export async function parsePumpGroupBroadcastState(
  value: unknown,
  group: PumpGroupView,
): Promise<PumpGroupBroadcastState | null> {
  if (value === null) return null;
  if (
    !rec(value) ||
    typeof value.attempted !== 'boolean' ||
    typeof value.reservationsReleased !== 'boolean'
  )
    return fail();
  const review = await requirePumpGroupBroadcastReview(
    value.review as PumpGroupBroadcastReview,
    group.review,
    false,
  );
  if (review.signedGroupSha256 !== group.signedEvidence?.signedGroupSha256)
    return fail();
  const code = await requirePumpRuntimePreview(value.code, group.review, false);
  if (code.identitySha256 !== review.codeIdentitySha256) return fail();
  const tip =
    value.tip === null
      ? null
      : rec(value.tip) && typeof value.tip.transaction === 'string'
        ? await verifyPumpGroupTip(review, value.tip.transaction)
        : fail();
  if (
    tip &&
    canonicalPumpHolderJson(tip) !== canonicalPumpHolderJson(value.tip)
  )
    return fail();
  if (value.attempted && !tip) return fail();
  const result = value.result;
  if (
    result !== null &&
    (!value.attempted ||
      !rec(result) ||
      !['accepted', 'unknown'].includes(String(result.outcome)) ||
      (result.outcome === 'accepted'
        ? !/^[a-f0-9]{64}$/.test(String(result.bundleId))
        : result.bundleId !== null))
  )
    return fail();
  let recovery: PumpGroupBroadcastState['recovery'] = null;
  if (value.recovery !== null) {
    if (!rec(value.recovery)) return fail();
    const { sha256, ...body } = value.recovery;
    if (
      sha256 !== (await pumpHolderDigest(body)) ||
      body.format !== 'pump-group-jito-recovery-v1' ||
      body.reviewId !== review.reviewId ||
      body.broadcastId !== review.id ||
      body.broadcastSha256 !== review.sha256 ||
      body.signedGroupSha256 !== review.signedGroupSha256 ||
      ![
        'finalized',
        'failed',
        'expired-unobserved',
        'partial-final',
        'partial',
        'pending',
        'unknown',
      ].includes(String(body.state)) ||
      body.economicSettlementVerified !== false ||
      body.completeLaunch !== false ||
      body.reservationsReleased !== false ||
      !Number.isFinite(Date.parse(String(body.observedAt))) ||
      !rec(body.tip) ||
      body.tip.signature !== (tip?.signature ?? null)
    )
      return fail();
    recovery = value.recovery as PumpGroupBroadcastState['recovery'];
  }
  if (
    value.reservationsReleased &&
    (!group.receipt ||
      group.receipt.format !== 'pump-launch-group-broadcast-terminal-v1' ||
      group.receipt.broadcastSha256 !== review.sha256 ||
      !recovery ||
      group.receipt.observationId !== recovery.id ||
      group.receipt.observationSha256 !== recovery.sha256)
  )
    return fail();
  return {
    review,
    code,
    tip,
    attempted: value.attempted,
    result: result as PumpGroupBroadcastState['result'],
    recovery,
    reservationsReleased: value.reservationsReleased,
  };
}
