import { validateFunding, type SavedFunding } from './funding-plan';
import { fundingLegs, selectedFundingCapture } from './mainnet-funding';
import {
  decodeMainnetFundingHistory,
  decodeMainnetFundingProgress,
  mainnetFundingProgressKey,
  type MainnetFundingHistory,
  type MainnetFundingRecord,
} from './mainnet-funding-history';
import { solanaTokenAtoms } from './solana-token-amount';

/** Selected owner's saved funding terms only, never a wallet vault or authorization. */
export type FundingRouteSource = {
  format: 'funding-route-source-v1';
  planId: string;
  revision: number;
  updatedAt: string;
  termsJson: string;
  termsSha256: string;
  executionAllowed: false;
};
export type FundingRouteStep = {
  leg: number | null;
  wallet: string;
  recipient: string;
  amountRaw: string;
  record: MainnetFundingRecord | null;
  receiptMatches: boolean;
};
export type FundingRouteHistory = {
  planId: string;
  revision: number;
  updatedAt: string;
  termsSha256: string;
  executionAllowed: false;
  routes: {
    item: number;
    recipient: string;
    amountRaw: string;
    scheduledAt: string;
    steps: FundingRouteStep[];
  }[];
};

async function sourceTerms(plan: SavedFunding) {
  const document = validateFunding(plan.document);
  if (
    document.chain !== 'Solana' ||
    document.currency !== 'SOL' ||
    document.assetAddress !== undefined ||
    document.source !== 'Wallet' ||
    !document.funderAddress
  )
    throw new Error('Native wallet funding source unavailable.');
  const first = fundingLegs(document, 1)[0];
  const capture = await selectedFundingCapture(
    { ...plan, document },
    {
      planId: plan.id,
      revision: plan.revision,
      item: 1,
      ...(document.items[0].proxies ? { leg: 1 } : {}),
    },
    first,
  );
  return { document, termsSha256: capture.termsSha256 };
}

export async function createFundingRouteSource(
  plan: SavedFunding,
): Promise<FundingRouteSource> {
  const { document, termsSha256 } = await sourceTerms(plan);
  return {
    format: 'funding-route-source-v1',
    planId: plan.id,
    revision: plan.revision,
    updatedAt: plan.updatedAt,
    termsJson: JSON.stringify(document),
    termsSha256,
    executionAllowed: false,
  };
}

/** Receipt coverage, never ordering, current balance, readiness or permission to repeat. */
export async function decodeFundingRouteHistory(
  value: unknown,
  page: MainnetFundingHistory,
): Promise<FundingRouteHistory> {
  decodeMainnetFundingHistory(page, page.id, page.revision);
  const source = value as FundingRouteSource;
  const revision = page.revision ?? page.currentRevision;
  if (
    !source ||
    Object.keys(source).sort().join(',') !==
      'executionAllowed,format,planId,revision,termsJson,termsSha256,updatedAt' ||
    source.format !== 'funding-route-source-v1' ||
    source.executionAllowed !== false ||
    source.planId !== page.id ||
    source.revision !== revision ||
    source.revision !== page.currentRevision ||
    typeof source.updatedAt !== 'string' ||
    !Number.isFinite(Date.parse(source.updatedAt)) ||
    new Date(source.updatedAt).toISOString() !== source.updatedAt ||
    typeof source.termsJson !== 'string' ||
    source.termsJson.length > 131072 ||
    !/^[a-f0-9]{64}$/.test(source.termsSha256)
  )
    throw new Error('Exact saved funding route unavailable.');
  const progress = decodeMainnetFundingProgress(
    page.progress,
    page.id,
    revision,
  );
  if (progress.unavailable)
    throw new Error('Funding route progress unavailable.');
  const plan: SavedFunding = {
    id: source.planId,
    revision,
    updatedAt: source.updatedAt,
    archived: page.archived,
    document: JSON.parse(source.termsJson),
  };
  const { document, termsSha256 } = await sourceTerms(plan);
  if (
    JSON.stringify(document) !== source.termsJson ||
    termsSha256 !== source.termsSha256
  )
    throw new Error('Saved route source differs from its exact terms.');
  const signatures = progress.records.flatMap((record) =>
    record.signature === null ? [] : [record.signature],
  );
  if (new Set(signatures).size !== signatures.length)
    throw new Error('Funding route signatures overlap.');
  const records = new Map(
    progress.records.map((record) => [
      mainnetFundingProgressKey(record),
      record,
    ]),
  );
  const expected = new Set<string>();
  const routes = document.items.map((item, i) => ({
    item: i + 1,
    recipient: item.address,
    amountRaw: fundingLegs(document, i + 1).at(-1)!.amountRaw,
    scheduledAt: item.scheduledAt,
    steps: fundingLegs(document, i + 1).map((step, n) => {
      const leg = item.proxies ? n + 1 : null;
      const key = `${i + 1}:${leg ?? 'direct'}`;
      expected.add(key);
      const record = records.get(key) ?? null;
      if (
        record &&
        (record.funding.termsSha256 !== termsSha256 ||
          record.funding.scheduledAt !== item.scheduledAt ||
          record.wallet !== step.wallet ||
          record.recipient !== step.recipient ||
          record.amountRaw !== step.amountRaw ||
          record.asset.kind !== 'native' ||
          (record.receipt !== null && !record.signature) ||
          solanaTokenAtoms(record.amount, 9).toString() !== record.amountRaw)
      )
        throw new Error('Captured transfer differs from the saved route.');
      return {
        ...step,
        leg,
        record,
        receiptMatches: Boolean(
          record?.receipt &&
          record.signature &&
          record.receipt.deliveredRaw === step.amountRaw,
        ),
      };
    }),
  }));
  if ([...records.keys()].some((key) => !expected.has(key)))
    throw new Error('Funding history contains an unplanned route step.');
  return {
    planId: source.planId,
    revision,
    updatedAt: source.updatedAt,
    termsSha256,
    routes,
    executionAllowed: false,
  };
}
