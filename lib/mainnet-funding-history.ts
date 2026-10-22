import type { FundingCapture } from './mainnet-funding';
import { validatedFundingCapture } from './mainnet-funding';
import type { NativeWithdrawal } from './native-withdrawal';

export type MainnetFundingRecord = {
  sequence: number;
  createdAt: string;
  withdrawalId: string;
  wallet: string;
  walletRevision: number;
  recipient: string;
  amount: string;
  amountRaw: string;
  asset: { kind: 'native' | 'token'; mint: string | null; decimals: number };
  funding: FundingCapture;
  state: NativeWithdrawal['state'];
  evidenceGap: string | null;
  signature: string | null;
  feeLimitLamports: string;
  maximumDebitLamports: string;
  reserveLamports: string;
  reviewExpiresAt: string;
  receipt: {
    slot: number;
    observedAt: string;
    deliveredRaw: string;
    networkFeeLamports: string;
    accountRentLamports: string;
    transferFeeRaw: string | null;
  } | null;
  failure: {
    slot: number;
    observedAt: string;
    networkFeeLamports: string;
    label: string;
  } | null;
};
export type MainnetFundingHistory = {
  id: string;
  name: string;
  currentRevision: number;
  archived: boolean;
  revision: number | null;
  executionAllowed: false;
  events: MainnetFundingRecord[];
  progress: MainnetFundingProgress;
  // Optional extension; admitted independently so unavailable routes do not hide valid history.
  routeSource?: unknown;
  nextCursor: string | null;
};
export type MainnetFundingProgress =
  | { revision: number; records: MainnetFundingRecord[]; unavailable?: false }
  | { revision: number; records: null; unavailable: true };
// Up to100 saved recipients, each direct or with at most3 proxies (4 legs).
export const MAINNET_FUNDING_PROGRESS_LIMIT = 400;
export function mainnetFundingProgressKey(
  record: Pick<MainnetFundingRecord, 'funding'>,
) {
  return `${record.funding.item}:${record.funding.leg ?? 'direct'}`;
}

export function mainnetFundingHistoryCursor(
  id: string,
  revision: number | null,
  sequence: number,
) {
  return `${id}~${revision ?? 'all'}~${sequence}`;
}
export function readMainnetFundingHistoryCursor(
  cursor: string,
  id: string,
  revision: number | null,
) {
  const prefix = `${id}~${revision ?? 'all'}~`;
  if (!cursor.startsWith(prefix)) throw new Error('Funding cursor differs.');
  const value = cursor.slice(prefix.length);
  if (!/^[1-9]\d{0,15}$/.test(value) || !Number.isSafeInteger(Number(value)))
    throw new Error('Funding cursor differs.');
  return Number(value);
}

const states = [
  'awaiting_signature',
  'signing',
  'signed',
  'submitted',
  'finalized',
  'failed',
  'cancelled',
];
const iso = (value: unknown) =>
  typeof value === 'string' &&
  value.length === 24 &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;
const integer = (value: unknown) =>
  typeof value === 'string' &&
  /^(0|[1-9]\d{0,19})$/.test(value) &&
  BigInt(value) <= (1n << 64n) - 1n;
function recordContext(
  record: MainnetFundingRecord,
  id: string,
  revision: number | null,
) {
  validatedFundingCapture(record?.funding);
  if (
    !record ||
    !Number.isSafeInteger(record.sequence) ||
    record.sequence < 1 ||
    !iso(record.createdAt) ||
    typeof record.withdrawalId !== 'string' ||
    typeof record.wallet !== 'string' ||
    typeof record.recipient !== 'string' ||
    !Number.isSafeInteger(record.walletRevision) ||
    record.walletRevision < 1 ||
    typeof record.amount !== 'string' ||
    !/^(0|[1-9]\d*)(\.\d+)?$/.test(record.amount) ||
    !integer(record.amountRaw) ||
    !record.asset ||
    !['native', 'token'].includes(record.asset.kind) ||
    !Number.isInteger(record.asset.decimals) ||
    record.asset.decimals < 0 ||
    record.asset.decimals > 255 ||
    (record.asset.kind === 'native'
      ? record.asset.mint !== null || record.asset.decimals !== 9
      : typeof record.asset.mint !== 'string') ||
    !record.funding ||
    record.funding.planId !== id ||
    (revision !== null && record.funding.revision !== revision) ||
    !Number.isSafeInteger(record.funding.revision) ||
    record.funding.revision < 1 ||
    !Number.isInteger(record.funding.item) ||
    record.funding.item < 1 ||
    record.funding.item > 100 ||
    record.funding.format !== 'mainnet-funding-v1' ||
    !/^[a-f0-9]{64}$/.test(record.funding.termsSha256) ||
    !iso(record.funding.scheduledAt) ||
    !states.includes(record.state) ||
    !(record.signature === null || typeof record.signature === 'string') ||
    !integer(record.feeLimitLamports) ||
    !integer(record.maximumDebitLamports) ||
    !integer(record.reserveLamports) ||
    !iso(record.reviewExpiresAt) ||
    (record.receipt !== null && record.state !== 'finalized') ||
    (record.state === 'finalized' &&
      record.receipt === null &&
      record.evidenceGap === null) ||
    (record.failure !== null && record.state !== 'failed') ||
    !(
      record.evidenceGap === null ||
      (typeof record.evidenceGap === 'string' &&
        record.evidenceGap.length > 0 &&
        record.evidenceGap.length <= 300)
    ) ||
    (record.evidenceGap !== null &&
      (!['finalized', 'failed'].includes(record.state) ||
        record.receipt !== null ||
        record.failure !== null))
  )
    throw new Error('Mainnet funding history context differs.');
  if (record.funding.leg !== undefined && record.asset.kind !== 'native')
    throw new Error('Proxy funding legs require native SOL evidence.');
  for (const outcome of [record.receipt, record.failure])
    if (
      outcome &&
      (!Number.isSafeInteger(outcome.slot) ||
        outcome.slot < 0 ||
        !iso(outcome.observedAt) ||
        Date.parse(outcome.observedAt) > Date.parse(record.createdAt) ||
        !integer(outcome.networkFeeLamports))
    )
      throw new Error('Mainnet funding outcome differs.');
  if (
    record.receipt &&
    (!integer(record.receipt.deliveredRaw) ||
      !integer(record.receipt.accountRentLamports) ||
      !(
        record.receipt.transferFeeRaw === null ||
        integer(record.receipt.transferFeeRaw)
      ))
  )
    throw new Error('Mainnet funding receipt differs.');
}
export function decodeMainnetFundingProgress(
  value: unknown,
  id: string,
  revision: number,
): MainnetFundingProgress {
  const progress = value as MainnetFundingProgress;
  if (!progress || progress.revision !== revision)
    throw new Error('Funding progress scope differs.');
  if (progress.unavailable === true) {
    if (progress.records !== null)
      throw new Error('Unavailable funding progress must withhold all counts.');
    return progress;
  }
  if (
    (progress.unavailable !== undefined && progress.unavailable !== false) ||
    !Array.isArray(progress.records) ||
    progress.records.length > MAINNET_FUNDING_PROGRESS_LIMIT
  )
    throw new Error('Funding progress unavailable.');
  const records = progress.records;
  records.forEach((record) => recordContext(record, id, revision));
  if (
    new Set(records.map(mainnetFundingProgressKey)).size !== records.length ||
    new Set(records.map((record) => record.sequence)).size !== records.length ||
    new Set(records.map((record) => record.withdrawalId)).size !==
      records.length ||
    new Set(records.map((record) => record.funding.termsSha256)).size > 1
  )
    throw new Error('Duplicate or inconsistent funding progress.');
  const forms = new Map<number, boolean>();
  for (const record of records) {
    const explicit = record.funding.leg !== undefined,
      item = record.funding.item;
    if (forms.has(item) && forms.get(item) !== explicit)
      throw new Error('Mixed direct and proxy funding progress.');
    forms.set(item, explicit);
  }
  return progress;
}
export function decodeMainnetFundingHistory(
  value: unknown,
  id: string,
  revision: number | null,
): MainnetFundingHistory {
  const page = value as MainnetFundingHistory;
  if (
    !page ||
    page.id !== id ||
    page.revision !== revision ||
    page.executionAllowed !== false ||
    typeof page.name !== 'string' ||
    typeof page.archived !== 'boolean' ||
    !Number.isSafeInteger(page.currentRevision) ||
    page.currentRevision < 1 ||
    !Array.isArray(page.events) ||
    page.events.length > 50 ||
    !(page.nextCursor === null || typeof page.nextCursor === 'string')
  )
    throw new Error('Mainnet funding history unavailable or context differs.');
  page.events.forEach((record) => recordContext(record, id, revision));
  decodeMainnetFundingProgress(
    page.progress,
    id,
    revision ?? page.currentRevision,
  );
  if (
    new Set(page.events.map((event) => event.sequence)).size !==
    page.events.length
  )
    throw new Error('Duplicate mainnet funding history context.');
  if (page.nextCursor !== null)
    readMainnetFundingHistoryCursor(page.nextCursor, id, revision);
  return page;
}

export function mainnetFundingStateLabel(state: NativeWithdrawal['state']) {
  return {
    awaiting_signature: 'Review retained; signature required',
    signing: 'Signing outcome unresolved',
    signed: 'Signature registered; submission not recorded',
    submitted: 'Submission started; finalized outcome unresolved',
    finalized: 'Finalization recorded; delivery evidence unverified',
    failed: 'Failure recorded; outcome evidence unverified',
    cancelled: 'Unsigned attempt cancelled',
  }[state];
}
export function mainnetFundingRecordLabel(record: MainnetFundingRecord) {
  if (record.receipt)
    return record.funding.leg === undefined
      ? 'Finalized delivery verified'
      : 'Finalized proxy-leg transfer verified';
  if (record.failure) return 'Finalized execution failure verified';
  return mainnetFundingStateLabel(record.state);
}
