import { validateFunding, type SavedFunding } from './funding-plan';

export type FundingMutation = {
  action: 'save' | 'archive' | 'restore';
  id: string;
  expectedRevision: number;
  document: SavedFunding['document'];
};

const unavailable = 'Saved funding plans are unavailable. Reload to try again.';
export class FundingMutationRejected extends Error {
  constructor(public readonly status: number) {
    super(
      status === 401
        ? 'Sign in again before saving this funding draft.'
        : status === 409
          ? 'The funding draft changed. Reload saved plans and review your edits.'
          : 'The funding draft was not accepted. Review its fields before saving again.',
    );
  }
}

/** Only these structured route responses are emitted before a successful mutation. */
export async function fundingWriteResponse(response: Response) {
  if (
    [400, 401, 403, 409, 413, 415].includes(response.status) &&
    response.headers.get('content-type')?.includes('application/json')
  ) {
    const body: unknown = await response.json().catch(() => null);
    if (
      body &&
      typeof body === 'object' &&
      !Array.isArray(body) &&
      typeof (body as Record<string, unknown>).error === 'string'
    )
      throw new FundingMutationRejected(response.status);
    throw new Error(
      'The save rejection was unreadable. Check the original save before continuing.',
    );
  }
  return fundingResponse(response);
}
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(unavailable);
  return value as Record<string, unknown>;
};

/** Decode retained data before it can select a revision for financial review. */
export function decodeSavedFunding(value: unknown): SavedFunding {
  try {
    const row = object(value),
      supplied = object(row.document);
    const document = validateFunding(supplied);
    if (
      typeof row.id !== 'string' ||
      !/^[a-zA-Z0-9-]{1,64}$/.test(row.id) ||
      !Number.isSafeInteger(row.revision) ||
      Number(row.revision) < 1 ||
      Number(row.revision) > 1_000_000_001 ||
      typeof row.archived !== 'boolean' ||
      typeof row.updatedAt !== 'string' ||
      !Number.isFinite(Date.parse(row.updatedAt)) ||
      new Date(row.updatedAt).toISOString() !== row.updatedAt ||
      supplied.total !== document.total ||
      !Array.isArray(supplied.items) ||
      supplied.items.length !== document.items.length
    )
      throw new Error(unavailable);
    for (let i = 0; i < document.items.length; i++) {
      const item = object(supplied.items[i]),
        expected = document.items[i];
      if (
        item.address !== expected.address ||
        item.amount !== expected.amount ||
        item.scheduledAt !== expected.scheduledAt ||
        JSON.stringify(item.proxies) !== JSON.stringify(expected.proxies)
      )
        throw new Error(unavailable);
    }
    return {
      id: row.id,
      revision: Number(row.revision),
      archived: row.archived,
      updatedAt: row.updatedAt,
      document,
    };
  } catch {
    throw new Error(unavailable);
  }
}

export function decodeFundingList(value: unknown): SavedFunding[] {
  const body = object(value);
  if (!Array.isArray(body.plans) || body.plans.length > 100)
    throw new Error(unavailable);
  const rows = body.plans.map(decodeSavedFunding);
  if (new Set(rows.map((row) => row.id)).size !== rows.length)
    throw new Error(unavailable);
  return rows;
}

export function fundingMutationOutcome(
  attempt: FundingMutation,
  row: SavedFunding,
) {
  if (row.id !== attempt.id) throw new Error(unavailable);
  if (row.revision <= attempt.expectedRevision) return 'unknown' as const;
  if (
    row.revision === attempt.expectedRevision + 1 &&
    row.archived === (attempt.action === 'archive') &&
    JSON.stringify(row.document) === JSON.stringify(attempt.document)
  )
    return 'confirmed' as const;
  // A later/different winning revision fences the original expected revision.
  return 'conflict' as const;
}

export async function fundingResponse(
  response: Response,
): Promise<Record<string, unknown>> {
  if (!response.ok)
    throw new Error(
      response.status === 401
        ? 'Sign in again to open or recover funding drafts.'
        : response.status === 409
          ? 'The funding draft changed. Check the saved result before continuing.'
          : 'Funding storage is unavailable. Your editable draft is preserved.',
    );
  try {
    return object(await response.json());
  } catch {
    throw new Error(
      'Funding storage returned an unreadable response. Your editable draft is preserved.',
    );
  }
}
