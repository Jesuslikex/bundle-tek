import type { PumpHolderReview } from './pump-holder-review';
import type { buildPumpCreateHolderMessage } from './pump-holder-message';
import { buildPumpHolderTargets } from './pump-holder-targets';
import { pumpDeveloperBuyTarget } from './pump-initial-buy-preparation';
import { decodePumpLaunchConfig } from './pump-launch-config';
import { validateProjectDocument } from './workspace-project';
import type { PumpHolderAllowances } from './pump-holder-funding';
const digestText = async (value: string) =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)),
    ),
    (byte) => byte.toString(16).padStart(2, '0'),
  ).join('');
export const pumpHolderAllowanceDigest = (limits: PumpHolderAllowances) =>
  digestText(
    JSON.stringify({
      deployerFeeAndRentLimitRaw: limits.deployerFeeAndRentLimitRaw,
      developerMaximumQuoteCostRaw: limits.developerMaximumQuoteCostRaw,
      holders: limits.holders.map((l) => ({
        address: l.address,
        feeAndRentLimitRaw: l.feeAndRentLimitRaw,
        maximumQuoteCostRaw: l.maximumQuoteCostRaw,
        minimumTokenOutputRaw: l.minimumTokenOutputRaw,
      })),
    }),
  );

/** Shared saved-plan targets and allowance validation. Does not validate packets, ownership or signing authority. */
export async function requirePumpHolderReviewPlan(
  review: Pick<
    PumpHolderReview,
    'input' | 'document' | 'allowances' | 'allowanceSha256'
  >,
  create: Parameters<typeof buildPumpCreateHolderMessage>[0]['create'],
  quote: Awaited<ReturnType<typeof buildPumpCreateHolderMessage>>['quote'],
) {
  if (
    !review.allowances ||
    Object.keys(review.allowances).sort().join(',') !==
      'deployerFeeAndRentLimitRaw,developerMaximumQuoteCostRaw,holders' ||
    !Array.isArray(review.allowances.holders) ||
    review.allowances.holders.some(
      (limit) =>
        Object.keys(limit).sort().join(',') !==
        'address,feeAndRentLimitRaw,maximumQuoteCostRaw,minimumTokenOutputRaw',
    )
  )
    throw new Error('Holder review allowance fields differ.');
  const document = validateProjectDocument(review.document),
    global = decodePumpLaunchConfig('Global', create.global.data);
  if (typeof global.initial_real_token_reserves !== 'bigint')
    throw new Error('Holder review curve reserve differs.');
  const targets = buildPumpHolderTargets(document, {
    tokenSupplyRaw: quote.tokenSupplyRaw,
    initialRealTokenReservesRaw: global.initial_real_token_reserves.toString(),
    quoteMint: create.quoteMint,
    quoteDecimals: quote.decimals,
  });
  if (
    document.options.wallets!.deployer!.address !== create.payer ||
    review.input.holders.length !== targets.items.length ||
    review.allowances.holders.length !== targets.items.length ||
    document.plan.tokenName !== create.name ||
    document.plan.ticker !== create.symbol ||
    (await pumpHolderAllowanceDigest(review.allowances)) !==
      review.allowanceSha256
  )
    throw new Error(
      'Holder packet differs from the saved project, targets or allowances.',
    );
  const developer = review.input.developer;
  if (
    document.plan.developerBuy > 0
      ? !developer ||
        developer.tokenAmountRaw !==
          pumpDeveloperBuyTarget(
            quote.tokenSupplyRaw,
            document.plan.developerBuy,
          )
      : developer !== undefined
  )
    throw new Error(
      'Holder review developer target differs from the saved supply plan.',
    );
  if (
    review.allowances.developerMaximumQuoteCostRaw !==
    (developer?.maximumQuoteCostRaw ?? null)
  )
    throw new Error('Holder review developer cap differs.');
  const feeLimit = (value: string, active: boolean) => {
    if (
      typeof value !== 'string' ||
      !/^(0|[1-9]\d{0,9})$/.test(value) ||
      BigInt(value) > 1000000000n ||
      (active ? value === '0' : value !== '0')
    )
      throw new Error('Holder review fee/rent allowance differs.');
  };
  feeLimit(review.allowances.deployerFeeAndRentLimitRaw, true);
  for (const [i, target] of targets.items.entries()) {
    const holder = review.input.holders[i],
      limit = review.allowances.holders[i];
    feeLimit(limit.feeAndRentLimitRaw, target.participates);
    if (
      holder.address !== target.wallet.address ||
      limit.address !== holder.address ||
      (target.participates
        ? holder.kind !== targets.kind
        : holder.kind !== 'none')
    )
      throw new Error('Holder review slot order or participation differs.');
    if (
      holder.kind === 'exact-base-output'
        ? holder.tokenAmountRaw !== target.tokenAmountRaw ||
          limit.maximumQuoteCostRaw !== holder.maximumQuoteCostRaw ||
          limit.minimumTokenOutputRaw !== null
        : holder.kind === 'exact-quote-input'
          ? holder.quoteAmountRaw !== target.quoteAmountRaw ||
            limit.minimumTokenOutputRaw !== holder.minimumTokenOutputRaw ||
            limit.maximumQuoteCostRaw !== null
          : limit.maximumQuoteCostRaw !== null ||
            limit.minimumTokenOutputRaw !== null
    )
      throw new Error('Holder review amount denomination or limit differs.');
  }
}
