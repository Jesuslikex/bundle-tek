import { PUMP_NATIVE_QUOTE } from './pump-launch-config';
import { allocateHolderBaseUnits } from './launch-distribution';
import { pumpDeveloperBuyTarget } from './pump-initial-buy-preparation';
import { holdersBuyUnit } from './launch-buy';
import { quoteCatalog } from './quote-catalog';
import {
  canonicalPumpHolderJson,
  requirePumpHolderReview,
  type PumpHolderReview,
} from './pump-holder-review';
import {
  validateProjectDocument,
  type ProjectDocument,
} from './workspace-project';
import type { PumpHolderConsent } from './pump-holder-signing';
import type { preparePumpHolderReview } from './pump-holder-review-service';

export type HolderLaunch = Awaited<ReturnType<typeof preparePumpHolderReview>>;
export type HolderProject = {
  id: string;
  updatedAt: string;
  payer?: { address: string; revision: number };
  document?: ProjectDocument;
};
const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const uint = (v: unknown): v is string =>
  typeof v === 'string' &&
  /^(0|[1-9]\d{0,19})$/.test(v) &&
  BigInt(v) <= (1n << 64n) - 1n;
export function holderAmountRaw(value: string, decimals: number, zero = false) {
  if (
    !Number.isInteger(decimals) ||
    decimals < 0 ||
    decimals > 18 ||
    !/^(0|[1-9]\d{0,19})(\.\d{1,18})?$/.test(value)
  )
    throw new Error('Enter an exact non-negative amount.');
  const [whole, fraction = ''] = value.split('.');
  if (fraction.length > decimals)
    throw new Error('Amount exceeds the selected asset precision.');
  const n =
    BigInt(whole) * 10n ** BigInt(decimals) +
    BigInt(fraction.padEnd(decimals, '0') || '0');
  if ((!zero && n === 0n) || n > (1n << 64n) - 1n)
    throw new Error('Enter a positive amount within the asset limit.');
  return n.toString();
}
export function holderDisplayRaw(raw: string, decimals: number) {
  if (!uint(raw)) return 'Unavailable';
  if (decimals === 0) return raw;
  const text = raw.padStart(decimals + 1, '0'),
    fraction = text.slice(-decimals).replace(/0+$/, '');
  return text.slice(0, -decimals) + (fraction ? '.' + fraction : '');
}
export function holderQuote(document: ProjectDocument) {
  const matches = quoteCatalog('Solana', 'PumpFun').assets.filter(
    (q) =>
      q.symbol === document.plan.currency &&
      (!document.plan.quoteAddress || q.address === document.plan.quoteAddress),
  );
  if (matches.length !== 1)
    throw new Error('Select one exact Pump quote asset and save.');
  return matches[0];
}
export type HolderSizing = {
  address: string;
  kind: 'none' | 'exact-base-output' | 'exact-quote-input';
  raw: string;
}[];
/** Preview only: the complete owned server preparation re-reads supply and reconstructs all targets. */
export function holderSizing(
  project: HolderProject,
  releaseId: string,
  mint: string,
  origin: string,
  value: unknown,
): HolderSizing {
  const document = validateProjectDocument(project.document),
    quote = holderQuote(document);
  if (
    !record(value) ||
    value.format !== 'pump-create-preflight-v1' ||
    value.projectId !== project.id ||
    value.projectUpdatedAt !== project.updatedAt ||
    value.metadataReleaseId !== releaseId ||
    value.mint !== mint ||
    value.payer !== project.payer?.address ||
    value.metadataUri !== `${origin}/api/launch/metadata/${releaseId}` ||
    value.signingAllowed !== false ||
    !record(value.quote) ||
    value.quote.mint !== quote.address ||
    value.quote.decimals !== quote.decimals ||
    !uint(value.quote.tokenSupplyRaw) ||
    value.quote.tokenSupplyRaw === '0'
  )
    throw new Error(
      'Holder target observation differs from this saved launch.',
    );
  const selection = document.options.wallets;
  if (
    !selection ||
    selection.chain !== 'Solana' ||
    selection.recipients.length !== document.plan.holderCount ||
    document.plan.scheduled
  )
    throw new Error('Save the complete unscheduled holder selection first.');
  const supply = holdersBuyUnit(document.plan) === 'supply';
  const total = supply
    ? pumpDeveloperBuyTarget(
        value.quote.tokenSupplyRaw,
        document.plan.holdersBuy,
      )
    : holderAmountRaw(document.plan.holdersBuyQuote ?? '', quote.decimals);
  return allocateHolderBaseUnits(document.plan, BigInt(total)).map(
    (amount, i) => ({
      address: selection.recipients[i].address,
      kind:
        amount === 0n
          ? 'none'
          : supply
            ? 'exact-base-output'
            : 'exact-quote-input',
      raw: amount.toString(),
    }),
  );
}
export const holderConsent = (review: PumpHolderReview): PumpHolderConsent => ({
  approved: true,
  reviewId: review.id,
  sha256: review.sha256,
  contextSha256: review.contextSha256,
  approvedScope: 'create-developer-and-holder-buys',
  acknowledgeSimulationLimits: true,
});

/** Validate history as well as current reviews. Expiry closes signing, never recovery. */
export async function parseHolderLaunch(
  value: unknown,
  projectId: string,
): Promise<HolderLaunch> {
  const fail = (): never => {
    throw new Error(
      'Holder launch response is incomplete or changed. Reload saved history.',
    );
  };
  if (
    !record(value) ||
    value.format !== 'pump-create-holders-review-v1' ||
    !record(value.review) ||
    !record(value.simulation) ||
    ![
      'review',
      'approved',
      'signed',
      'submitting',
      'submitted',
      'finalized',
      'failed',
      'cancelled',
    ].includes(String(value.state)) ||
    typeof value.completeLaunch !== 'boolean' ||
    typeof value.signingAllowed !== 'boolean' ||
    value.executionAllowed !== false
  )
    return fail();
  const { review } = await requirePumpHolderReview(
    value.review as PumpHolderReview,
    false,
  );
  if (
    review.projectId !== projectId ||
    (value.signature !== null &&
      (typeof value.signature !== 'string' ||
        !/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(value.signature)))
  )
    return fail();
  const checked = value.simulation;
  if (
    !record(checked.packet) ||
    checked.packet.packetSha256 !== review.sha256 ||
    canonicalPumpHolderJson(checked.allowances) !==
      canonicalPumpHolderJson(review.allowances) ||
    !record(checked.allWalletSimulation)
  )
    return fail();
  const sim = checked.allWalletSimulation,
    accounting = sim.accounting;
  if (
    sim.packetSha256 !== review.sha256 ||
    sim.settlementValidated !== true ||
    sim.sourceBankMatched !== true ||
    !uint(sim.networkFeeRaw) ||
    !record(accounting) ||
    accounting.packetSha256 !== review.sha256 ||
    accounting.accountingValidated !== true ||
    accounting.rpcCollectionRequired !== false ||
    !Array.isArray(accounting.wallets) ||
    !Array.isArray(accounting.rentAccounts)
  )
    return fail();
  const active = new Map<string, (typeof review.input.holders)[number]>(
    review.input.holders
      .filter((h) => h.kind !== 'none')
      .map((h) => [h.address, h]),
  );
  const expected = new Set<string>([
    ...active.keys(),
    ...(review.input.developer ? [review.input.create.payer] : []),
  ]);
  for (const row of accounting.wallets) {
    if (
      !record(row) ||
      typeof row.address !== 'string' ||
      !expected.delete(row.address) ||
      [
        'tokenAmountRaw',
        'quoteDebitRaw',
        'solDebitRaw',
        'feeAndRentDebitRaw',
        'volumeGainRaw',
      ].some((k) => !uint(row[k]))
    )
      return fail();
    const limit =
      row.address === review.input.create.payer
        ? {
            feeAndRentLimitRaw: review.allowances.deployerFeeAndRentLimitRaw,
            maximumQuoteCostRaw: review.allowances.developerMaximumQuoteCostRaw,
          }
        : review.allowances.holders.find((l) => l.address === row.address);
    const holder = active.get(row.address);
    const target =
      row.address === review.input.create.payer
        ? review.input.developer?.tokenAmountRaw
        : holder?.kind === 'exact-base-output'
          ? holder.tokenAmountRaw
          : undefined;
    if (
      (target !== undefined && row.tokenAmountRaw !== target) ||
      BigInt(String(row.solDebitRaw)) !==
        BigInt(String(row.feeAndRentDebitRaw)) +
          (review.input.create.quoteMint === PUMP_NATIVE_QUOTE
            ? BigInt(String(row.quoteDebitRaw))
            : 0n)
    )
      return fail();
    if (
      !limit ||
      BigInt(String(row.feeAndRentDebitRaw)) >
        BigInt(limit.feeAndRentLimitRaw) ||
      (limit.maximumQuoteCostRaw !== null &&
        BigInt(String(row.quoteDebitRaw)) >
          BigInt(limit.maximumQuoteCostRaw)) ||
      (holder?.kind === 'exact-quote-input' &&
        (BigInt(String(row.quoteDebitRaw)) > BigInt(holder.quoteAmountRaw) ||
          BigInt(String(row.tokenAmountRaw)) <
            BigInt(holder.minimumTokenOutputRaw)))
    )
      return fail();
  }
  if (
    expected.size ||
    ['totalTokenOutputRaw', 'totalQuoteDebitRaw', 'buybackFeeRaw'].some(
      (k) => !uint(accounting[k]),
    )
  )
    return fail();
  const rentByPayer = new Map<string, bigint>();
  const payers = new Set<string>([review.input.create.payer, ...active.keys()]);
  for (const rent of accounting.rentAccounts) {
    if (
      !record(rent) ||
      typeof rent.payer !== 'string' ||
      !payers.has(rent.payer) ||
      !uint(rent.fundingRaw)
    )
      return fail();
    rentByPayer.set(
      rent.payer,
      (rentByPayer.get(rent.payer) ?? 0n) + BigInt(rent.fundingRaw),
    );
  }
  if (
    !review.input.developer &&
    BigInt(String(sim.networkFeeRaw)) +
      (rentByPayer.get(review.input.create.payer) ?? 0n) >
      BigInt(review.allowances.deployerFeeAndRentLimitRaw)
  )
    return fail();
  if (
    accounting.wallets
      .reduce(
        (sum: bigint, row: { quoteDebitRaw: string }) =>
          sum + BigInt(row.quoteDebitRaw),
        0n,
      )
      .toString() !== accounting.totalQuoteDebitRaw ||
    accounting.wallets
      .reduce(
        (sum: bigint, row: { tokenAmountRaw: string }) =>
          sum + BigInt(row.tokenAmountRaw),
        0n,
      )
      .toString() !== accounting.totalTokenOutputRaw
  )
    return fail();
  if (value.receipt !== null) {
    const r = value.receipt;
    if (
      !record(r) ||
      r.packetSha256 !== review.sha256 ||
      r.contextSha256 !== review.contextSha256 ||
      r.network !== 'mainnet' ||
      r.commitment !== 'finalized'
    )
      return fail();
    if (r.kind === 'finalized') {
      if (
        value.state !== (r.succeeded === true ? 'finalized' : 'failed') ||
        typeof r.succeeded !== 'boolean' ||
        !uint(r.slot) ||
        r.containsHolderBuys !== true ||
        r.signature !== value.signature ||
        typeof r.networkFeeUnresolved !== 'boolean'
      )
        return fail();
    } else if (r.kind === 'expired-unobserved') {
      if (
        value.state !== 'cancelled' ||
        r.networkFeeUnresolved !== true ||
        r.mintAbsent !== true ||
        !uint(r.finalizedBlockHeight) ||
        !uint(r.mintObservedSlot)
      )
        return fail();
    } else return fail();
  }
  const complete =
    value.state === 'finalized' &&
    record(value.receipt) &&
    value.receipt.kind === 'finalized' &&
    value.receipt.succeeded === true;
  if (value.completeLaunch !== complete) return fail();
  return value as HolderLaunch;
}
