import { z } from 'zod';
import { ExchangeFundingError } from './exchange-funding-quote';
import {
  decodeExchangeFundingReview,
  exchangeSolDisplay,
} from './exchange-funding-review';
import {
  EXCHANGE_ORDER_APPROVAL_MS,
  exchangeOrderAuthority,
  exchangeOrderConsent,
  exchangeOrderDigest,
  exchangeOrderIdentity,
  exchangeOrderReviewInput,
  exchangeProviderId,
  matchExchangeProviderOrder,
  observeExchangeProviderOrder,
  requireExchangeOrderTerms,
} from './exchange-order-review';

type QuoteRow = {
  id: string;
  plan_id: string;
  review: string;
  provider_reference: string;
  plan_document: string;
};
type ReviewRow = {
  id: string;
  owner_id: string;
  quote_id: string;
  plan_id: string;
  refund_address: string;
  refund_revision: number;
  document: string;
  sha256: string;
  created_at: string;
  expires_at: string;
};
const reject = (message: string, status = 409): never => {
  throw new ExchangeFundingError(message, status);
};
const parse = <T>(schema: z.ZodType<T>, value: unknown): T => {
  const result = schema.safeParse(value);
  return result.success
    ? result.data
    : reject(
        'Review the exact saved exchange context and separate consent.',
        400,
      );
};
const stamp = (clock: () => number) => new Date(clock()).toISOString();
async function currentQuote(
  db: D1Database,
  owner: string,
  quoteId: string,
  refundAddress: string,
  refundRevision: number,
) {
  return db
    .prepare(`SELECT q.* FROM exchange_funding_quotes q JOIN funding_plans p ON p.owner_id=q.owner_id AND p.id=q.plan_id
    JOIN workspace_wallets f ON f.owner_id=q.owner_id AND f.chain='Solana' AND f.address=json_extract(q.review,'$.funder')
    JOIN workspace_wallets r ON r.owner_id=q.owner_id AND r.chain='Solana' AND r.address=? AND r.revision=?
    WHERE q.owner_id=? AND q.id=? AND p.archived=0 AND p.revision=q.plan_revision AND p.document=q.plan_document
    AND p.updated_at=json_extract(q.review,'$.planUpdatedAt') AND f.archived=0 AND f.revision=q.funder_revision AND r.archived=0
    AND EXISTS(SELECT 1 FROM wallet_ownership_proofs x WHERE x.owner_id=q.owner_id AND x.chain='Solana' AND x.address=f.address)
    AND EXISTS(SELECT 1 FROM wallet_ownership_proofs x WHERE x.owner_id=q.owner_id AND x.chain='Solana' AND x.address=r.address)`)
    .bind(refundAddress, refundRevision, owner, quoteId)
    .first<QuoteRow>();
}
async function reviewRow(db: D1Database, owner: string, id: string) {
  if (!z.uuid().safeParse(id).success)
    return reject('Choose a saved exchange order review.', 400);
  const row = await db
    .prepare(
      'SELECT * FROM exchange_funding_order_reviews WHERE owner_id=? AND id=?',
    )
    .bind(owner, id)
    .first<ReviewRow>();
  if (!row) return reject('Owned exchange order review not found.', 404);
  const terms = requireExchangeOrderTerms(JSON.parse(row.document));
  if (
    terms.id !== row.id ||
    row.sha256 !== (await exchangeOrderDigest(owner, terms))
  )
    return reject('Saved exchange order evidence is inconsistent.', 503);
  return { row, terms };
}
/** Authenticated caller supplies owner. No provider call or authority is granted. */
export async function prepareOwnedExchangeOrderReview(
  db: D1Database,
  owner: string,
  value: unknown,
  now = Date.now,
) {
  const input = parse(exchangeOrderReviewInput, value);
  const q = await currentQuote(
    db,
    owner,
    input.quoteId,
    input.refund.address,
    input.refund.revision,
  );
  if (!q)
    return reject(
      'Current owned quote, proven funder and proven refund wallet are required.',
    );
  const quote = decodeExchangeFundingReview(JSON.parse(q.review));
  const createdAt = stamp(now);
  if (Date.parse(quote.expiresAt) <= now() + EXCHANGE_ORDER_APPROVAL_MS)
    return reject('Request a fresh exchange quote before reviewing an order.');
  const terms = requireExchangeOrderTerms({
    format: 'exchange-order-review-v1',
    id: crypto.randomUUID(),
    quote,
    refund: input.refund,
    createdAt,
    expiresAt: quote.expiresAt,
    ...exchangeOrderAuthority,
  });
  const sha256 = await exchangeOrderDigest(owner, terms);
  if (
    JSON.stringify(q) !==
    JSON.stringify(
      await currentQuote(
        db,
        owner,
        input.quoteId,
        input.refund.address,
        input.refund.revision,
      ),
    )
  )
    return reject('Funding or refund context changed during review.');
  const existing = await db
    .prepare(
      'SELECT id,document FROM exchange_funding_order_reviews WHERE owner_id=? AND quote_id=?',
    )
    .bind(owner, input.quoteId)
    .first<{ id: string; document: string }>();
  if (existing) {
    const saved = requireExchangeOrderTerms(JSON.parse(existing.document));
    if (
      saved.refund.address !== terms.refund.address ||
      saved.refund.revision !== terms.refund.revision
    )
      return reject(
        'This quote already has a different refund review. Request a fresh quote.',
      );
    return readOwnedExchangeOrder(db, owner, existing.id);
  }
  if (Date.parse(terms.expiresAt) <= now() + EXCHANGE_ORDER_APPROVAL_MS)
    return reject('Exchange quote expired while capturing the order review.');
  await db
    .prepare(
      'INSERT INTO exchange_funding_order_reviews(id,owner_id,quote_id,plan_id,refund_address,refund_revision,document,sha256,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
    )
    .bind(
      terms.id,
      owner,
      q.id,
      q.plan_id,
      terms.refund.address,
      terms.refund.revision,
      JSON.stringify(terms),
      sha256,
      createdAt,
      terms.expiresAt,
    )
    .run();
  return readOwnedExchangeOrder(db, owner, terms.id);
}
/** Exact acknowledgement of the saved record. It is not approval to fund, sign or send. */
export async function approveOwnedExchangeOrderReview(
  db: D1Database,
  owner: string,
  value: unknown,
  now = Date.now,
) {
  const consent = parse(exchangeOrderConsent, value),
    { row } = await reviewRow(db, owner, consent.reviewId);
  if (row.sha256 !== consent.sha256)
    return reject('Exchange approval differs from the saved review.');
  const createdAt = stamp(now);
  await db
    .prepare(`INSERT INTO exchange_funding_order_approvals(review_id,owner_id,sha256,consent,created_at)
    SELECT ?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM exchange_funding_order_approvals WHERE review_id=?)`)
    .bind(row.id, owner, row.sha256, JSON.stringify(consent), createdAt, row.id)
    .run();
  return readOwnedExchangeOrder(db, owner, row.id);
}
type Transport = {
  create: (
    body: {
      currency: 'sol';
      network: 'sol';
      toAmount: string;
      address: string;
      refundAddress: string;
      rateId: string;
    },
    signal: AbortSignal,
  ) => Promise<unknown>;
  lookup: (providerId: string, signal: AbortSignal) => Promise<unknown>;
};
/** Internal injectable transport only; no API or live provider adapter calls this function. */
export async function attemptOwnedExchangeOrder(
  db: D1Database,
  owner: string,
  value: unknown,
  signal: AbortSignal,
  transport: Pick<Transport, 'create'>,
  now = Date.now,
) {
  const identity = parse(exchangeOrderIdentity, value),
    { row, terms } = await reviewRow(db, owner, identity.reviewId);
  if (row.sha256 !== identity.sha256)
    return reject('Exchange order identity changed.');
  const prior = await db
    .prepare(
      'SELECT id FROM exchange_funding_order_attempts WHERE review_id=? AND owner_id=?',
    )
    .bind(row.id, owner)
    .first();
  if (prior) return readOwnedExchangeOrder(db, owner, row.id);
  const q = await currentQuote(
    db,
    owner,
    row.quote_id,
    row.refund_address,
    row.refund_revision,
  );
  if (!q) return reject('Current funding and proven refund context changed.');
  signal.throwIfAborted();
  const approval = await db
    .prepare(
      'SELECT created_at FROM exchange_funding_order_approvals WHERE review_id=? AND owner_id=?',
    )
    .bind(row.id, owner)
    .first<{ created_at: string }>();
  if (
    !approval ||
    now() < Date.parse(approval.created_at) ||
    now() >= Date.parse(approval.created_at) + EXCHANGE_ORDER_APPROVAL_MS
  )
    return reject(
      'Order approval expired or is missing. Review a fresh quote.',
    );
  const createdAt = stamp(now);
  const claimed = await db
    .prepare(`INSERT INTO exchange_funding_order_attempts(review_id,owner_id,plan_id,id,created_at)
    SELECT ?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM exchange_funding_order_attempts WHERE review_id=? OR (owner_id=? AND plan_id=?))`)
    .bind(
      row.id,
      owner,
      row.plan_id,
      crypto.randomUUID(),
      createdAt,
      row.id,
      owner,
      row.plan_id,
    )
    .run();
  if (claimed.meta.changes !== 1) {
    const same = await db
      .prepare(
        'SELECT id FROM exchange_funding_order_attempts WHERE owner_id=? AND review_id=?',
      )
      .bind(owner, row.id)
      .first();
    return same
      ? readOwnedExchangeOrder(db, owner, row.id)
      : reject('This draft already has an unresolved exchange order attempt.');
  }
  // An attempt exists before transport entry. A crash/abort cannot authorize a retry.
  let transportEntered = false;
  try {
    signal.throwIfAborted();
    const enteredAt = now();
    if (
      enteredAt < Date.parse(approval.created_at) ||
      enteredAt >= Date.parse(terms.expiresAt) ||
      enteredAt >= Date.parse(approval.created_at) + EXCHANGE_ORDER_APPROVAL_MS
    )
      throw new Error('Order authorization expired before transport entry.');
    transportEntered = true;
    const raw = await transport.create(
      {
        currency: 'sol',
        network: 'sol',
        toAmount: exchangeSolDisplay(terms.quote.expectedPayoutLamports),
        address: terms.quote.funder,
        refundAddress: terms.refund.address,
        rateId: q.provider_reference,
      },
      signal,
    );
    const id = z.object({ id: exchangeProviderId }).safeParse(raw);
    if (id.success)
      await db
        .prepare(
          'INSERT INTO exchange_funding_order_references(review_id,owner_id,provider_id,created_at) VALUES(?,?,?,?)',
        )
        .bind(row.id, owner, id.data.id, stamp(now))
        .run();
    const order = matchExchangeProviderOrder(raw, terms);
    await saveResult(db, owner, row.id, 'matched', order, stamp(now), true);
  } catch {
    await saveResult(
      db,
      owner,
      row.id,
      'unresolved',
      null,
      stamp(now),
      transportEntered,
    );
  }
  return readOwnedExchangeOrder(db, owner, row.id);
}
async function saveResult(
  db: D1Database,
  owner: string,
  id: string,
  outcome: 'matched' | 'unresolved',
  order: ReturnType<typeof matchExchangeProviderOrder> | null,
  createdAt: string,
  transportEntered: boolean,
) {
  const document = {
    format: 'exchange-order-result-v1',
    outcome,
    order,
    transportEntered,
    payoutVerified: false,
    refundVerified: false,
    ...exchangeOrderAuthority,
  };
  await db
    .prepare(
      'INSERT INTO exchange_funding_order_results(review_id,owner_id,outcome,document,created_at) VALUES(?,?,?,?,?)',
    )
    .bind(id, owner, outcome, JSON.stringify(document), createdAt)
    .run();
}
/** Read-only reconciliation. Uses only the retained provider reference; never creates an order. */
export async function observeOwnedExchangeOrder(
  db: D1Database,
  owner: string,
  id: string,
  signal: AbortSignal,
  transport: Pick<Transport, 'lookup'>,
  now = Date.now,
) {
  const { row, terms } = await reviewRow(db, owner, id);
  const ref = await db
    .prepare(
      'SELECT provider_id FROM exchange_funding_order_references WHERE review_id=? AND owner_id=?',
    )
    .bind(id, owner)
    .first<{ provider_id: string }>();
  if (!ref)
    return reject(
      'No provider reference was retained. Reconcile this attempt without creating another order.',
    );
  const result = await db
    .prepare(
      'SELECT document FROM exchange_funding_order_results WHERE review_id=? AND owner_id=?',
    )
    .bind(id, owner)
    .first<{ document: string }>();
  const original = result
    ? (JSON.parse(result.document) as {
        order: { depositAddress: string } | null;
      })
    : null;
  const previous = await db
    .prepare(
      'SELECT document FROM exchange_funding_order_observations WHERE review_id=? AND owner_id=? ORDER BY created_at DESC,id DESC LIMIT 1',
    )
    .bind(id, owner)
    .first<{ document: string }>();
  const prior = previous
    ? (JSON.parse(previous.document) as {
        depositAddress: string;
        providerStatus: string;
      })
    : null;
  signal.throwIfAborted();
  const observation = observeExchangeProviderOrder(
    await transport.lookup(ref.provider_id, signal),
    terms,
    ref.provider_id,
    original?.order?.depositAddress ?? prior?.depositAddress,
  );
  if (
    prior &&
    ['finished', 'refunded', 'failed'].includes(prior.providerStatus) &&
    prior.providerStatus !== observation.providerStatus
  )
    return reject(
      'Provider status contradicted a retained terminal report. No funding state changed.',
    );
  const document = { format: 'exchange-order-observation-v1', ...observation };
  await db
    .prepare(
      'INSERT INTO exchange_funding_order_observations(id,review_id,owner_id,document,created_at) VALUES(?,?,?,?,?)',
    )
    .bind(
      crypto.randomUUID(),
      row.id,
      owner,
      JSON.stringify(document),
      stamp(now),
    )
    .run();
  return readOwnedExchangeOrder(db, owner, id);
}
/** Historical state stays readable after the plan changes or expires. No deposit instructions are exposed. */
export async function readOwnedExchangeOrder(
  db: D1Database,
  owner: string,
  id: string,
) {
  const { row, terms } = await reviewRow(db, owner, id);
  const [approval, attempt, reference, result, observation] = await Promise.all(
    [
      db
        .prepare(
          'SELECT created_at FROM exchange_funding_order_approvals WHERE review_id=? AND owner_id=?',
        )
        .bind(id, owner)
        .first<{ created_at: string }>(),
      db
        .prepare(
          'SELECT id FROM exchange_funding_order_attempts WHERE review_id=? AND owner_id=?',
        )
        .bind(id, owner)
        .first(),
      db
        .prepare(
          'SELECT provider_id FROM exchange_funding_order_references WHERE review_id=? AND owner_id=?',
        )
        .bind(id, owner)
        .first(),
      db
        .prepare(
          'SELECT outcome FROM exchange_funding_order_results WHERE review_id=? AND owner_id=?',
        )
        .bind(id, owner)
        .first<{ outcome: string }>(),
      db
        .prepare(
          'SELECT document FROM exchange_funding_order_observations WHERE review_id=? AND owner_id=? ORDER BY created_at DESC,id DESC LIMIT 1',
        )
        .bind(id, owner)
        .first<{ document: string }>(),
    ],
  );
  const providerStatus = observation
    ? (JSON.parse(observation.document) as { providerStatus: string })
        .providerStatus
    : null;
  let state = approval ? 'approved' : 'review';
  if (attempt)
    state =
      result?.outcome === 'matched'
        ? 'provider-order-matched'
        : 'creation-unresolved';
  if (providerStatus) {
    const states: Record<string, string> = {
      new: 'provider-order-matched',
      waiting: 'provider-order-matched',
      confirming: 'provider-processing',
      exchanging: 'provider-processing',
      sending: 'provider-processing',
      finished: 'payout-unverified',
      refunded: 'refund-unverified',
      verifying: 'provider-verification-required',
      failed: 'provider-failed',
    };
    state =
      states[providerStatus] ??
      reject('Saved provider status is inconsistent.', 503);
  }
  return {
    terms,
    sha256: row.sha256,
    approved: Boolean(approval),
    approvalExpiresAt: approval
      ? new Date(
          Date.parse(approval.created_at) + EXCHANGE_ORDER_APPROVAL_MS,
        ).toISOString()
      : null,
    state,
    providerStatus,
    providerReferenceRetained: Boolean(reference),
    retryCreationAllowed: false as const,
    payoutVerified: false as const,
    refundVerified: false as const,
    ...exchangeOrderAuthority,
  };
}
