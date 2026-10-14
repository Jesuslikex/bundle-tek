import bs58 from 'bs58';
import { validSolanaSigningKey } from './solana-signature';
import { PumpPreflightError } from './owned-pump-preflight';
import type { preparePumpHolderReview } from './pump-holder-review-service';
import type { PumpHolderConsent } from './pump-holder-signing';
type Terms = Parameters<typeof preparePumpHolderReview>[2];
export type PumpHolderRequest =
  | { action: 'prepare'; terms: Terms }
  | { action: 'approve'; id: string; consent: PumpHolderConsent }
  | {
      action: 'register';
      id: string;
      consent: PumpHolderConsent;
      transaction: string;
    }
  | {
      action: 'submit';
      id: string;
      consent: PumpHolderConsent;
      submitApproved: true;
    }
  | { action: 'recover' | 'cancel'; id: string };
const fail = (): never => {
  throw new PumpPreflightError(
    'Review the exact holder launch action, saved selection and raw spending limits.',
    400,
  );
};
const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const keys = (v: Record<string, unknown>, allowed: string[]) =>
  Object.keys(v).sort().join(',') === [...allowed].sort().join(',');
const uint = (v: unknown, zero = false, max = (1n << 64n) - 1n) =>
  typeof v === 'string' &&
  /^(0|[1-9]\d{0,19})$/.test(v) &&
  BigInt(v) <= max &&
  (zero || BigInt(v) > 0n);
const pubkey = (v: unknown) =>
  typeof v === 'string' &&
  v.length <= 44 &&
  validSolanaSigningKey(bs58.decode(v));
const id = (v: unknown) =>
  typeof v === 'string' &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v);

/** Strict HTTP DTO parsing. Identity and origin come from the server; raw observations/reviews cannot be posted. */
export function parsePumpHolderRequest(
  value: unknown,
  origin: string,
): PumpHolderRequest {
  try {
    if (!record(value)) return fail();
    const b = value;
    if (b.action === 'prepare') {
      if (
        !keys(b, [
          'action',
          'projectId',
          'updatedAt',
          'releaseId',
          'payer',
          'payerRevision',
          'mint',
          'feeAndRentLimitRaw',
          'holderLimits',
          ...(b.developerMaximumQuoteCostRaw === undefined
            ? []
            : ['developerMaximumQuoteCostRaw']),
        ]) ||
        typeof b.projectId !== 'string' ||
        !b.projectId ||
        b.projectId.length > 128 ||
        typeof b.updatedAt !== 'string' ||
        b.updatedAt.length > 128 ||
        !Number.isFinite(Date.parse(b.updatedAt)) ||
        typeof b.releaseId !== 'string' ||
        !/^[a-f0-9]{64}$/.test(b.releaseId) ||
        !pubkey(b.payer) ||
        !pubkey(b.mint) ||
        b.payer === b.mint ||
        !Number.isSafeInteger(b.payerRevision) ||
        Number(b.payerRevision) < 1 ||
        !uint(b.feeAndRentLimitRaw, false, 1000000000n) ||
        (b.developerMaximumQuoteCostRaw !== undefined &&
          !uint(b.developerMaximumQuoteCostRaw)) ||
        !Array.isArray(b.holderLimits) ||
        !b.holderLimits.length ||
        b.holderLimits.length > 200
      )
        return fail();
      for (const limit of b.holderLimits) {
        if (
          !record(limit) ||
          !pubkey(limit.address) ||
          !uint(limit.feeAndRentLimitRaw, true, 1000000000n) ||
          !keys(limit, [
            'address',
            'feeAndRentLimitRaw',
            ...(limit.maximumQuoteCostRaw === undefined
              ? []
              : ['maximumQuoteCostRaw']),
            ...(limit.minimumTokenOutputRaw === undefined
              ? []
              : ['minimumTokenOutputRaw']),
          ]) ||
          (limit.feeAndRentLimitRaw === '0' &&
            (limit.maximumQuoteCostRaw !== undefined ||
              limit.minimumTokenOutputRaw !== undefined)) ||
          (limit.feeAndRentLimitRaw !== '0' &&
            Number(limit.maximumQuoteCostRaw !== undefined) +
              Number(limit.minimumTokenOutputRaw !== undefined) !==
              1) ||
          (limit.maximumQuoteCostRaw !== undefined &&
            !uint(limit.maximumQuoteCostRaw)) ||
          (limit.minimumTokenOutputRaw !== undefined &&
            !uint(limit.minimumTokenOutputRaw))
        )
          return fail();
      }
      const identities = [
        b.payer,
        b.mint,
        ...b.holderLimits.map((l) => l.address),
      ];
      if (new Set(identities).size !== identities.length) return fail();
      const { action: _action, ...terms } = b;
      return { action: 'prepare', terms: { ...terms, origin } as Terms };
    }
    if (
      !id(b.id) ||
      typeof b.action !== 'string' ||
      !['approve', 'register', 'submit', 'recover', 'cancel'].includes(b.action)
    )
      return fail();
    if (b.action === 'recover' || b.action === 'cancel') {
      if (!keys(b, ['action', 'id'])) return fail();
      return { action: b.action, id: b.id as string };
    }
    if (
      !keys(b, [
        'action',
        'id',
        'consent',
        ...(b.action === 'register' ? ['transaction'] : []),
        ...(b.action === 'submit' ? ['submitApproved'] : []),
      ]) ||
      !record(b.consent) ||
      !keys(b.consent, [
        'approved',
        'reviewId',
        'sha256',
        'contextSha256',
        'approvedScope',
        'acknowledgeSimulationLimits',
      ]) ||
      b.consent.approved !== true ||
      b.consent.reviewId !== b.id ||
      b.consent.approvedScope !== 'create-developer-and-holder-buys' ||
      b.consent.acknowledgeSimulationLimits !== true ||
      typeof b.consent.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(b.consent.sha256) ||
      typeof b.consent.contextSha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(b.consent.contextSha256)
    )
      return fail();
    const consent = b.consent as PumpHolderConsent;
    if (b.action === 'submit') {
      if (b.submitApproved !== true) return fail();
      return {
        action: 'submit',
        id: b.id as string,
        consent,
        submitApproved: true,
      };
    }
    if (b.action === 'register') {
      if (
        typeof b.transaction !== 'string' ||
        !b.transaction ||
        b.transaction.length > 5464 ||
        btoa(atob(b.transaction)) !== b.transaction ||
        atob(b.transaction).length > 4096
      )
        return fail();
      return {
        action: 'register',
        id: b.id as string,
        consent,
        transaction: b.transaction,
      };
    }
    return { action: 'approve', id: b.id as string, consent };
  } catch {
    return fail();
  }
}
