import { volumeTerms, type VolumeTerms } from './volume-bot-plan';
import type { VolumeBatchConsent } from './volume-bot-batch';

export type VolumeBotAction =
  | {
      action: 'estimate' | 'create';
      projectId: string;
      projectRevision: number;
      terms: VolumeTerms;
      seed: string;
      usdQuoteId?: string;
    }
  | {
      action: 'quote-usd-target';
      projectId: string;
      projectRevision: number;
      targetUsd: string;
    }
  | { action: 'prepare-batch' | 'cancel'; sessionId: string }
  | {
      action: 'register';
      batchId: string;
      consent: VolumeBatchConsent;
      transactions: string[];
    }
  | { action: 'send'; batchId: string; index: number }
  | { action: 'observe'; batchId: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const bad = (): never => {
  throw new Error('Invalid Volume Bot request.');
};
const keys = (value: object, expected: string) =>
  Object.keys(value).sort().join(',') === expected || bad();
const uuid = (value: unknown) =>
  typeof value === 'string' && UUID.test(value) ? value : bad();

/** Strict parser: exact keys per action, no unknown fields. */
export function parseVolumeBotRequest(body: unknown): VolumeBotAction {
  const input = body as Record<string, unknown> | null;
  if (!input || typeof input !== 'object' || Array.isArray(input)) bad();
  switch (input!.action) {
    case 'quote-usd-target': {
      keys(input!, 'action,projectId,projectRevision,targetUsd');
      if (
        !Number.isSafeInteger(input!.projectRevision) ||
        Number(input!.projectRevision) < 1 ||
        typeof input!.targetUsd !== 'string' ||
        !/^(0|[1-9]\d{0,11})(?:\.\d{1,2})?$/.test(input!.targetUsd) ||
        BigInt(input!.targetUsd.replace('.', '')) === 0n
      )
        bad();
      return {
        action: 'quote-usd-target',
        projectId: uuid(input!.projectId),
        projectRevision: Number(input!.projectRevision),
        targetUsd: input!.targetUsd as string,
      };
    }
    case 'estimate':
    case 'create': {
      keys(
        input!,
        Object.hasOwn(input!, 'usdQuoteId')
          ? 'action,projectId,projectRevision,seed,terms,usdQuoteId'
          : 'action,projectId,projectRevision,seed,terms',
      );
      if (
        !Number.isSafeInteger(input!.projectRevision) ||
        Number(input!.projectRevision) < 1 ||
        typeof input!.seed !== 'string' ||
        !/^[0-9a-f]{32}$/.test(input!.seed)
      )
        bad();
      return {
        action: input!.action,
        projectId: uuid(input!.projectId),
        projectRevision: Number(input!.projectRevision),
        terms: volumeTerms(input!.terms),
        seed: input!.seed as string,
        ...(Object.hasOwn(input!, 'usdQuoteId')
          ? { usdQuoteId: uuid(input!.usdQuoteId) }
          : {}),
      };
    }
    case 'prepare-batch':
    case 'cancel':
      keys(input!, 'action,sessionId');
      return { action: input!.action, sessionId: uuid(input!.sessionId) };
    case 'register': {
      keys(input!, 'action,batchId,consent,transactions');
      const transactions = input!.transactions;
      if (
        !Array.isArray(transactions) ||
        !transactions.length ||
        transactions.length > 25 ||
        transactions.some((t) => typeof t !== 'string' || t.length > 5464)
      )
        bad();
      return {
        action: 'register',
        batchId: uuid(input!.batchId),
        consent: input!.consent as VolumeBatchConsent,
        transactions: transactions as string[],
      };
    }
    case 'send':
      keys(input!, 'action,batchId,index');
      if (!Number.isSafeInteger(input!.index) || Number(input!.index) < 0)
        bad();
      return {
        action: 'send',
        batchId: uuid(input!.batchId),
        index: Number(input!.index),
      };
    case 'observe':
      keys(input!, 'action,batchId');
      return { action: 'observe', batchId: uuid(input!.batchId) };
  }
  return bad();
}
