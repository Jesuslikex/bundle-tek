import { env } from './server-env';
import { balanceRpc } from './wallet-balances';
import { getSolanaIndexerRpcEndpoint } from './solana-rpc';
import {
  ImportedPairQuoteError,
  configuredPairQuoteDependencies,
} from './imported-pair-quote-service';
import {
  importedPairOrderRequest,
  prepareOwnedImportedPairOrder,
  type ImportedPairOrderDependencies,
  type ImportedPairOrderRequest,
} from './imported-pair-order-candidate';
import { prepareSolanaPair } from './warmup-swap-quote';
import { collectPairRuntimePreview } from './pair-runtime-preview';
export type ImportedPairRuntimeRequest = ImportedPairOrderRequest & {
  inspectRuntime: true;
};
export type ImportedPairRuntimeDependencies = ImportedPairOrderDependencies & {
  programRpc?: (method: string, params: unknown[]) => Promise<unknown>;
};
export function importedPairRuntimeRequest(
  value: unknown,
): ImportedPairRuntimeRequest {
  if (
    !value ||
    typeof value !== 'object' ||
    (value as { inspectRuntime?: unknown }).inspectRuntime !== true
  )
    throw new ImportedPairQuoteError(
      'Explicit unsigned runtime inspection is required.',
      400,
    );
  const { inspectRuntime: _intent, ...rest } = value as Record<string, unknown>;
  return { ...importedPairOrderRequest(rest), inspectRuntime: true };
}
export async function previewOwnedImportedPairRuntime(
  db: D1Database,
  owner: string,
  value: ImportedPairRuntimeRequest,
  signal: AbortSignal,
  dependencies?: ImportedPairRuntimeDependencies,
) {
  const input = importedPairRuntimeRequest(value);
  signal = AbortSignal.any([signal, AbortSignal.timeout(45000)]);
  let abort = () => {};
  const run = async () => {
    signal.throwIfAborted();
    const read = () =>
      db
        .prepare(
          "SELECT p.chain,p.address,p.revision,p.archived,p.document,w.revision AS wallet_revision,w.archived AS wallet_archived,w.role,w.updated_at AS wallet_updated_at FROM imported_token_projects p JOIN workspace_wallets w ON w.owner_id=p.owner_id AND w.chain='Solana' AND w.address=? WHERE p.owner_id=? AND p.id=?",
        )
        .bind(input.wallet, owner, input.id)
        .first();
    const source = await read();
    signal.throwIfAborted();
    if (!source)
      throw new ImportedPairQuoteError(
        'Owned project or wallet not found.',
        404,
      );
    const quote = dependencies ?? configuredPairQuoteDependencies(signal);
    const provider: ImportedPairRuntimeDependencies = dependencies ?? {
      ...quote,
      prepare: (input, s) => prepareSolanaPair(input, env.JUPITER_API_KEY, s),
      programRpc: (method, params) =>
        balanceRpc(
          getSolanaIndexerRpcEndpoint(),
          method,
          params,
          signal,
          fetch,
          2097152,
        ),
    };
    const checked =
      (fn: typeof provider.rpc) =>
      async (method: string, params: unknown[]) => {
        signal.throwIfAborted();
        try {
          const result = await fn(method, params);
          signal.throwIfAborted();
          return result;
        } catch {
          if (signal.aborted) signal.throwIfAborted();
          throw new ImportedPairQuoteError(
            'Pair runtime provider reads are unavailable.',
            502,
          );
        }
      };
    const { inspectRuntime: _intent, ...orderRequest } = input;
    const candidate = await prepareOwnedImportedPairOrder(
      db,
      owner,
      orderRequest,
      signal,
      provider,
    );
    const preview = await collectPairRuntimePreview(
      candidate,
      checked(provider.rpc),
      checked(provider.programRpc ?? provider.rpc),
      signal,
      provider.now ?? Date.now,
    );
    signal.throwIfAborted();
    const current = await read();
    signal.throwIfAborted();
    if (JSON.stringify(current) !== JSON.stringify(source))
      throw new ImportedPairQuoteError(
        'Saved pair or wallet changed during runtime inspection.',
      );
    if ((provider.now ?? Date.now)() >= Date.parse(preview.runtime.expiresAt))
      throw new ImportedPairQuoteError(
        'Runtime preview expired before publication.',
      );
    return {
      format: 'imported-pair-runtime-preview-v1' as const,
      candidate: { ...candidate, review: preview.review },
      runtime: preview.runtime,
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
              'Pair runtime inspection was cancelled or timed out.',
              408,
            ),
          );
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      }),
    ]);
  } catch (error) {
    if (signal.aborted)
      throw new ImportedPairQuoteError(
        'Pair runtime inspection was cancelled or timed out.',
        408,
      );
    if (error instanceof ImportedPairQuoteError) throw error;
    throw new ImportedPairQuoteError(
      'Pair runtime identity, inner-call evidence, custody or lifetime did not pass review. No approval or signature was created.',
    );
  } finally {
    signal.removeEventListener('abort', abort);
  }
}
