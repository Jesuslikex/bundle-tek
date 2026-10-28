import { stockPairAccountLimit } from './pair-stock-clock';
import { env } from './server-env';
import { createStockPairEvidenceRpc } from './pair-stock-clock';
import { walletAddress } from './wallet-workspace';
import type { observeTokenMarket } from './token-market';
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
import {
  PairTrustedProgramError,
  requirePairTrustedPrograms,
} from './pair-trusted-programs';
import {
  pairOrderReservationAvailable,
  publicPairOrderExecution,
  readOwnedPairOrderExecution,
} from './pair-order-execution';
import { collectPairRuntimePreview } from './pair-runtime-preview';
import { assertPairOrderQuoteBounds } from './pair-order-quote-bounds';
import { createPairReadRpc } from './pair-read-rpc';
import { getSolanaStockRuntimeRpcEndpoint } from './solana-rpc';
import {
  readPairOrderMarketBound,
  readPairQuoteUsdObservation,
  type PairOrderMarketBound,
} from './pair-order-market-bound';

export type PairOrderFirstRequest = ImportedPairOrderRequest & {
  absoluteMinimumRaw: string | null;
  marketPair?: string | null;
};
async function waitForProvisionalOrder<T>(
  pending: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  signal.throwIfAborted();
  let abort = () => {};
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      }),
    ]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
}
type PairOrderFirstDependencies = ImportedPairOrderDependencies & {
  observeQuoteMarket?: typeof observeTokenMarket;
};
export function pairOrderFirstRequest(value: unknown): PairOrderFirstRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new ImportedPairQuoteError('Order review request required.', 400);
  const {
    absoluteMinimumRaw,
    marketPair = null,
    ...rest
  } = value as Record<string, unknown>;
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
  if (marketPair !== null) {
    try {
      if (walletAddress(marketPair, 'Solana') !== marketPair) throw Error();
    } catch {
      throw new ImportedPairQuoteError(
        'Choose the exact saved market pair.',
        400,
      );
    }
  }
  return {
    ...importedPairOrderRequest(rest),
    absoluteMinimumRaw,
    marketPair: marketPair as string | null,
  };
}
export async function prepareOwnedPairOrderFirstReview(
  db: D1Database,
  owner: string,
  value: PairOrderFirstRequest,
  signal: AbortSignal,
  dependencies?: PairOrderFirstDependencies,
) {
  return preparePairOrderFirst(db, owner, value, signal, dependencies);
}

/** Internal unsigned qualification only; no request flag, approval or signing authority. */
export async function qualifyOwnedPairOrderFirstRuntime(
  db: D1Database,
  owner: string,
  value: PairOrderFirstRequest,
  signal: AbortSignal,
  dependencies?: PairOrderFirstDependencies & {
    programRpc?: ImportedPairOrderDependencies['rpc'];
  },
) {
  const child = new AbortController();
  signal = AbortSignal.any([signal, child.signal, AbortSignal.timeout(45000)]);
  const reads = dependencies
    ? undefined
    : createPairReadRpc(
        getSolanaStockRuntimeRpcEndpoint(),
        signal,
        fetch,
        'configured',
        stockPairAccountLimit(getSolanaStockRuntimeRpcEndpoint()),
      );
  try {
    const provider = dependencies ?? {
      ...configuredPairQuoteDependencies(
        signal,
        getSolanaStockRuntimeRpcEndpoint(),
      ),
      rpc: reads!.rpc,
      prepare: (
        input: Parameters<typeof prepareSolanaPair>[0],
        s: AbortSignal,
      ) => prepareSolanaPair(input, env.JUPITER_API_KEY, s),
    };
    const result = await preparePairOrderFirst(
      db,
      owner,
      value,
      signal,
      provider,
      dependencies?.programRpc ?? reads?.programRpc ?? provider.rpc,
    );
    if (!result.runtime)
      throw new ImportedPairQuoteError(
        'Unsigned runtime qualification evidence is missing.',
      );
    return {
      ...result,
      runtime: result.runtime,
      signingAllowed: false as const,
      executionAllowed: false as const,
    };
  } finally {
    child.abort();
    reads?.close();
  }
}

async function preparePairOrderFirst(
  db: D1Database,
  owner: string,
  value: PairOrderFirstRequest,
  signal: AbortSignal,
  dependencies?: PairOrderFirstDependencies,
  programRpc?: ImportedPairOrderDependencies['rpc'],
) {
  const {
    absoluteMinimumRaw,
    marketPair = null,
    ...request
  } = pairOrderFirstRequest(value);
  signal = AbortSignal.any([signal, AbortSignal.timeout(45000)]);
  const provider: PairOrderFirstDependencies = {
    ...(dependencies ?? {
      ...configuredPairQuoteDependencies(
        signal,
        getSolanaStockRuntimeRpcEndpoint(),
      ),
      prepare: (
        input: Parameters<typeof prepareSolanaPair>[0],
        s: AbortSignal,
      ) => prepareSolanaPair(input, env.JUPITER_API_KEY, s),
    }),
    quoteScope: createPairOrderQuoteScope(),
  };
  const stockReads = createStockPairEvidenceRpc(
    provider.rpc,
    programRpc ?? provider.rpc,
    provider.now,
    { endpoint: getSolanaStockRuntimeRpcEndpoint(), signal },
  );
  provider.rpc = stockReads.rpc;
  if (programRpc) programRpc = stockReads.programRpc;
  const ownedSnapshot = () =>
    db
      .prepare(
        "SELECT p.document,p.revision,p.archived,w.revision AS wallet_revision,w.archived AS wallet_archived,w.role,w.updated_at AS wallet_updated_at FROM imported_token_projects p JOIN workspace_wallets w ON w.owner_id=p.owner_id AND w.chain='Solana' AND w.address=? WHERE p.owner_id=? AND p.id=?",
      )
      .bind(request.wallet, owner, request.id)
      .first<{
        document: string;
        revision: number;
        archived: number;
        wallet_revision: number;
        wallet_archived: number;
        role: string;
        wallet_updated_at: string;
      }>();
  const originalOwned = await ownedSnapshot();
  if (
    !originalOwned ||
    originalOwned.archived ||
    originalOwned.wallet_archived ||
    originalOwned.revision !== request.revision ||
    originalOwned.wallet_revision !== request.walletRevision ||
    !['Recipient', 'Deployer', 'Funder'].includes(originalOwned.role)
  )
    throw new ImportedPairQuoteError(
      'Saved project or wallet changed or is archived.',
    );
  const now = provider.now ?? Date.now;
  // Server-created Jupiter baseline, never an arbitrary client-supplied number.
  const {
    prepareUnsigned: _consent,
    wallet: _wallet,
    walletRevision: _revision,
    feeAndRentLimitRaw: _limit,
    ...quoteRequest
  } = request;
  // Start the unsigned provider order after the quote returns, in parallel with
  // the quote's mandatory post-read checks. It remains private until all of
  // those checks and the strict initial-minimum comparison have succeeded.
  const speculative = new AbortController();
  const orderSignal = AbortSignal.any([signal, speculative.signal]);
  let pendingOrder:
    | Promise<
        | { order: Awaited<ReturnType<typeof prepareSolanaPair>> }
        | { error: unknown }
      >
    | undefined;
  let initial: Awaited<ReturnType<typeof quoteOwnedImportedPair>>;
  try {
    initial = await quoteOwnedImportedPair(db, owner, quoteRequest, signal, {
      ...provider,
      onQuoteObserved: (observed) => {
        if (pendingOrder)
          throw new ImportedPairQuoteError(
            'Duplicate provisional quote observation.',
          );
        pendingOrder = (async () => {
          orderSignal.throwIfAborted();
          if (
            JSON.stringify(await ownedSnapshot()) !==
            JSON.stringify(originalOwned)
          )
            throw new ImportedPairQuoteError('Owned review context changed.');
          orderSignal.throwIfAborted();
          try {
            return await provider.prepare(
              { ...observed, wallet: request.wallet },
              orderSignal,
            );
          } catch {
            orderSignal.throwIfAborted();
            throw new ImportedPairQuoteError(
              'Wallet-bound unsigned order provider is unavailable or returned an unsupported packet. No approval or signature was created.',
              502,
            );
          }
        })().then(
          (order) => ({ order }),
          (error) => ({ error }),
        );
      },
    });
  } catch (error) {
    speculative.abort();
    throw error;
  }
  signal.throwIfAborted();
  // Run the independent quote observation alongside packet preparation/code IO,
  // not after the final on-chain recheck. Scaled units are deliberately unsupported.
  const quoteObservationPending =
    marketPair &&
    initial.pair.base.amountPolicy.kind === 'unscaled' &&
    initial.pair.quote.amountPolicy.kind === 'unscaled'
      ? readPairQuoteUsdObservation(
          initial.pair.quote.address,
          signal,
          provider.observeQuoteMarket,
        )
      : Promise.resolve(null);
  if (!pendingOrder)
    throw new ImportedPairQuoteError(
      'Unsigned order observation is unavailable.',
    );
  let outcome: Awaited<typeof pendingOrder>;
  try {
    outcome = await waitForProvisionalOrder(pendingOrder, orderSignal);
  } finally {
    speculative.abort();
  }
  if ('error' in outcome) throw outcome.error;
  const order = outcome.order;
  signal.throwIfAborted();
  // Existing owned lifecycle now fetches its fresh quote AFTER packet preparation.
  // Protect the initial preview strictly before requesting the fresh reference.
  assertPairOrderQuoteBounds(initial, order, request.wallet);
  let runtime:
    | Awaited<ReturnType<typeof collectPairRuntimePreview>>['runtime']
    | undefined;
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
    async (preflight, packet, rpc, clock) => {
      if (!programRpc)
        return collectPairOrderReview(
          preflight,
          packet,
          rpc,
          clock,
          false,
          undefined,
          'fresh-reference',
        );
      const collected = await collectPairRuntimePreview(
        { preflight, order: packet },
        rpc,
        programRpc,
        signal,
        clock,
        'fresh-reference',
      );
      runtime = collected.runtime;
      return collected.review;
    },
    'fresh-reference',
  );
  const quoteObservation = await quoteObservationPending;
  const market = await readPairOrderMarketBound(
    db,
    owner,
    candidate.preflight.quote,
    candidate.order,
    now(),
    {
      selectedMarketPair: marketPair,
      quoteObservation,
      signal,
    },
  );
  const review = await buildPairOrderFirstReview(
    candidate,
    initial,
    absoluteMinimumRaw,
    now(),
    market,
    marketPair,
  );
  const id = crypto.randomUUID();
  if (JSON.stringify(originalOwned) !== JSON.stringify(await ownedSnapshot()))
    throw new ImportedPairQuoteError('Owned review context changed.');
  const record = {
    clockObservations: stockReads.observations,
    request: { ...request, absoluteMinimumRaw, marketPair },
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
  return {
    id,
    review,
    clockObservations: stockReads.observations,
    ...(runtime ? { runtime } : {}),
  };
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
    record.request.marketPair ?? null,
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
    {
      selectedMarketPair: record.request.marketPair ?? null,
      quoteObservation: record.market.available
        ? record.market.quoteObservation
        : null,
      signal,
    },
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
  const reads = createPairReadRpc(getSolanaStockRuntimeRpcEndpoint(), signal);
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
          // Pinned allowlist against both complete scans, never a preview flag.
          trustedProgramPolicyEstablished: (() => {
            try {
              return requirePairTrustedPrograms(
                fresh.codeScans[0],
                fresh.codeScans[1],
              );
            } catch (error) {
              if (error instanceof PairTrustedProgramError) return false;
              throw error;
            }
          })(),
          // The insert trigger rechecks this atomically with the authorization.
          applicationReservationsChecked: await pairOrderReservationAvailable(
            db,
            owner,
            record.request.wallet,
          ),
        };
      },
      signal,
      Date.now,
      now,
    );
    signal.throwIfAborted();
    const order = record.candidate.order;
    const results = await db.batch([
      db
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
        ),
      db
        .prepare(
          "INSERT INTO pair_order_executions (authorization_id,review_id,owner_id,wallet,packet,packet_sha256,input_mint,output_mint,minimum_output_raw,last_valid_block_height,authorization_expires_at,review_expires_at,state,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'reserved',?,?)",
        )
        .bind(
          auth.id,
          id,
          owner,
          record.request.wallet,
          order.preparation.transaction,
          order.preparation.sha256,
          record.review.inputMint,
          record.review.outputMint,
          auth.minimumOutputRaw,
          order.preparation.lastValidBlockHeight,
          auth.expiresAt,
          record.review.expiresAt,
          auth.createdAt,
          auth.createdAt,
        ),
    ]);
    signal.throwIfAborted();
    if (
      results.some((r) => r.meta.changes !== 1) ||
      Date.now() >= Date.parse(auth.expiresAt)
    )
      throw new ImportedPairQuoteError(
        'Signing authorization expired. Request a new review.',
      );
    const execution = publicPairOrderExecution(
      await readOwnedPairOrderExecution(db, owner, auth.id),
    );
    return { ...auth, execution };
  } finally {
    controller.abort();
    reads.close();
  }
}
