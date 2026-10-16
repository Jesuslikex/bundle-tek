import { env } from './server-env';
import {
  quoteOwnedImportedPair,
  configuredPairQuoteDependencies,
  createPairOrderQuoteScope,
  ImportedPairQuoteError,
} from './imported-pair-quote-service';
import {
  importedPairOrderRequest,
  inspectOwnedImportedPairOrder,
  type ImportedPairOrderDependencies,
  type ImportedPairOrderRequest,
} from './imported-pair-order-candidate';
import { prepareSolanaPair } from './warmup-swap-quote';
import { collectPairOrderReview } from './pair-order-collector';
import {
  buildPairOrderFirstReview,
  requirePairOrderFirstConsent,
  type PairOrderFirstConsent,
} from './pair-order-first-review';
import { pairRuntimeDigest } from './pair-runtime-trace';
import { pairStockSigningPolicy } from './pair-stock-signing-policy';

export type PairOrderFirstRequest = ImportedPairOrderRequest & {
  absoluteMinimumRaw: string | null;
};
export function pairOrderFirstRequest(value: unknown): PairOrderFirstRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new ImportedPairQuoteError('Order review request required.', 400);
  const { absoluteMinimumRaw, ...rest } = value as Record<string, unknown>;
  if (
    absoluteMinimumRaw !== null &&
    (typeof absoluteMinimumRaw !== 'string' ||
      !/^[1-9]\d{0,19}$/.test(absoluteMinimumRaw) ||
      BigInt(absoluteMinimumRaw) > (1n << 64n) - 1n)
  )
    throw new ImportedPairQuoteError(
      'Choose a positive raw absolute minimum or null.',
      400,
    );
  return { ...importedPairOrderRequest(rest), absoluteMinimumRaw };
}
export async function prepareOwnedPairOrderFirstReview(
  db: D1Database,
  owner: string,
  value: PairOrderFirstRequest,
  signal: AbortSignal,
  dependencies?: ImportedPairOrderDependencies,
) {
  const { absoluteMinimumRaw, ...request } = pairOrderFirstRequest(value);
  signal = AbortSignal.any([signal, AbortSignal.timeout(45000)]);
  const provider = {
    ...(dependencies ?? {
      ...configuredPairQuoteDependencies(signal),
      prepare: (
        input: Parameters<typeof prepareSolanaPair>[0],
        s: AbortSignal,
      ) => prepareSolanaPair(input, env.JUPITER_API_KEY, s),
    }),
    quoteScope: createPairOrderQuoteScope(),
  };
  const now = provider.now ?? Date.now;
  // Server-created independent baseline, never an arbitrary client-supplied number.
  const {
    prepareUnsigned: _consent,
    wallet: _wallet,
    walletRevision: _revision,
    feeAndRentLimitRaw: _limit,
    ...quoteRequest
  } = request;
  const initial = await quoteOwnedImportedPair(
    db,
    owner,
    quoteRequest,
    signal,
    provider,
  );
  signal.throwIfAborted();
  const order = await provider.prepare(
    {
      baseMint: initial.pair.base.address,
      quoteMint: initial.pair.quote.address,
      side: request.side,
      amountRaw: initial.inputRaw,
      wallet: request.wallet,
    },
    signal,
  );
  signal.throwIfAborted();
  // Existing owned lifecycle now fetches its fresh quote AFTER packet preparation.
  // Its unchanged lower-bound check and independent decoder/simulation still run.
  const candidate = await inspectOwnedImportedPairOrder(
    db,
    owner,
    request,
    signal,
    {
      ...provider,
      prepare: async (input) => {
        if (
          input.wallet !== request.wallet ||
          input.baseMint !== initial.pair.base.address ||
          input.quoteMint !== request.quoteMint ||
          input.side !== request.side ||
          input.amountRaw !== initial.inputRaw
        )
          throw new ImportedPairQuoteError(
            'Pair units changed; request a new review.',
          );
        return order;
      },
    },
    (preflight, packet, rpc, clock) =>
      collectPairOrderReview(preflight, packet, rpc, clock),
  );
  const review = await buildPairOrderFirstReview(
    candidate,
    initial,
    absoluteMinimumRaw,
    now(),
  );
  const id = crypto.randomUUID();
  const record = { request: value, initial, candidate, review };
  const document = JSON.stringify(record),
    digest = await pairRuntimeDigest(record);
  if (document.length > 400000)
    throw new ImportedPairQuoteError(
      'Order review evidence exceeds the storage limit.',
    );
  signal.throwIfAborted();
  const saved = await db
    .prepare(
      'INSERT INTO pair_order_first_reviews (id,owner_id,project_id,project_revision,wallet,wallet_revision,document,sha256,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
    )
    .bind(
      id,
      owner,
      request.id,
      request.revision,
      request.wallet,
      request.walletRevision,
      document,
      digest,
      review.createdAt,
      review.expiresAt,
    )
    .run();
  signal.throwIfAborted();
  if (saved.meta.changes !== 1)
    throw new ImportedPairQuoteError('Order review could not be saved.');
  return { id, review };
}

export async function readOwnedPairOrderFirstReview(
  db: D1Database,
  owner: string,
  id: string,
) {
  if (!/^[a-f0-9-]{36}$/.test(id))
    throw new ImportedPairQuoteError('Invalid review id.', 400);
  const row = await db
    .prepare(
      'SELECT document,sha256 FROM pair_order_first_reviews WHERE id=? AND owner_id=?',
    )
    .bind(id, owner)
    .first<{ document: string; sha256: string }>();
  if (!row) throw new ImportedPairQuoteError('Order review not found.', 404);
  const record = JSON.parse(row.document) as {
    request: PairOrderFirstRequest;
    initial: Parameters<typeof buildPairOrderFirstReview>[1];
    candidate: Parameters<typeof buildPairOrderFirstReview>[0];
    review: Awaited<ReturnType<typeof buildPairOrderFirstReview>>;
  };
  if ((await pairRuntimeDigest(record)) !== row.sha256)
    throw new ImportedPairQuoteError('Saved order evidence changed.');
  const rebuilt = await buildPairOrderFirstReview(
    record.candidate,
    record.initial,
    record.request.absoluteMinimumRaw,
    Date.parse(record.review.createdAt),
  );
  if (JSON.stringify(rebuilt) !== JSON.stringify(record.review))
    throw new ImportedPairQuoteError('Saved order review changed.');
  return record;
}

/** Production boundary: disabled before any authorization or wallet material is issued. */
export async function approveOwnedPairOrderFirstReview(
  db: D1Database,
  owner: string,
  id: string,
  consent: PairOrderFirstConsent,
  now = Date.now(),
) {
  const record = await readOwnedPairOrderFirstReview(db, owner, id);
  await requirePairOrderFirstConsent(record.review, consent, now);
  const policy = pairStockSigningPolicy();
  if (!policy.qualified) throw new ImportedPairQuoteError(policy.reason);
  // Deliberate second stop: qualification alone must never bypass the as-yet
  // unavailable trusted-code/reservation/browser-signing implementation.
  throw new ImportedPairQuoteError(
    'Fresh runtime authorization and signing are not released. Request a new review when available.',
  );
}
