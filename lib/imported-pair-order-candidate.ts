import { env } from './server-env';
import {
  ImportedPairQuoteError,
  importedPairProviderError,
  configuredPairQuoteDependencies,
  type ImportedPairQuoteDependencies,
} from './imported-pair-quote-service';
import {
  importedPairWalletRequest,
  preflightOwnedImportedPairWallet,
  type ImportedPairWalletRequest,
} from './imported-pair-wallet-preflight';
import { prepareSolanaPair } from './warmup-swap-quote';
import { collectPairOrderReview } from './pair-order-collector';
import { parseImportedPairQuote } from './imported-trade-pair';
import {
  assertPairOrderQuoteBounds,
  PairOrderQuoteBoundsError,
} from './pair-order-quote-bounds';
export type ImportedPairOrderRequest = ImportedPairWalletRequest & {
  prepareUnsigned: true;
};
export type ImportedPairOrderDependencies = ImportedPairQuoteDependencies & {
  prepare: (
    input: Parameters<typeof prepareSolanaPair>[0],
    signal: AbortSignal,
  ) => ReturnType<typeof prepareSolanaPair>;
};
export function importedPairOrderRequest(
  value: unknown,
): ImportedPairOrderRequest {
  const v = value as Record<string, unknown>;
  if (
    !v ||
    v.prepareUnsigned !== true ||
    Object.keys(v).sort().join(',') !==
      'amount,feeAndRentLimitRaw,id,prepareUnsigned,quoteMint,revision,side,wallet,walletRevision'
  )
    throw new ImportedPairQuoteError(
      'Explicit unsigned preparation and the current saved pair and wallet are required.',
      400,
    );
  const { prepareUnsigned: _consent, ...rest } = v;
  return { ...importedPairWalletRequest(rest), prepareUnsigned: true };
}
/** Shared owned preparation lifecycle. The inspector must finish before any candidate is published. */
export async function inspectOwnedImportedPairOrder<Review>(
  db: D1Database,
  owner: string,
  value: ImportedPairOrderRequest,
  signal: AbortSignal,
  dependencies: ImportedPairOrderDependencies | undefined,
  inspect: (
    preflight: Awaited<ReturnType<typeof preflightOwnedImportedPairWallet>>,
    order: Awaited<ReturnType<typeof prepareSolanaPair>>,
    rpc: ImportedPairOrderDependencies['rpc'],
    now: () => number,
  ) => Promise<Review>,
) {
  const input = importedPairOrderRequest(value);
  signal = AbortSignal.any([signal, AbortSignal.timeout(30000)]);
  let abort: () => void = () => {};
  const run = async () => {
    signal.throwIfAborted();
    const read = () =>
      db
        .prepare(
          "SELECT p.chain,p.address,p.revision,p.archived,p.document,w.revision AS wallet_revision,w.archived AS wallet_archived,w.role,w.updated_at AS wallet_updated_at FROM imported_token_projects p JOIN workspace_wallets w ON w.owner_id=p.owner_id AND w.chain='Solana' AND w.address=? WHERE p.owner_id=? AND p.id=?",
        )
        .bind(input.wallet, owner, input.id)
        .first<{
          chain: string;
          address: string;
          revision: number;
          archived: number;
          document: string;
          wallet_revision: number;
          wallet_archived: number;
          role: string;
          wallet_updated_at: string;
        }>();
    const source = await read();
    signal.throwIfAborted();
    if (!source)
      throw new ImportedPairQuoteError(
        'Saved project or wallet not found.',
        404,
      );
    if (
      source.archived ||
      source.wallet_archived ||
      source.chain !== 'Solana' ||
      source.revision !== input.revision ||
      source.wallet_revision !== input.walletRevision
    )
      throw new ImportedPairQuoteError(
        'Saved project or wallet changed or is archived.',
      );
    let provider = dependencies;
    if (!provider) {
      const quote = configuredPairQuoteDependencies(signal);
      provider = {
        ...quote,
        prepare: (input, s) => prepareSolanaPair(input, env.JUPITER_API_KEY, s),
      };
    }
    const checked = async (method: string, params: unknown[]) => {
      signal.throwIfAborted();
      let result: unknown;
      try {
        result = await provider!.rpc(method, params);
      } catch (error) {
        signal.throwIfAborted();
        throw importedPairProviderError(
          error,
          'Pair candidate provider reads are unavailable.',
        );
      }
      signal.throwIfAborted();
      return result;
    };
    const { prepareUnsigned: _consent, ...walletRequest } = input;
    const preflight = await preflightOwnedImportedPairWallet(
      db,
      owner,
      walletRequest,
      signal,
      provider,
    );
    if (!preflight.funding.canRequestUnsignedOrder)
      throw new ImportedPairQuoteError(
        'Selected accounts need sufficient source units, usable custody and the reviewed SOL fee/rent reserve before preparing an order.',
      );
    const pair = preflight.quote.pair;
    let order: Awaited<ReturnType<typeof prepareSolanaPair>>;
    try {
      order = await provider.prepare(
        {
          baseMint: pair.base.address,
          quoteMint: pair.quote.address,
          side: input.side,
          amountRaw: preflight.quote.inputRaw,
          wallet: input.wallet,
        },
        signal,
      );
    } catch {
      throw new ImportedPairQuoteError(
        'Wallet-bound unsigned order provider is unavailable or returned an unsupported packet. No approval or signature was created.',
        502,
      );
    }
    signal.throwIfAborted();
    assertPairOrderQuoteBounds(preflight.quote, order, preflight.wallet);
    const review = await inspect(
      preflight,
      order,
      checked,
      provider.now ?? Date.now,
    );
    signal.throwIfAborted();
    const current = await read();
    signal.throwIfAborted();
    if (JSON.stringify(source) !== JSON.stringify(current))
      throw new ImportedPairQuoteError(
        'Project or wallet changed while preparing the unsigned candidate.',
      );
    const now = provider.now ?? Date.now;
    await parseImportedPairQuote(
      preflight.quote,
      {
        projectId: pair.projectId,
        projectRevision: pair.projectRevision,
        baseMint: pair.base.address,
        baseDecimals: pair.base.decimals,
        baseSymbol: pair.base.symbol,
        quoteMint: pair.quote.address,
        quoteDecimals: pair.quote.decimals,
        quoteSymbol: pair.quote.symbol,
        side: input.side,
        amount: input.amount,
      },
      now(),
    );
    signal.throwIfAborted();
    return {
      format: 'imported-pair-order-candidate-v1' as const,
      preflight,
      order,
      review,
      candidatePrepared: true as const,
      economicSimulationVerified: true as const,
      approvalCreated: false as const,
      reservationCreated: false as const,
      signingAllowed: false as const,
      executionAllowed: false as const,
    };
  };
  try {
    return await Promise.race([
      run(),
      new Promise<never>((_resolve, reject) => {
        abort = () =>
          reject(
            new ImportedPairQuoteError(
              'Pair candidate preparation timed out or was cancelled.',
              408,
            ),
          );
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      }),
    ]);
  } catch (error) {
    if (error instanceof PairOrderQuoteBoundsError)
      throw new ImportedPairQuoteError(error.message);
    if (error instanceof ImportedPairQuoteError) throw error;
    const failure = new ImportedPairQuoteError(
      'Unsigned pair candidate did not pass independent account, instruction, simulation, fee or lifetime review. No approval or signature was created.',
    );
    Object.defineProperty(failure, 'cause', { value: error });
    throw failure;
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

export function prepareOwnedImportedPairOrder(
  db: D1Database,
  owner: string,
  value: ImportedPairOrderRequest,
  signal: AbortSignal,
  dependencies?: ImportedPairOrderDependencies,
) {
  return inspectOwnedImportedPairOrder(
    db,
    owner,
    value,
    signal,
    dependencies,
    (preflight, order, rpc, now) =>
      collectPairOrderReview(preflight, order, rpc, now),
  );
}
