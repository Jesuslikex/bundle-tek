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
import { authorizePairOrderAfterRecheck } from './pair-order-authorization';
import { collectPairRuntimePreview } from './pair-runtime-preview';
import { createPairReadRpc } from './pair-read-rpc';
import { getSolanaIndexerRpcEndpoint } from './solana-rpc';
import {
  readPairOrderMarketBound,
  type PairOrderMarketBound,
} from './pair-order-market-bound';

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
  const ownedSnapshot = () =>
    db
      .prepare(
        "SELECT p.document,p.revision,p.archived,w.revision AS wallet_revision,w.archived AS wallet_archived,w.role,w.updated_at AS wallet_updated_at FROM imported_token_projects p JOIN workspace_wallets w ON w.owner_id=p.owner_id AND w.chain='Solana' AND w.address=? WHERE p.owner_id=? AND p.id=?",
      )
      .bind(request.wallet, owner, request.id)
      .first();
  const originalOwned = await ownedSnapshot();
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
  const market = await readPairOrderMarketBound(
    db,
    owner,
    candidate.preflight.quote,
    candidate.order,
    now(),
  );
  const review = await buildPairOrderFirstReview(
    candidate,
    initial,
    absoluteMinimumRaw,
    now(),
    market,
  );
  const id = crypto.randomUUID();
  if (JSON.stringify(originalOwned) !== JSON.stringify(await ownedSnapshot()))
    throw new ImportedPairQuoteError('Owned review context changed.');
  const record = {
    request: { ...request, absoluteMinimumRaw },
    initial,
    candidate,
    review,
    ownedSnapshot: originalOwned,
    market,
  };
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
    ownedSnapshot: unknown;
    market: PairOrderMarketBound;
  };
  if ((await pairRuntimeDigest(record)) !== row.sha256)
    throw new ImportedPairQuoteError('Saved order evidence changed.');
  const rebuilt = await buildPairOrderFirstReview(
    record.candidate,
    record.initial,
    record.request.absoluteMinimumRaw,
    Date.parse(record.review.createdAt),
    record.market,
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
  signal: AbortSignal = new AbortController().signal,
) {
  const record = await readOwnedPairOrderFirstReview(db, owner, id);
  await requirePairOrderFirstConsent(record.review, consent, now);
  const market = await readPairOrderMarketBound(
    db,
    owner,
    record.candidate.preflight.quote,
    record.candidate.order,
    now,
  );
  if (JSON.stringify(market) !== JSON.stringify(record.market))
    throw new ImportedPairQuoteError(
      'Saved market comparison changed. Request a new review.',
    );
  const policy = pairStockSigningPolicy();
  if (!policy.qualified) throw new ImportedPairQuoteError(policy.reason);
  const controller = new AbortController();
  signal = AbortSignal.any([
    signal,
    controller.signal,
    AbortSignal.timeout(5000),
  ]);
  const reads = createPairReadRpc(getSolanaIndexerRpcEndpoint(), signal);
  const owned = () =>
    db
      .prepare(
        "SELECT p.document,p.revision,p.archived,w.revision AS wallet_revision,w.archived AS wallet_archived,w.role,w.updated_at AS wallet_updated_at,o.address AS proven_address FROM imported_token_projects p JOIN workspace_wallets w ON w.owner_id=p.owner_id AND w.chain='Solana' AND w.address=? LEFT JOIN wallet_ownership_proofs o ON o.owner_id=w.owner_id AND o.chain=w.chain AND o.address=w.address WHERE p.owner_id=? AND p.id=?",
      )
      .bind(record.request.wallet, owner, record.request.id)
      .first<{
        document: string;
        revision: number;
        archived: number;
        wallet_revision: number;
        wallet_archived: number;
        role: string;
        wallet_updated_at: string;
        proven_address: string | null;
      }>();
  try {
    const before = await owned();
    if (
      !before ||
      before.archived ||
      before.wallet_archived ||
      before.revision !== record.request.revision ||
      before.wallet_revision !== record.request.walletRevision ||
      before.proven_address !== record.request.wallet ||
      !['Recipient', 'Funder', 'Deployer'].includes(before.role)
    )
      throw new ImportedPairQuoteError(
        'Saved pair, wallet or ownership proof changed. Request a new review.',
      );
    const { proven_address: _proof, ...ownedBefore } = before;
    if (
      (await pairRuntimeDigest(ownedBefore)) !==
      (await pairRuntimeDigest(record.ownedSnapshot))
    )
      throw new ImportedPairQuoteError(
        'Owned context changed since review. Request a new review.',
      );
    const auth = await authorizePairOrderAfterRecheck(
      record.review,
      consent,
      record.candidate.review,
      async () => {
        // Original packet/lifetime and full code observations, never a new order or reused scan.
        const fresh = await collectPairRuntimePreview(
          record.candidate,
          reads.rpc,
          reads.programRpc,
          signal,
        );
        const after = await owned();
        return {
          packetSha256: fresh.review.packetSha256,
          sourceSnapshotSha256: fresh.review.sourceSnapshotSha256,
          runtimeSha256: fresh.runtime.sha256,
          minimumSlot: fresh.runtime.minimumSlot,
          maximumSlot: fresh.runtime.maximumSlot,
          ownedContextUnchanged:
            JSON.stringify(before) === JSON.stringify(after),
          custodyAndBalancesUnchanged:
            fresh.review.sourceSnapshotSha256 ===
            record.candidate.review.sourceSnapshotSha256,
          originalLifetimeValid:
            Date.now() < Date.parse(fresh.runtime.expiresAt),
          twoCompleteCodeScansMatched: fresh.runtime.codeIdentityObserved,
          // Both remain false today: no preview alone establishes these policies.
          trustedProgramPolicyEstablished: Boolean(
            fresh.runtime.trustedProgramPolicyEstablished,
          ),
          applicationReservationsChecked: Boolean(
            fresh.review.applicationReservationsChecked,
          ),
        };
      },
      signal,
      Date.now,
      now,
    );
    signal.throwIfAborted();
    const saved = await db
      .prepare(
        'INSERT INTO pair_order_first_authorizations (id,review_id,owner_id,document,created_at,expires_at) VALUES (?,?,?,?,?,?)',
      )
      .bind(
        auth.id,
        id,
        owner,
        JSON.stringify(auth),
        auth.createdAt,
        auth.expiresAt,
      )
      .run();
    signal.throwIfAborted();
    if (saved.meta.changes !== 1 || Date.now() >= Date.parse(auth.expiresAt))
      throw new ImportedPairQuoteError(
        'Signing authorization expired. Request a new review.',
      );
    return auth;
  } finally {
    controller.abort();
    reads.close();
  }
}
