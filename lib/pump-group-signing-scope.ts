import type { PumpGroupView } from './pump-launch-group-client';
import type { PumpLaunchGroupConsent } from './pump-launch-group-review';
import type {
  PumpGroupRuntimePreview,
  PumpGroupSigningAuthorization,
} from './pump-group-runtime-authorization';
import type { verifyPumpLaunchGroupSignatures } from './pump-launch-group-signatures';
import { canonicalPumpHolderJson } from './pump-holder-review';
export type PumpGroupSignAction = (input: {
  view: PumpGroupView;
  consent: PumpLaunchGroupConsent;
  preview: PumpGroupRuntimePreview;
  authorization: PumpGroupSigningAuthorization;
  current: () => void;
  signal: AbortSignal;
}) => Promise<Awaited<ReturnType<typeof verifyPumpLaunchGroupSignatures>>>;
export function pumpGroupMatchesCurrentPrepare(
  view: PumpGroupView,
  terms: Record<string, unknown>,
  origin: string,
) {
  const r = view.review;
  const expected = {
    projectId: r.projectId,
    updatedAt: r.projectUpdatedAt,
    releaseId: r.releaseId,
    payer: r.input.create.payer,
    payerRevision: r.document.options.wallets?.deployer?.revision,
    mint: r.input.create.mint,
    feeAndRentLimitRaw: r.allowances.deployerFeeAndRentLimitRaw,
    ...(r.allowances.developerMaximumQuoteCostRaw === null
      ? {}
      : {
          developerMaximumQuoteCostRaw:
            r.allowances.developerMaximumQuoteCostRaw,
        }),
    holderLimits: r.allowances.holders.map((limit) => ({
      address: limit.address,
      feeAndRentLimitRaw: limit.feeAndRentLimitRaw,
      ...(limit.maximumQuoteCostRaw === null
        ? {}
        : { maximumQuoteCostRaw: limit.maximumQuoteCostRaw }),
      ...(limit.minimumTokenOutputRaw === null
        ? {}
        : { minimumTokenOutputRaw: limit.minimumTokenOutputRaw }),
    })),
  };
  return (
    r.input.create.uri === `${origin}/api/launch/metadata/${r.releaseId}` &&
    canonicalPumpHolderJson(terms) === canonicalPumpHolderJson(expected)
  );
}
