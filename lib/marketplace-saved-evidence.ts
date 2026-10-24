import { z } from 'zod';
import bs58 from 'bs58';
import { marketplaceOwnedInventoryResult } from './marketplace-owned-inventory';
import { readBoundedPanelJson } from './read-bounded-panel-json';
export const SAVED_EVIDENCE_PAGE_LIMIT = 20;
export const SAVED_EVIDENCE_HISTORY_BYTES = 4194304;
export const SAVED_EVIDENCE_DOCUMENT_CHARS = 131072;
export const SAVED_EVIDENCE_DOCUMENT_BYTES = 524288;
const iso = z
  .string()
  .length(24)
  .refine(
    (v) => Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v,
  );
const key = z
  .string()
  .min(32)
  .max(44)
  .refine((v) => {
    try {
      const bytes = bs58.decode(v);
      return bytes.length === 32 && bs58.encode(bytes) === v;
    } catch {
      return false;
    }
  });
const revision = z.number().int().min(1).max(1e9);
const runId = z.string().regex(/^[\u0020-\u007e]{1,64}$/);
const wallet = marketplaceOwnedInventoryResult.shape.wallets.element
  .pick({ address: true, label: true, revision: true, updatedAt: true })
  .extend({ address: key, updatedAt: iso })
  .strict();
const observation =
  marketplaceOwnedInventoryResult.shape.wallets.element.shape.latestHistory;
const historyRecord = z
  .object({
    id: runId,
    revision,
    createdAt: iso,
    updatedAt: iso,
    capturedWalletRevision: revision,
    outcome: z.enum(['observation', 'read-failed', 'not-recorded']),
    observation,
  })
  .strict();
export type SavedEvidenceWallet = z.infer<typeof wallet>;
export type SavedEvidenceRecord = z.infer<typeof historyRecord>;
export type SavedEvidenceRequest =
  | { view: 'wallets'; cursor: string | null }
  | {
      view: 'history';
      address: string;
      revision: number;
      cursor: string | null;
    };
export const savedEvidenceAuthority = {
  controlProven: false as const,
  lifecycleVerified: false as const,
  completeInventory: false as const,
  completeHistory: false as const,
  listingAllowed: false as const,
  paymentAllowed: false as const,
  deliveryAllowed: false as const,
  signingAllowed: false as const,
  executionAllowed: false as const,
};
const flags = {
  controlProven: z.literal(false),
  lifecycleVerified: z.literal(false),
  completeInventory: z.literal(false),
  completeHistory: z.literal(false),
  listingAllowed: z.literal(false),
  paymentAllowed: z.literal(false),
  deliveryAllowed: z.literal(false),
  signingAllowed: z.literal(false),
  executionAllowed: z.literal(false),
};
const walletRequest = z
  .object({
    view: z.literal('wallets'),
    cursor: z.string().max(300).nullable(),
  })
  .strict();
const historyRequest = z
  .object({
    view: z.literal('history'),
    address: key,
    revision,
    cursor: z.string().max(300).nullable(),
  })
  .strict();
const base = {
  format: z.literal('marketplace-saved-evidence-page-v1'),
  chain: z.literal('Solana'),
  observedAt: iso,
  nextCursor: z.string().max(300).nullable(),
  ...flags,
};
const pageSchema = z.discriminatedUnion('view', [
  z
    .object({
      ...base,
      view: z.literal('wallets'),
      request: walletRequest,
      wallets: z.array(wallet).max(SAVED_EVIDENCE_PAGE_LIMIT),
    })
    .strict(),
  z
    .object({
      ...base,
      view: z.literal('history'),
      request: historyRequest,
      wallet,
      records: z.array(historyRecord).max(SAVED_EVIDENCE_PAGE_LIMIT),
    })
    .strict(),
]);
export type SavedEvidencePage = z.infer<typeof pageSchema>;
export type SavedWalletPage = Extract<SavedEvidencePage, { view: 'wallets' }>;
export type SavedHistoryPage = Extract<SavedEvidencePage, { view: 'history' }>;
export class SavedEvidenceReadError extends Error {
  constructor(readonly status: number) {
    super(
      status === 401
        ? 'Sign in to inspect your saved wallet evidence.'
        : status === 404
          ? 'The selected saved wallet is unavailable for this account.'
          : status === 409
            ? 'The saved wallet changed. Reload saved wallets and select it again.'
            : status === 400
              ? 'The saved evidence page reference is invalid.'
              : 'Saved wallet evidence is unavailable. No partial page is shown.',
    );
  }
}
export const SAVED_EVIDENCE_CLOCK_MESSAGE =
  'The saved page time differs from this device clock or is too old. Check automatic date and time, then reload saved wallets.';
export class SavedEvidenceClockError extends SavedEvidenceReadError {
  constructor() {
    super(502);
    this.name = 'SavedEvidenceClockError';
    this.message = SAVED_EVIDENCE_CLOCK_MESSAGE;
  }
}
export class SavedEvidenceRequestError extends Error {}
const fail = (): never => {
  throw new SavedEvidenceReadError(502);
};
export function savedWalletCursor(address: string) {
  key.parse(address);
  return JSON.stringify([1, 'wallets', address]);
}
export function savedHistoryCursor(
  selection: { address: string; revision: number },
  createdAt: string,
  id: string,
) {
  key.parse(selection.address);
  revision.parse(selection.revision);
  iso.parse(createdAt);
  runId.parse(id);
  return JSON.stringify([
    1,
    'history',
    selection.address,
    selection.revision,
    createdAt,
    id,
  ]);
}
export function savedEvidenceCursor(
  request: SavedEvidenceRequest,
): { address: string } | { createdAt: string; id: string } | null {
  if (request.cursor === null) return null;
  const raw: unknown = JSON.parse(request.cursor);
  if (request.view === 'wallets') {
    const v = z.tuple([z.literal(1), z.literal('wallets'), key]).parse(raw);
    if (savedWalletCursor(v[2]) !== request.cursor) return fail();
    return { address: v[2] };
  }
  const v = z
    .tuple([z.literal(1), z.literal('history'), key, revision, iso, runId])
    .parse(raw);
  if (
    v[2] !== request.address ||
    v[3] !== request.revision ||
    savedHistoryCursor(request, v[4], v[5]) !== request.cursor
  )
    return fail();
  return { createdAt: v[4], id: v[5] };
}
export function savedEvidenceRequest(
  params: URLSearchParams,
): SavedEvidenceRequest {
  try {
    if (params.toString().length > 2048) throw Error();
    const view = params.get('view');
    const required =
      view === 'wallets'
        ? ['view']
        : view === 'history'
          ? ['view', 'address', 'revision']
          : [];
    if (
      !required.length ||
      required.some((k) => params.getAll(k).length !== 1) ||
      [...params.keys()].some((k) => ![...required, 'cursor'].includes(k)) ||
      params.getAll('cursor').length > 1
    )
      throw Error();
    const cursor = params.get('cursor');
    if (cursor !== null && (cursor.length === 0 || cursor.length > 300))
      throw Error();
    let request: SavedEvidenceRequest;
    if (view === 'wallets') request = { view, cursor };
    else {
      const r = params.get('revision')!;
      if (!/^[1-9]\d{0,9}$/.test(r)) throw Error();
      request = {
        view: 'history',
        address: key.parse(params.get('address')),
        revision: revision.parse(Number(r)),
        cursor,
      };
    }
    savedEvidenceCursor(request);
    return request;
  } catch {
    throw new SavedEvidenceRequestError(
      'Choose a valid saved wallet evidence page.',
    );
  }
}
export function savedEvidenceUrl(request: SavedEvidenceRequest) {
  request =
    request.view === 'wallets'
      ? walletRequest.parse(request)
      : historyRequest.parse(request);
  const params = new URLSearchParams({
    view: request.view,
    ...(request.view === 'history'
      ? { address: request.address, revision: String(request.revision) }
      : {}),
  });
  if (request.cursor !== null) params.set('cursor', request.cursor);
  const verified = savedEvidenceRequest(params);
  if (JSON.stringify(verified) !== JSON.stringify(request)) return fail();
  return '/api/marketplace/saved-evidence?' + params.toString();
}
export function admitSavedEvidencePage(
  value: unknown,
  expected: SavedEvidenceRequest,
  now = Date.now(),
): SavedEvidencePage {
  try {
    // The transport accepts bounded parsed JSON only; this is a display contract,
    // never a complete-inventory or listing-review admission.
    const result = pageSchema.parse(value);
    if (
      !Number.isSafeInteger(now) ||
      Date.parse(result.observedAt) > now + 5000 ||
      now - Date.parse(result.observedAt) > 300000
    )
      throw new SavedEvidenceClockError();
    const expectedRequest = savedEvidenceRequest(
      new URL(savedEvidenceUrl(expected), 'https://bundle.invalid')
        .searchParams,
    );
    if (
      JSON.stringify(result.request) !== JSON.stringify(expectedRequest) ||
      result.view !== expected.view
    )
      return fail();
    const before = savedEvidenceCursor(expected);
    if (result.view === 'wallets') {
      let last = before && 'address' in before ? before.address : null;
      for (const w of result.wallets) {
        if (
          Date.parse(w.updatedAt) > Date.parse(result.observedAt) ||
          (last !== null && w.address <= last)
        )
          return fail();
        last = w.address;
      }
      if (
        result.nextCursor !== null &&
        (!result.wallets.length ||
          result.nextCursor !==
            savedWalletCursor(result.wallets.at(-1)!.address))
      )
        return fail();
    } else {
      if (
        result.wallet.address !== result.request.address ||
        result.wallet.revision !== result.request.revision ||
        Date.parse(result.wallet.updatedAt) > Date.parse(result.observedAt)
      )
        return fail();
      let last = before && 'createdAt' in before ? before : null;
      for (const record of result.records) {
        if (
          Date.parse(record.createdAt) > Date.parse(record.updatedAt) ||
          Date.parse(record.updatedAt) > Date.parse(result.observedAt) ||
          record.capturedWalletRevision > result.request.revision ||
          (last &&
            (record.createdAt > last.createdAt ||
              (record.createdAt === last.createdAt && record.id >= last.id)))
        )
          return fail();
        last = { createdAt: record.createdAt, id: record.id };
        const h = record.observation;
        if ((record.outcome === 'observation') !== (h !== null)) return fail();
        if (h) {
          if (
            h.runId !== record.id ||
            h.walletRevision !== record.capturedWalletRevision ||
            Date.parse(h.observedAt) < Date.parse(record.createdAt) ||
            Date.parse(h.observedAt) > Date.parse(record.updatedAt) ||
            h.successfulSampleCount > h.sampleCount ||
            (h.oldestSampledActivityAt === null) !==
              (h.latestSampledActivityAt === null) ||
            (h.sampleCount === 0 &&
              (h.successfulSampleCount !== 0 ||
                h.oldestSampledActivityAt !== null))
          )
            return fail();
          if (h.oldestSampledActivityAt !== null) {
            if (
              !iso.safeParse(h.oldestSampledActivityAt).success ||
              !iso.safeParse(h.latestSampledActivityAt).success ||
              Date.parse(h.oldestSampledActivityAt) >
                Date.parse(h.latestSampledActivityAt!) ||
              Date.parse(h.latestSampledActivityAt!) > Date.parse(h.observedAt)
            )
              return fail();
          }
          if (!iso.safeParse(h.observedAt).success) return fail();
        }
      }
      if (
        result.nextCursor !== null &&
        (!result.records.length ||
          result.nextCursor !==
            savedHistoryCursor(
              result.request,
              result.records.at(-1)!.createdAt,
              result.records.at(-1)!.id,
            ))
      )
        return fail();
    }
    return result;
  } catch (error) {
    if (error instanceof SavedEvidenceReadError) throw error;
    return fail();
  }
}
export async function readSavedEvidencePage(
  response: Response,
  request: SavedEvidenceRequest,
  signal: AbortSignal,
) {
  if (signal.aborted) {
    void response.body?.cancel().catch(() => {});
    signal.throwIfAborted();
  }
  if (!response.ok) {
    void response.body?.cancel().catch(() => {});
    throw new SavedEvidenceReadError(response.status);
  }
  try {
    const value = await readBoundedPanelJson(response, signal);
    signal.throwIfAborted();
    return admitSavedEvidencePage(value, request);
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof SavedEvidenceReadError) throw error;
    return fail();
  }
}
