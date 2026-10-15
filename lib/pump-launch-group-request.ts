import type { PumpGroupCodeConsent } from './pump-group-runtime-authorization';
import { PumpPreflightError } from './owned-pump-preflight';
import { parsePumpHolderRequest } from './pump-holder-request';
import {
  pumpHistoryPageRequest,
  type PumpHistoryPage,
} from './pump-launch-history-page';
import type { preparePumpLaunchGroupReview } from './pump-launch-group-review-service';
import type { PumpLaunchGroupConsent } from './pump-launch-group-review';
import type { PumpGroupObservationPosition } from './pump-launch-group-observation-service';
export type PumpGroupRequest =
  | {
      action: 'prepare';
      terms: Parameters<typeof preparePumpLaunchGroupReview>[2];
    }
  | {
      action: 'authorize-signing';
      id: string;
      previewId: string;
      consent: PumpLaunchGroupConsent;
      codeConsent: PumpGroupCodeConsent;
    }
  | { action: 'approve'; id: string; consent: PumpLaunchGroupConsent }
  | {
      action: 'register';
      id: string;
      consent: PumpLaunchGroupConsent;
      transactions: string[];
    }
  | {
      action:
        | 'revalidate'
        | 'observe'
        | 'recover'
        | 'runtime-preview'
        | 'cancel';
      id: string;
    };
const fail = (): never => {
  throw new PumpPreflightError(
    'Review the exact complete-group action, context, simulation and limits.',
    400,
  );
};
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const keys = (value: Record<string, unknown>, expected: string[]) =>
  Object.keys(value).sort().join(',') === [...expected].sort().join(',');
export const pumpGroupIdValid = (id: unknown): id is string =>
  typeof id === 'string' &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id);
const digest = (v: unknown) =>
  typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
export function parsePumpGroupRequest(
  value: unknown,
  origin: string,
): PumpGroupRequest {
  try {
    if (!record(value)) return fail();
    if (value.action === 'prepare') {
      const parsed = parsePumpHolderRequest(value, origin);
      if (parsed.action !== 'prepare') return fail();
      return parsed;
    }
    if (!pumpGroupIdValid(value.id)) return fail();
    if (
      [
        'revalidate',
        'observe',
        'recover',
        'runtime-preview',
        'cancel',
      ].includes(value.action as string)
    ) {
      if (!keys(value, ['action', 'id'])) return fail();
      return {
        action: value.action as
          | 'revalidate'
          | 'observe'
          | 'recover'
          | 'runtime-preview'
          | 'cancel',
        id: value.id,
      };
    }
    if (value.action === 'authorize-signing') {
      if (
        !keys(value, ['action', 'id', 'previewId', 'consent', 'codeConsent']) ||
        !pumpGroupIdValid(value.previewId) ||
        !record(value.codeConsent)
      )
        return fail();
      const c = value.codeConsent;
      if (
        !keys(c, [
          'approved',
          'previewId',
          'identitySha256',
          'acknowledgeUpgradeableCode',
          'acknowledgeNoSemanticAudit',
        ]) ||
        c.approved !== true ||
        c.previewId !== value.previewId ||
        !digest(c.identitySha256) ||
        c.acknowledgeUpgradeableCode !== true ||
        c.acknowledgeNoSemanticAudit !== true
      )
        return fail();
      const approved = parsePumpGroupRequest(
        { action: 'approve', id: value.id, consent: value.consent },
        origin,
      );
      if (approved.action !== 'approve') return fail();
      return {
        action: 'authorize-signing',
        id: value.id,
        previewId: value.previewId,
        consent: approved.consent,
        codeConsent: c as PumpGroupCodeConsent,
      };
    }
    if (value.action !== 'approve' && value.action !== 'register')
      return fail();
    if (
      !keys(value, [
        'action',
        'id',
        'consent',
        ...(value.action === 'register' ? ['transactions'] : []),
      ]) ||
      !record(value.consent)
    )
      return fail();
    const c = value.consent;
    if (
      !keys(c, [
        'approved',
        'reviewId',
        'manifestSha256',
        'contextSha256',
        'simulationSha256',
        'approvedScope',
        'acknowledgeSimulationLimits',
      ]) ||
      c.approved !== true ||
      c.reviewId !== value.id ||
      !digest(c.manifestSha256) ||
      !digest(c.contextSha256) ||
      !digest(c.simulationSha256) ||
      c.approvedScope !== 'complete-create-developer-holder-packet-group' ||
      c.acknowledgeSimulationLimits !== true
    )
      return fail();
    const consent = c as PumpLaunchGroupConsent;
    if (value.action === 'approve')
      return { action: 'approve', id: value.id, consent };
    const transactions = value.transactions;
    if (
      !Array.isArray(transactions) ||
      transactions.length < 1 ||
      transactions.length > 5 ||
      new Set(transactions).size !== transactions.length ||
      transactions.some(
        (t) =>
          typeof t !== 'string' ||
          !t ||
          t.length > 5464 ||
          btoa(atob(t)) !== t ||
          atob(t).length > 4096,
      )
    )
      return fail();
    return { action: 'register', id: value.id, consent, transactions };
  } catch {
    return fail();
  }
}
const dateValid = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;
export function encodePumpGroupObservationCursor(
  position: PumpGroupObservationPosition,
) {
  if (
    !pumpGroupIdValid(position.reviewId) ||
    !pumpGroupIdValid(position.id) ||
    !dateValid(position.createdAt)
  )
    return fail();
  return Buffer.from(
    JSON.stringify({
      v: 1,
      kind: 'pump-group-observations',
      reviewId: position.reviewId,
      createdAt: position.createdAt,
      id: position.id,
    }),
    'utf8',
  ).toString('base64url');
}
export function parsePumpGroupReadRequest(params: URLSearchParams):
  | { kind: 'projects'; projectId: string; page: PumpHistoryPage }
  | { kind: 'review'; id: string }
  | {
      kind: 'observations';
      id: string;
      position: PumpGroupObservationPosition | null;
    } {
  try {
    if ([...params.keys()].some((key) => params.getAll(key).length !== 1))
      return fail();
    if (params.has('projectId')) {
      if (
        [...params.keys()].some(
          (k) => !['projectId', 'page', 'cursor'].includes(k),
        )
      )
        return fail();
      const projectId = params.get('projectId')!;
      if (!projectId || projectId.length > 128) return fail();
      return {
        kind: 'projects',
        projectId,
        page: pumpHistoryPageRequest(params, projectId, 'groups') ?? {
          before: null,
        },
      };
    }
    const id = params.get('id');
    if (!pumpGroupIdValid(id)) return fail();
    if (!params.has('observations')) {
      if ([...params.keys()].some((k) => k !== 'id')) return fail();
      return { kind: 'review', id };
    }
    if (
      params.get('observations') !== '1' ||
      [...params.keys()].some(
        (k) => !['id', 'observations', 'cursor'].includes(k),
      )
    )
      return fail();
    const cursor = params.get('cursor');
    if (cursor === null) return { kind: 'observations', id, position: null };
    if (!/^[A-Za-z0-9_-]{1,1024}$/.test(cursor)) return fail();
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (
      !record(value) ||
      !keys(value, ['v', 'kind', 'reviewId', 'createdAt', 'id']) ||
      value.v !== 1 ||
      value.kind !== 'pump-group-observations' ||
      value.reviewId !== id ||
      !pumpGroupIdValid(value.id) ||
      !dateValid(value.createdAt)
    )
      return fail();
    const position = { reviewId: id, createdAt: value.createdAt, id: value.id };
    if (encodePumpGroupObservationCursor(position) !== cursor) return fail();
    return { kind: 'observations', id, position };
  } catch {
    return fail();
  }
}
