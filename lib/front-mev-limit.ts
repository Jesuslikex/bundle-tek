// Captured front-MEV wallet ceiling. The reference only enforces it when the
// mint itself supplies `maxFrontMevCount`:
//
//   if (frontCount > 0) {
//     if (migrationThreshold && maxFrontMevCount && buy >= migrationThreshold) {
//       const postMigration = maxFrontMevPostMigration ?? maxFrontMevCount;
//       if (postMigration && frontCount > postMigration) return "…Reduce Front MEV count first.";
//     } else if (maxFrontMevCount && frontCount > maxFrontMevCount) return "…";
//   }
//
// Note the `?? ` not `||`: an explicit post-migration 0 disables the cap after
// migration instead of falling back, because the inner guard also tests truth.
export type FrontMevLimitInput = {
  frontCount: number;
  /** Buy amount in the same unit as `migrationThreshold`. */
  buy?: number | null;
  migrationThreshold?: number | null;
  maxFrontMevCount?: number | null;
  maxFrontMevPostMigration?: number | null;
};

export function frontMevCap(input: FrontMevLimitInput) {
  const max = input.maxFrontMevCount;
  if (!input.frontCount || input.frontCount <= 0) return null;
  if (!max) return null;
  const postMigration = input.maxFrontMevPostMigration ?? max;
  const threshold = input.migrationThreshold;
  const buy = input.buy ?? 0;
  if (threshold && max && buy >= threshold)
    return { cap: postMigration, postMigration: true };
  return { cap: max, postMigration: false };
}

// Returns the refusal message, or null when the count is acceptable.
export function frontMevRefusal(input: FrontMevLimitInput) {
  const limit = frontMevCap(input);
  if (!limit || !limit.cap || input.frontCount <= limit.cap) return null;
  return limit.postMigration
    ? `With this buy amount, maximum Front MEV wallets is ${limit.cap}. Current: ${input.frontCount}. Reduce Front MEV count first.`
    : `Maximum Front MEV wallets is ${limit.cap}. Current: ${input.frontCount}.`;
}
