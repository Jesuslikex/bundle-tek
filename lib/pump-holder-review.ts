import {
  getTransactionDecoder,
  getTransactionEncoder,
  getBase64Decoder,
} from '@solana/kit-v1';
import {
  decodePumpSigningInput,
  type PumpSigningInput,
} from './pump-launch-signing';
import {
  buildPumpCreateHolderMessage,
  type PumpHolderBuy,
} from './pump-holder-message';
import { buildPumpHolderTargets } from './pump-holder-targets';
import { pumpDeveloperBuyTarget } from './pump-initial-buy-preparation';
import { decodePumpLaunchConfig } from './pump-launch-config';
import {
  validateProjectDocument,
  type ProjectDocument,
} from './workspace-project';
import type { PumpHolderAllowances } from './pump-holder-funding';

export type PumpHolderReview = {
  format: 'pump-create-holders-review-v1';
  id: string;
  projectId: string;
  projectUpdatedAt: string;
  releaseId: string;
  expiresAt: string;
  transaction: string;
  sha256: string;
  contextSha256: string;
  input: {
    create: PumpSigningInput;
    developer?: { tokenAmountRaw: string; maximumQuoteCostRaw: string };
    holders: PumpHolderBuy[];
  };
  document: ProjectDocument;
  allowances: PumpHolderAllowances;
  deployerBindingSha256: string;
  holderBindingSha256: string;
  allowanceSha256: string;
};
export const canonicalPumpHolderJson = (value: unknown) =>
  JSON.stringify(value, (_key, item) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map((key) => [key, item[key]]),
        )
      : item,
  );
const digestText = async (value: string) =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)),
    ),
    (byte) => byte.toString(16).padStart(2, '0'),
  ).join('');
export const pumpHolderDigest = (value: unknown) =>
  digestText(canonicalPumpHolderJson(value));
const allowanceDigest = (limits: PumpHolderAllowances) =>
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

/** Reconstruct the complete immutable review. This validator grants no signing permission. */
export async function requirePumpHolderReview(
  supplied: PumpHolderReview,
  requireLive = true,
) {
  const review = structuredClone(supplied);
  if (
    review.format !== 'pump-create-holders-review-v1' ||
    Object.keys(review).sort().join(',') !==
      'allowanceSha256,allowances,contextSha256,deployerBindingSha256,document,expiresAt,format,holderBindingSha256,id,input,projectId,projectUpdatedAt,releaseId,sha256,transaction' ||
    [
      review.id,
      review.projectId,
      review.projectUpdatedAt,
      review.releaseId,
    ].some((v) => typeof v !== 'string' || !v || v.length > 256) ||
    [
      review.sha256,
      review.contextSha256,
      review.deployerBindingSha256,
      review.holderBindingSha256,
      review.allowanceSha256,
    ].some((v) => !/^[a-f0-9]{64}$/.test(v)) ||
    !Number.isFinite(Date.parse(review.expiresAt)) ||
    (requireLive && Date.parse(review.expiresAt) <= Date.now()) ||
    typeof review.transaction !== 'string' ||
    review.transaction.length > 5464 ||
    !review.input ||
    Object.keys(review.input).some(
      (k) => !['create', 'developer', 'holders'].includes(k),
    )
  )
    throw new Error('Holder review scope, binding or lifetime differs.');
  const { contextSha256, ...context } = review;
  if ((await pumpHolderDigest(context)) !== contextSha256)
    throw new Error('Holder review context hash differs.');
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
  const create = decodePumpSigningInput(review.input.create),
    built = await buildPumpCreateHolderMessage({ ...review.input, create }),
    document = validateProjectDocument(review.document),
    global = decodePumpLaunchConfig('Global', create.global.data);
  if (typeof global.initial_real_token_reserves !== 'bigint')
    throw new Error('Holder review curve reserve differs.');
  const targets = buildPumpHolderTargets(document, {
    tokenSupplyRaw: built.quote.tokenSupplyRaw,
    initialRealTokenReservesRaw: global.initial_real_token_reserves.toString(),
    quoteMint: create.quoteMint,
    quoteDecimals: built.quote.decimals,
  });
  if (
    document.options.wallets!.deployer!.address !== create.payer ||
    review.input.holders.length !== targets.items.length ||
    review.allowances.holders.length !== targets.items.length ||
    built.packetSha256 !== review.sha256 ||
    built.transaction !== review.transaction ||
    document.plan.tokenName !== create.name ||
    document.plan.ticker !== create.symbol ||
    (await allowanceDigest(review.allowances)) !== review.allowanceSha256
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
            built.quote.tokenSupplyRaw,
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
  const raw = Uint8Array.from(atob(review.transaction), (c) => c.charCodeAt(0)),
    tx = getTransactionDecoder().decode(raw);
  if (
    raw.length > 4096 ||
    getBase64Decoder().decode(getTransactionEncoder().encode(tx)) !==
      review.transaction ||
    Object.values(tx.signatures).some((signature) => signature !== null) ||
    JSON.stringify(Object.keys(tx.signatures).sort()) !==
      JSON.stringify([...built.requiredSigners].sort())
  )
    throw new Error(
      'Holder review must contain the complete canonical unsigned signer set.',
    );
  if (requireLive && Date.parse(review.expiresAt) <= Date.now())
    throw new Error('Holder review expired.');
  return { review, built, transaction: tx };
}
