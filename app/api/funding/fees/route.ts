import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getD1 } from '@/db';
import { reviewFundingFees } from '@/lib/funding-fees';
import { prepareSolanaFunding, SolanaFundingError } from '@/lib/solana-funding';
import { prepareSolanaTokenFunding } from '@/lib/solana-token-funding';
import { validateFunding } from '@/lib/funding-plan';
import {
  prepareUnsignedFunding,
  FundingPreparationError,
} from '@/lib/funding-transactions';
export const dynamic = 'force-dynamic';
const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return json({ error: 'Sign in to review funding fees.' }, 401);
  if (
    request.headers.get('origin') &&
    request.headers.get('origin') !== new URL(request.url).origin
  )
    return json({ error: 'Cross-origin request rejected.' }, 403);
  if (
    !request.headers
      .get('content-type')
      ?.toLowerCase()
      .startsWith('application/json')
  )
    return json({ error: 'JSON required.' }, 415);
  let id: string, revision: number;
  let mode: 'review' | 'prepare' | 'prepare-solana' = 'review';
  try {
    const text = await request.text();
    if (text.length > 1000) return json({ error: 'Request too large.' }, 413);
    const body = JSON.parse(text);
    if (
      body.action !== undefined &&
      !['review', 'prepare', 'prepare-solana'].includes(body.action)
    )
      throw new Error();
    mode = body.action ?? 'review';
    if (
      typeof body.id !== 'string' ||
      !/^[a-zA-Z0-9-]{1,64}$/.test(body.id) ||
      !Number.isSafeInteger(body.revision) ||
      body.revision < 1
    )
      throw new Error();
    id = body.id;
    revision = body.revision;
  } catch {
    return json({ error: 'Choose a saved funding revision.' }, 400);
  }
  const db = getD1();
  let document: unknown;
  try {
    const row = await db
      .prepare(
        'SELECT document,revision,archived FROM funding_plans WHERE owner_id=? AND id=?',
      )
      .bind(user.userId, id)
      .first<{ document: string; revision: number; archived: number }>();
    if (!row || row.archived)
      return json({ error: 'Active saved funding plan not found.' }, 404);
    if (row.revision !== revision)
      return json(
        { error: 'Funding plan changed. Reload it before reviewing fees.' },
        409,
      );
    document = JSON.parse(row.document);
    const now = Date.now();
    const gate = await db
      .prepare(
        'INSERT INTO wallet_balance_gates(owner_id,next_allowed_at) VALUES (?,?) ON CONFLICT(owner_id) DO UPDATE SET next_allowed_at=excluded.next_allowed_at WHERE wallet_balance_gates.next_allowed_at<=?',
      )
      .bind(user.userId, now + 15000, now)
      .run();
    if (!gate.meta.changes)
      return json(
        {
          error:
            'Wait 15 seconds between balance, holdings or funding fee checks.',
        },
        429,
      );
  } catch {
    return json({ error: 'Funding storage temporarily unavailable.' }, 503);
  }
  let review;
  let batch;
  try {
    const signal = AbortSignal.any([
      request.signal,
      AbortSignal.timeout(mode !== 'review' ? 45000 : 25000),
    ]);
    if (mode === 'prepare-solana') {
      const draft = validateFunding(document);
      batch = draft.assetAddress
        ? await prepareSolanaTokenFunding(draft, signal)
        : await prepareSolanaFunding(draft, signal);
    } else if (mode === 'prepare') {
      batch = await prepareUnsignedFunding(document, signal);
      review = batch.review;
    } else review = await reviewFundingFees(document, signal);
  } catch (error) {
    return json(
      {
        error:
          mode !== 'review'
            ? error instanceof FundingPreparationError ||
              error instanceof SolanaFundingError
              ? error.message.slice(0, 240)
              : 'Unsigned preparation unavailable. Check wallet source, exact asset, provider support and funder balance.'
            : 'Fee review unavailable. Check wallet source, exact asset, provider support and funder balance. No fees or balances are assumed.',
      },
      502,
    );
  }
  try {
    const row = await db
      .prepare(
        'SELECT revision,archived FROM funding_plans WHERE owner_id=? AND id=?',
      )
      .bind(user.userId, id)
      .first<{ revision: number; archived: number }>();
    if (!row || row.archived || row.revision !== revision)
      return json(
        { error: 'Funding plan changed during review. Reload and retry.' },
        409,
      );
  } catch {
    return json({ error: 'Could not confirm the funding revision.' }, 503);
  }
  if (batch && Date.parse(batch.expiresAt) <= Date.now())
    return json(
      {
        error:
          'Unsigned batch expired during revision confirmation. Refresh preparation.',
      },
      409,
    );
  return json({ review, ...(batch ? { batch } : {}), id, revision });
}
