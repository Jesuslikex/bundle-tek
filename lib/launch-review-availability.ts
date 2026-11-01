import { LAUNCHLAB_VENUES } from './launchlab-platform-launch';

/** Keep return actions aligned with the venues that actually mount a review. */
export function hasLaunchMetadataReview(plan: {
  chain: string;
  launchpad: string;
}) {
  return (
    plan.chain === 'Solana' &&
    ['PumpFun', 'StonkFun', 'Meteora DBC', ...LAUNCHLAB_VENUES].includes(
      plan.launchpad,
    )
  );
}
