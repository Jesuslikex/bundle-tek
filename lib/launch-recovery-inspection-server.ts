import { PANEL_JSON_RESPONSE_BYTES } from './read-bounded-panel-json';
import {
  validateLaunchRecoveryInspection,
  validateLaunchInspectionReference,
  LAUNCH_INSPECTION_HOLDER_LIMIT,
  type LaunchInspectionReference,
  type LaunchRecoveryInspection,
} from './launch-recovery-inspection';

export class LaunchInspectionStoredError extends Error {
  constructor(readonly status: number) {
    super(
      status === 404
        ? 'Saved launch record not found.'
        : status === 409
          ? 'This saved launch format cannot be inspected.'
          : 'Saved launch inspection is unavailable.',
    );
    this.name = 'LaunchInspectionStoredError';
  }
}
type RecordValue = Record<string, unknown>;
type Row = {
  id: string;
  project_id: string;
  payer: string;
  mint: string;
  terms: string;
  review: string;
  state: string;
  signature: string | null;
  created_at: string;
  expires_at: string;
  hasReceipt: number;
  venue?: string;
  sha256?: string;
  minimum_slot?: number;
};
const fail = (): never => {
  throw new LaunchInspectionStoredError(503);
};
function record(value: unknown): RecordValue {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    return fail();
  return value as RecordValue;
}
function parse(text: unknown): RecordValue {
  if (
    typeof text !== 'string' ||
    new TextEncoder().encode(text).length > PANEL_JSON_RESPONSE_BYTES
  )
    return fail();
  return record(JSON.parse(text));
}
function optionalRecord(value: unknown) {
  return value === undefined || value === null ? null : record(value);
}
function raw(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !/^(0|[1-9]\d{0,79})$/.test(value))
    return fail();
  return value;
}
function same(a: unknown, b: unknown) {
  if (a !== b) fail();
}
function whenBoth(a: unknown, b: unknown) {
  if (a !== undefined && a !== null && b !== undefined && b !== null)
    same(a, b);
}
function hash(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) return fail();
  return value;
}
function scalarTermsEqual(review: RecordValue, terms: RecordValue) {
  const keys = Object.keys(terms).filter((key) => key !== 'origin');
  if (Object.keys(review).length !== keys.length) return fail();
  for (const key of keys) {
    const value = terms[key];
    if (
      (value !== null &&
        !['string', 'number', 'boolean'].includes(typeof value)) ||
      !Object.hasOwn(review, key) ||
      review[key] !== value
    )
      return fail();
  }
}
/** Saved-only SELECT projection. No packet reconstruction, provider call or receipt verification. */
export async function readLaunchRecoveryInspection(
  db: D1Database,
  owner: string,
  reference: LaunchInspectionReference,
  signal: AbortSignal,
): Promise<LaunchRecoveryInspection> {
  try {
    signal.throwIfAborted();
    reference = validateLaunchInspectionReference(reference);
    if (typeof owner !== 'string' || !owner || owner.length > 256)
      return fail();
    if (reference.reviewKind === 'uncategorized')
      throw new LaunchInspectionStoredError(409);
    const pump = reference.source === 'pump';
    if (
      pump
        ? !['create', 'developer', 'holders', 'groups'].includes(
            reference.reviewKind,
          )
        : reference.reviewKind !== 'single' ||
          !['meteora-dbc', 'stonkfun', 'launchlab'].includes(reference.source)
    )
      throw new LaunchInspectionStoredError(409);
    const table = pump
      ? 'pump_launch_reviews'
      : reference.source === 'launchlab'
        ? 'launchlab_launch_recoveries'
        : 'venue_launch_recoveries';
    const columns =
      'id,project_id,payer,mint,terms,review,state,signature,created_at,expires_at,(receipt IS NOT NULL) AS hasReceipt';
    const row = await db
      .prepare(
        `SELECT ${columns}${pump ? '' : ',venue,sha256,minimum_slot'} FROM ${table} WHERE owner_id=? AND id=?${pump ? '' : ' AND venue=?'}`,
      )
      .bind(owner, reference.id, ...(pump ? [] : [reference.source]))
      .first<Row>();
    signal.throwIfAborted();
    if (!row) throw new LaunchInspectionStoredError(404);
    same(row.id, reference.id);
    same(row.project_id, reference.projectId);
    same(row.mint, reference.mint);
    same(row.created_at, reference.createdAt);
    same(row.expires_at, reference.expiresAt);
    if (row.hasReceipt !== 0 && row.hasReceipt !== 1) return fail();
    const review = parse(row.review),
      terms = parse(row.terms),
      input = record(review.input);
    same(terms.projectId, row.project_id);
    same(terms.payer, row.payer);
    same(terms.mint, row.mint);
    same(review.expiresAt, row.expires_at);
    const kind = reference.reviewKind;
    let create = input;
    if (pump) {
      same(review.id, row.id);
      same(review.projectId, row.project_id);
      same(review.projectUpdatedAt, terms.updatedAt);
      same(review.releaseId, terms.releaseId);
      const format = review.format;
      const actualKind =
        format === 'pump-launch-group-review-v1'
          ? 'groups'
          : format === 'pump-create-holders-review-v1'
            ? 'holders'
            : format === 'pump-create-buy-review-v1'
              ? 'developer'
              : format === undefined || format === null || format === ''
                ? terms.maximumQuoteCostRaw !== undefined &&
                  terms.maximumQuoteCostRaw !== null
                  ? 'developer'
                  : 'create'
                : 'uncategorized';
      same(actualKind, kind);
      if (kind !== 'create') create = record(input.create);
    } else {
      same(row.venue, reference.source);
      same(
        review.format,
        reference.source === 'meteora-dbc'
          ? 'meteora-dbc-launch-review-v1'
          : reference.source === 'stonkfun'
            ? 'stonkfun-launch-review-v1'
            : 'launchlab-launch-review-v1',
      );
      scalarTermsEqual(record(review.terms), terms);
      same(review.sha256, row.sha256);
      same(review.minimumSlot, row.minimum_slot);
      if (!Number.isSafeInteger(row.minimum_slot) || row.minimum_slot! < 0)
        return fail();
      if (reference.source === 'launchlab') {
        if (!['LetsBonk', 'Surge'].includes(terms.venue as string))
          return fail();
        same(input.venue, terms.venue);
        same(record(review.summary).venue, terms.venue);
      }
    }
    same(create.mint, row.mint);
    same(create.payer, row.payer);
    const hashes: LaunchRecoveryInspection['hashes'] = [],
      budgets: LaunchRecoveryInspection['budgets'] = [],
      participants: LaunchRecoveryInspection['participants'] = [];
    const developer =
      pump && (kind === 'holders' || kind === 'groups')
        ? optionalRecord(input.developer)
        : null;
    const devBuy = pump ? null : raw(terms.devBuyRaw);
    participants.push({
      role: 'developer',
      address: row.payer,
      mode: pump
        ? kind === 'create'
          ? 'not-requested'
          : kind === 'developer' || developer
            ? 'exact-base-output'
            : 'not-requested'
        : devBuy === null
          ? 'unavailable'
          : devBuy === '0'
            ? 'not-requested'
            : 'exact-quote-input',
    });
    const addHash = (
      kind: LaunchRecoveryInspection['hashes'][number]['kind'],
      value: unknown,
      index: number | null = null,
    ) => hashes.push({ kind, index, sha256: hash(value) });
    const budget = (
      kind: LaunchRecoveryInspection['budgets'][number]['kind'],
      value: unknown,
      units: LaunchRecoveryInspection['budgets'][number]['units'],
      address: string | null = row.payer,
    ) => budgets.push({ kind, address, raw: raw(value), units });
    let packetCount = 1;
    addHash('release', pump ? review.releaseId : terms.releaseId);
    if (pump && kind === 'groups') {
      addHash('context', review.contextSha256);
      addHash('manifest', review.manifestSha256);
      addHash('simulation', review.simulationSha256);
      if (
        !Array.isArray(review.packets) ||
        review.packets.length < 1 ||
        review.packets.length > 5
      )
        return fail();
      packetCount = review.packets.length;
      review.packets.forEach((value, index) => {
        const packet = record(value);
        same(packet.index, index);
        addHash('packet', packet.sha256, index);
      });
    } else {
      addHash('packet', review.sha256);
      if (pump && kind === 'holders') addHash('context', review.contextSha256);
    }
    if (pump && (kind === 'create' || kind === 'developer')) {
      whenBoth(review.feeAndRentLimitRaw, terms.feeAndRentLimitRaw);
      budget('fee-rent-limit', review.feeAndRentLimitRaw, 'lamports');
      if (Object.hasOwn(terms, 'feeAndRentLimitRaw'))
        budget('terms-fee-rent-limit', terms.feeAndRentLimitRaw, 'lamports');
      if (kind === 'developer') {
        whenBoth(input.maximumQuoteCostRaw, terms.maximumQuoteCostRaw);
        if (Object.hasOwn(input, 'maximumQuoteCostRaw'))
          budget(
            'developer-input-max-quote',
            input.maximumQuoteCostRaw,
            'raw-quote',
          );
        budget('developer-token-output', input.tokenAmountRaw, 'raw-token');
      }
    } else if (pump) {
      const allowances = optionalRecord(review.allowances);
      if (
        !developer &&
        ((allowances?.developerMaximumQuoteCostRaw ?? null) !== null ||
          (terms.developerMaximumQuoteCostRaw ?? null) !== null)
      )
        return fail();
      whenBoth(
        allowances?.deployerFeeAndRentLimitRaw,
        terms.feeAndRentLimitRaw,
      );
      whenBoth(
        allowances?.developerMaximumQuoteCostRaw,
        terms.developerMaximumQuoteCostRaw,
      );
      budget(
        'deployer-fee-rent-limit',
        allowances?.deployerFeeAndRentLimitRaw,
        'lamports',
      );
      if (Object.hasOwn(terms, 'feeAndRentLimitRaw'))
        budget('terms-fee-rent-limit', terms.feeAndRentLimitRaw, 'lamports');
      budget(
        'developer-max-quote',
        allowances?.developerMaximumQuoteCostRaw,
        'raw-quote',
      );
      whenBoth(
        allowances?.developerMaximumQuoteCostRaw,
        developer?.maximumQuoteCostRaw,
      );
      if (developer && Object.hasOwn(developer, 'maximumQuoteCostRaw'))
        budget(
          'developer-input-max-quote',
          developer.maximumQuoteCostRaw,
          'raw-quote',
        );
      budget('developer-token-output', developer?.tokenAmountRaw, 'raw-token');
      if (
        !Array.isArray(input.holders) ||
        input.holders.length > LAUNCH_INSPECTION_HOLDER_LIMIT
      )
        return fail();
      const limits = allowances?.holders;
      if (
        limits !== undefined &&
        limits !== null &&
        (!Array.isArray(limits) || limits.length !== input.holders.length)
      )
        return fail();
      if (Object.hasOwn(terms, 'holderLimits')) {
        if (
          !Array.isArray(terms.holderLimits) ||
          !Array.isArray(limits) ||
          terms.holderLimits.length !== limits.length
        )
          return fail();
        terms.holderLimits.forEach((value, index) => {
          const original = record(value),
            allowance = record(limits[index]);
          same(original.address, allowance.address);
          same(original.feeAndRentLimitRaw, allowance.feeAndRentLimitRaw);
          same(
            original.maximumQuoteCostRaw ?? null,
            allowance.maximumQuoteCostRaw ?? null,
          );
          same(
            original.minimumTokenOutputRaw ?? null,
            allowance.minimumTokenOutputRaw ?? null,
          );
        });
      }
      const seen = new Set<string>();
      input.holders.forEach((value, index) => {
        const holder = record(value);
        if (typeof holder.address !== 'string' || seen.has(holder.address))
          return fail();
        seen.add(holder.address);
        const mode =
          holder.kind === undefined
            ? 'unavailable'
            : holder.kind === 'none'
              ? 'not-requested'
              : holder.kind === 'exact-base-output' ||
                  holder.kind === 'exact-quote-input'
                ? holder.kind
                : fail();
        participants.push({ role: 'holder', address: holder.address, mode });
        const limit = Array.isArray(limits) ? record(limits[index]) : null;
        if (limit) same(limit.address, holder.address);
        whenBoth(limit?.maximumQuoteCostRaw, holder.maximumQuoteCostRaw);
        whenBoth(limit?.minimumTokenOutputRaw, holder.minimumTokenOutputRaw);
        budget(
          'holder-fee-rent-limit',
          limit?.feeAndRentLimitRaw,
          'lamports',
          holder.address,
        );
        budget(
          'holder-max-quote',
          limit?.maximumQuoteCostRaw,
          'raw-quote',
          holder.address,
        );
        budget(
          'holder-min-output',
          limit?.minimumTokenOutputRaw,
          'raw-token',
          holder.address,
        );
        if (Object.hasOwn(holder, 'maximumQuoteCostRaw'))
          budget(
            'holder-input-max-quote',
            holder.maximumQuoteCostRaw,
            'raw-quote',
            holder.address,
          );
        if (Object.hasOwn(holder, 'minimumTokenOutputRaw'))
          budget(
            'holder-input-min-output',
            holder.minimumTokenOutputRaw,
            'raw-token',
            holder.address,
          );
        if (Object.hasOwn(holder, 'tokenAmountRaw'))
          budget(
            'holder-token-output',
            holder.tokenAmountRaw,
            'raw-token',
            holder.address,
          );
        if (Object.hasOwn(holder, 'quoteAmountRaw'))
          budget(
            'holder-quote-input',
            holder.quoteAmountRaw,
            'raw-quote',
            holder.address,
          );
      });
    } else {
      const summary = record(review.summary);
      whenBoth(input.devBuyRaw, terms.devBuyRaw);
      whenBoth(summary.devBuyRaw, terms.devBuyRaw);
      whenBoth(summary.solLimitLamports, terms.solLimitLamports);
      budget('developer-buy', terms.devBuyRaw, 'raw-quote');
      budget('minimum-token-output', input.minTokensOutRaw, 'raw-token');
      budget('sol-cost-estimate', summary.solCostLamports, 'lamports');
      budget('sol-spend-limit', terms.solLimitLamports, 'lamports');
      if (reference.source === 'meteora-dbc')
        budget(
          'pool-creation-fee',
          summary.poolCreationFeeLamports,
          'lamports',
        );
    }
    signal.throwIfAborted();
    return validateLaunchRecoveryInspection(
      {
        format: 'launch-recovery-inspection-v1',
        reference,
        inspectedAt: new Date().toISOString(),
        recordedState: row.state,
        name: create.name,
        symbol: create.symbol,
        payer: row.payer,
        payerRevision: terms.payerRevision ?? null,
        projectUpdatedAt: terms.updatedAt ?? null,
        quoteMint: create.quoteMint ?? null,
        hashes,
        budgets,
        participants,
        signature: row.signature,
        signatureScope:
          kind === 'groups' ? 'first-group-packet' : 'single-transaction',
        receiptPresent: row.hasReceipt === 1,
        packetCount,
        signingAllowed: false,
        executionAllowed: false,
        receiptVerified: false,
      },
      reference,
    );
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof LaunchInspectionStoredError) throw error;
    throw new LaunchInspectionStoredError(503);
  }
}
