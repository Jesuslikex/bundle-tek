import bs58 from 'bs58';
import { validSolanaSigningKey } from './solana-signature';
import { PumpPreflightError } from './owned-pump-preflight';
import type { PumpOrganicPlanTerms } from './pump-organic-preparation';
import type { PumpOrganicBatchConsent } from './pump-organic-batch';

export type PumpOrganicRequest =
  | { action: 'plan'; terms: PumpOrganicPlanTerms }
  | { action: 'prepare-batch'; sequenceId: string; batch: number }
  | {
      action: 'register';
      batchId: string;
      consent: PumpOrganicBatchConsent;
      transactions: string[];
    }
  | { action: 'send'; batchId: string; index: number; sendApproved: true }
  | { action: 'observe'; batchId: string }
  | { action: 'stop'; sequenceId: string };
const fail = (): never => {
  throw new PumpPreflightError(
    'Review the exact organic holder-buy action and its limits.',
    400,
  );
};
const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const keys = (v: Record<string, unknown>, allowed: string[]) =>
  Object.keys(v).sort().join(',') === [...allowed].sort().join(',');
const uuid = (v: unknown): v is string =>
  typeof v === 'string' &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v);
const index = (v: unknown, max: number): v is number =>
  Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= max;
const pubkey = (v: unknown): v is string =>
  typeof v === 'string' &&
  v.length <= 44 &&
  validSolanaSigningKey(bs58.decode(v));

/** Strict DTO parsing. Owner comes from the session; packets, plans and reviews are built server-side. */
export function parsePumpOrganicRequest(value: unknown): PumpOrganicRequest {
  if (!record(value) || typeof value.action !== 'string') return fail();
  const v = value;
  switch (v.action) {
    case 'plan': {
      const t = v.terms;
      if (
        !keys(v, ['action', 'terms']) ||
        !record(t) ||
        !keys(t, [
          'launchReviewId',
          'mode',
          'buys',
          'delayMinMs',
          'delayMaxMs',
          'slippageBps',
          'rentAllowanceRaw',
        ]) ||
        !uuid(t.launchReviewId) ||
        (t.mode !== 'Organic' && t.mode !== 'Stagger') ||
        !Array.isArray(t.buys) ||
        !t.buys.length ||
        t.buys.length > 200 ||
        !t.buys.every(
          (b) =>
            record(b) &&
            keys(b, ['address', 'tokenAmountRaw']) &&
            pubkey(b.address) &&
            typeof b.tokenAmountRaw === 'string' &&
            /^[1-9]\d{0,19}$/.test(b.tokenAmountRaw),
        ) ||
        !Number.isSafeInteger(t.delayMinMs) ||
        !Number.isSafeInteger(t.delayMaxMs) ||
        !Number.isSafeInteger(t.slippageBps) ||
        typeof t.rentAllowanceRaw !== 'string' ||
        !/^(0|[1-9]\d{0,9})$/.test(t.rentAllowanceRaw)
      )
        return fail();
      return { action: 'plan', terms: t as PumpOrganicPlanTerms };
    }
    case 'prepare-batch':
      if (
        !keys(v, ['action', 'sequenceId', 'batch']) ||
        !uuid(v.sequenceId) ||
        !index(v.batch, 199)
      )
        return fail();
      return {
        action: 'prepare-batch',
        sequenceId: v.sequenceId,
        batch: v.batch,
      };
    case 'register': {
      const c = v.consent;
      if (
        !keys(v, ['action', 'batchId', 'consent', 'transactions']) ||
        !uuid(v.batchId) ||
        !record(c) ||
        !keys(c, [
          'approved',
          'reviewId',
          'sha256',
          'scope',
          'acknowledgePriceMovesBetweenBuys',
        ]) ||
        !Array.isArray(v.transactions) ||
        !v.transactions.length ||
        v.transactions.length > 200 ||
        !v.transactions.every((t) => typeof t === 'string' && t.length <= 5464)
      )
        return fail();
      return {
        action: 'register',
        batchId: v.batchId,
        consent: c as PumpOrganicBatchConsent,
        transactions: v.transactions as string[],
      };
    }
    case 'send':
      if (
        !keys(v, ['action', 'batchId', 'index', 'sendApproved']) ||
        !uuid(v.batchId) ||
        !index(v.index, 199) ||
        v.sendApproved !== true
      )
        return fail();
      return {
        action: 'send',
        batchId: v.batchId,
        index: v.index,
        sendApproved: true,
      };
    case 'observe':
      if (!keys(v, ['action', 'batchId']) || !uuid(v.batchId)) return fail();
      return { action: 'observe', batchId: v.batchId };
    case 'stop':
      if (!keys(v, ['action', 'sequenceId']) || !uuid(v.sequenceId))
        return fail();
      return { action: 'stop', sequenceId: v.sequenceId };
  }
  return fail();
}
