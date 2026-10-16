import { env } from './server-env';
import { chainQuoteAssets } from './quote-catalog';
import { walletAddress } from './wallet-workspace';
import { UUID } from './wallet-operation';
import {
  pairUiBudget,
  pairUiAtoms,
  pairUiAmount,
  pairAmountLifetimeMs,
} from './pair-ui-amount';
import {
  balanceRpc,
  SOLANA_MAINNET_GENESIS,
  WalletRpcError,
} from './wallet-balances';
import {
  getSolanaIndexerRpcEndpoint,
  requireConsistentSolanaSlots,
} from './solana-rpc';
import {
  readPairMintEvidence,
  assertSamePairMintEvidence,
  PairMintPolicyError,
} from './pair-mint-evidence';
import { quoteSolanaPair, WarmupQuoteError } from './warmup-swap-quote';
import {
  importedPairSha256,
  parseImportedPairQuote,
  type ImportedTradePair,
  type ImportedPairQuote,
} from './imported-trade-pair';
export class ImportedPairQuoteError extends Error {
  constructor(
    message: string,
    readonly status = 409,
  ) {
    super(message);
  }
}
const pairQuoteScopes = new WeakMap<
  object,
  {
    db?: D1Database;
    owner?: string;
    input?: string;
    expires?: number;
    used: number;
  }
>();
/** Server-only capability for exactly two quotes in one order-first lifecycle. */
export function createPairOrderQuoteScope(): object {
  const scope = Object.freeze({});
  pairQuoteScopes.set(scope, { used: 0 });
  return scope;
}
/** Preserve the bounded API backoff signal without exposing provider details or retrying. */
export function importedPairProviderError(error: unknown, message: string) {
  return new ImportedPairQuoteError(
    message,
    error instanceof WalletRpcError && error.status === 429 ? 429 : 502,
  );
}
export type ImportedPairQuoteRequest = {
  id: string;
  revision: number;
  quoteMint: string;
  side: 'Buy' | 'Sell';
  amount: string;
};
export function importedPairQuoteRequest(
  value: unknown,
): ImportedPairQuoteRequest {
  const v = value as ImportedPairQuoteRequest;
  try {
    if (
      !v ||
      Object.keys(v).sort().join(',') !== 'amount,id,quoteMint,revision,side' ||
      !UUID.test(v.id) ||
      !Number.isSafeInteger(v.revision) ||
      v.revision < 1 ||
      v.revision > 1e9 ||
      !['Buy', 'Sell'].includes(v.side) ||
      typeof v.amount !== 'string' ||
      v.amount.length > 277 ||
      !/^\d{1,20}(?:\.\d{1,255})?$/.test(v.amount)
    )
      throw new Error();
    walletAddress(v.quoteMint, 'Solana');
  } catch {
    throw new ImportedPairQuoteError(
      'Choose the current token, exact quote asset and a positive plain decimal amount.',
      400,
    );
  }
  return {
    id: v.id,
    revision: v.revision,
    quoteMint: v.quoteMint,
    side: v.side,
    amount: v.amount,
  };
}
type Row = {
  chain: string;
  address: string;
  revision: number;
  archived: number;
  document: string;
};
type Quote = Awaited<ReturnType<typeof quoteSolanaPair>>;
export type ImportedPairQuoteDependencies = {
  quoteScope?: object;
  rpc: (method: string, params: unknown[]) => Promise<unknown>;
  quote: (
    input: Parameters<typeof quoteSolanaPair>[0],
    signal: AbortSignal,
  ) => Promise<Quote>;
  now?: () => number;
};
export function configuredPairQuoteDependencies(
  signal: AbortSignal,
): ImportedPairQuoteDependencies {
  const key = (env as unknown as Record<string, unknown>).JUPITER_API_KEY;
  if (
    typeof key !== 'string' ||
    !key.trim() ||
    key.length > 1000 ||
    /\s/.test(key)
  )
    throw new ImportedPairQuoteError(
      'Swap quote service is not configured.',
      503,
    );
  const endpoint = getSolanaIndexerRpcEndpoint();
  return {
    rpc: (method, params) =>
      balanceRpc(endpoint, method, params, signal, fetch),
    quote: (input, signal) => quoteSolanaPair(input, key, signal),
  };
}
/** Quote observation only. It never reads a wallet balance or retains a preparation/approval. */
export async function quoteOwnedImportedPair(
  db: D1Database,
  owner: string,
  input: ImportedPairQuoteRequest,
  signal: AbortSignal,
  dependencies?: ImportedPairQuoteDependencies,
): Promise<ImportedPairQuote> {
  input = importedPairQuoteRequest(input);
  signal = AbortSignal.any([signal, AbortSignal.timeout(25000)]);
  const run = async () => {
    signal.throwIfAborted();
    const read = () =>
      db
        .prepare(
          'SELECT chain,address,revision,archived,document FROM imported_token_projects WHERE owner_id=? AND id=?',
        )
        .bind(owner, input.id)
        .first<Row>();
    const saved = await read();
    signal.throwIfAborted();
    if (!saved)
      throw new ImportedPairQuoteError('Imported project not found.', 404);
    if (saved.archived || saved.revision !== input.revision)
      throw new ImportedPairQuoteError(
        'Project changed or is archived. Reload its details.',
      );
    if (saved.chain !== 'Solana')
      throw new ImportedPairQuoteError(
        'Pair quotes currently support Solana.',
        400,
      );
    const token = JSON.parse(saved.document).token as {
      chain: string;
      address: string;
      symbol: string;
      decimals: number;
      tokenProgram?: string;
    };
    if (
      token.chain !== 'Solana' ||
      token.address !== saved.address ||
      typeof token.symbol !== 'string' ||
      !token.symbol.trim() ||
      token.symbol.length > 64 ||
      !Number.isInteger(token.decimals) ||
      token.decimals < 0 ||
      token.decimals > 18
    )
      throw new ImportedPairQuoteError(
        'Refresh the saved token identity before quoting this pair.',
      );
    walletAddress(saved.address, 'Solana');
    const quoteAsset = chainQuoteAssets('Solana').find(
      (a) => a.address === input.quoteMint,
    );
    if (
      !quoteAsset ||
      quoteAsset.address === saved.address ||
      !Number.isInteger(quoteAsset.decimals) ||
      quoteAsset.decimals < 0 ||
      quoteAsset.decimals > 18
    )
      throw new ImportedPairQuoteError(
        'Choose a distinct exact quote asset from the supported catalog.',
        400,
      );
    try {
      pairUiBudget(
        input.amount,
        input.side === 'Buy' ? quoteAsset.decimals : token.decimals,
      );
    } catch {
      throw new ImportedPairQuoteError(
        'Use a positive amount within the selected input asset decimals and Solana limits.',
        400,
      );
    }
    const provider = dependencies ?? configuredPairQuoteDependencies(signal),
      now = provider.now ?? Date.now,
      start = now();
    const quoteReadScope = provider.quoteScope
      ? pairQuoteScopes.get(provider.quoteScope)
      : undefined;
    if (
      provider.quoteScope &&
      (!quoteReadScope ||
        quoteReadScope.used > 1 ||
        (quoteReadScope.used === 1 &&
          (quoteReadScope.db !== db ||
            quoteReadScope.owner !== owner ||
            quoteReadScope.input !== JSON.stringify(input) ||
            start >= quoteReadScope.expires!)))
    )
      throw new ImportedPairQuoteError(
        'Order quote continuation expired, changed or was already consumed.',
      );
    const continuation = quoteReadScope?.used === 1;
    if (quoteReadScope) quoteReadScope.used++;
    const gate = continuation
      ? null
      : await db
          .prepare(
            'INSERT INTO imported_token_project_gates(owner_id,next_allowed_at) VALUES (?,?) ON CONFLICT(owner_id) DO UPDATE SET next_allowed_at=excluded.next_allowed_at WHERE imported_token_project_gates.next_allowed_at<=?',
          )
          .bind(owner, start + 15000, start)
          .run();
    signal.throwIfAborted();
    if (gate && !gate.meta.changes)
      throw new ImportedPairQuoteError(
        'Wait 15 seconds between imported-token quote reads.',
        429,
      );
    if (quoteReadScope && !continuation)
      Object.assign(quoteReadScope, {
        db,
        owner,
        input: JSON.stringify(input),
        expires: start + 25000,
      });
    const checked = async (method: string, params: unknown[]) => {
      signal.throwIfAborted();
      let result: unknown;
      try {
        result = await provider.rpc(method, params);
      } catch (error) {
        signal.throwIfAborted();
        throw importedPairProviderError(
          error,
          'Pair quote provider reads are unavailable.',
        );
      }
      signal.throwIfAborted();
      return result;
    };
    if ((await checked('getGenesisHash', [])) !== SOLANA_MAINNET_GENESIS)
      throw new ImportedPairQuoteError(
        'Quote identity provider is on the wrong network.',
        502,
      );
    const rawSlot = await checked('getSlot', [{ commitment: 'confirmed' }]);
    if (
      typeof rawSlot !== 'string' ||
      !/^[1-9]\d{0,15}$/.test(rawSlot) ||
      !Number.isSafeInteger(Number(rawSlot))
    )
      throw new ImportedPairQuoteError(
        'Quote identity context is unavailable.',
        502,
      );
    const scope = { inputMint: saved.address, outputMint: quoteAsset.address };
    const readMints = async (slot: number) => {
      try {
        return await readPairMintEvidence(scope, slot, checked, now());
      } catch (error) {
        if (error instanceof PairMintPolicyError)
          throw new ImportedPairQuoteError(
            error.message + ' No trading approval was created.',
          );
        throw error;
      }
    };
    const before = await readMints(Number(rawSlot));
    signal.throwIfAborted();
    if (
      before.mints[0].decimals !== token.decimals ||
      (token.tokenProgram !== undefined &&
        token.tokenProgram !== before.mints[0].program) ||
      before.mints[1].decimals !== quoteAsset.decimals
    )
      throw new ImportedPairQuoteError(
        'Saved token or quote-asset precision/program differs from the current chain identity.',
      );
    let amountRaw: string;
    try {
      const source = before.mints[input.side === 'Buy' ? 1 : 0];
      amountRaw = pairUiAtoms(
        input.amount,
        source.decimals,
        source.amountPolicy,
        before.unixTimestamp,
      ).toString();
    } catch {
      throw new ImportedPairQuoteError(
        'The UI amount cannot be converted conservatively within the selected mint precision and Solana raw-unit limits.',
        400,
      );
    }
    let quote: Quote;
    try {
      quote = await provider.quote(
        {
          baseMint: saved.address,
          quoteMint: quoteAsset.address,
          side: input.side,
          amountRaw,
        },
        signal,
      );
    } catch (error) {
      if (error instanceof WarmupQuoteError && error.code === 'QUOTE_EXPIRED')
        throw new ImportedPairQuoteError(
          'Pair quote expired. Request a fresh quote.',
        );
      throw error;
    }
    signal.throwIfAborted();
    const [after, finalGenesis] = await Promise.all([
      readMints(before.slot),
      checked('getGenesisHash', []),
    ]);
    try {
      assertSamePairMintEvidence(before, after);
    } catch {
      throw new ImportedPairQuoteError(
        'Token or quote-asset policy or active UI multiplier changed during the quote. Request a fresh observation.',
      );
    }
    requireConsistentSolanaSlots([Number(rawSlot), before.slot, after.slot]);
    if (finalGenesis !== SOLANA_MAINNET_GENESIS)
      throw new ImportedPairQuoteError('Quote identity network changed.', 502);
    const current = await read();
    signal.throwIfAborted();
    if (!current || JSON.stringify(current) !== JSON.stringify(saved))
      throw new ImportedPairQuoteError(
        'Project changed during the quote. Reload before continuing.',
      );
    const providerExpiry = Date.parse(quote.expiresAt);
    if (!Number.isFinite(providerExpiry))
      throw new ImportedPairQuoteError('Quote lifetime is unavailable.', 502);
    const pairLifetime = pairAmountLifetimeMs(
      before.mints.map((m) => m.amountPolicy),
      after.unixTimestamp,
      start,
    );
    const fresh = () => {
      const timestamp = now();
      if (
        !Number.isFinite(timestamp) ||
        timestamp >= start + pairLifetime ||
        timestamp < start - 1000 ||
        providerExpiry <= timestamp
      )
        throw new ImportedPairQuoteError(
          'Pair quote expired or the observation clock changed. Request a fresh quote.',
        );
      return timestamp;
    };
    fresh();
    const documentHash = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(saved.document),
    );
    const context: Omit<ImportedTradePair, 'sha256'> = {
      format: 'imported-trade-pair-v2',
      projectId: input.id,
      projectRevision: input.revision,
      projectDocumentSha256: Array.from(new Uint8Array(documentHash), (b) =>
        b.toString(16).padStart(2, '0'),
      ).join(''),
      chain: 'Solana',
      network: 'mainnet',
      base: {
        address: saved.address,
        symbol: token.symbol,
        decimals: token.decimals,
        program: before.mints[0].program,
        amountPolicy: before.mints[0].amountPolicy,
        extensions: before.mints[0].extensions,
        issuerControls: before.mints[0].issuerControls,
      },
      quote: {
        address: quoteAsset.address,
        symbol: quoteAsset.symbol,
        decimals: quoteAsset.decimals,
        program: before.mints[1].program,
        amountPolicy: before.mints[1].amountPolicy,
        extensions: before.mints[1].extensions,
        issuerControls: before.mints[1].issuerControls,
      },
      catalogSnapshot: '2026-10-09',
      issuerVerified: false,
      mintPolicy: {
        slot: before.slot,
        recheckSlot: after.slot,
        baseSha256: before.mints[0].policySha256,
        quoteSha256: before.mints[1].policySha256,
        unixTimestamp: before.unixTimestamp,
        recheckUnixTimestamp: after.unixTimestamp,
      },
      observedAt: new Date(start).toISOString(),
      expiresAt: new Date(start + pairLifetime).toISOString(),
    };
    const pair = { ...context, sha256: await importedPairSha256(context) };
    const boundedQuote = {
      ...quote,
      expiresAt: new Date(
        Math.min(Date.parse(quote.expiresAt), Date.parse(pair.expiresAt)),
      ).toISOString(),
    };
    const result = await parseImportedPairQuote(
      {
        format: 'imported-pair-quote-v2',
        pair,
        side: input.side,
        inputRaw: amountRaw,
        requestedInputAmount: input.amount,
        inputRounding: 'conservative-down-v1',
        inputAmount: pairUiAmount(
          amountRaw,
          input.side === 'Buy' ? pair.quote.decimals : pair.base.decimals,
          input.side === 'Buy'
            ? pair.quote.amountPolicy
            : pair.base.amountPolicy,
          after.unixTimestamp,
        ),
        outputAmount: pairUiAmount(
          quote.outAmount,
          input.side === 'Buy' ? pair.base.decimals : pair.quote.decimals,
          input.side === 'Buy'
            ? pair.base.amountPolicy
            : pair.quote.amountPolicy,
          after.unixTimestamp,
        ),
        minimumOutputAmount: pairUiAmount(
          quote.minimumOutAmount,
          input.side === 'Buy' ? pair.base.decimals : pair.quote.decimals,
          input.side === 'Buy'
            ? pair.base.amountPolicy
            : pair.quote.amountPolicy,
          after.unixTimestamp,
        ),
        quote: boundedQuote,
        signingAllowed: false,
        executionAllowed: false,
        balancesChecked: false,
      },
      {
        projectId: input.id,
        projectRevision: input.revision,
        baseMint: saved.address,
        baseDecimals: token.decimals,
        baseSymbol: token.symbol,
        quoteMint: quoteAsset.address,
        quoteDecimals: quoteAsset.decimals,
        quoteSymbol: quoteAsset.symbol,
        side: input.side,
        amount: input.amount,
      },
      fresh(),
    );
    signal.throwIfAborted();
    fresh();
    return result;
  };
  let abort: () => void = () => {};
  try {
    return await Promise.race([
      run(),
      new Promise<never>((_resolve, reject) => {
        abort = () =>
          reject(
            new ImportedPairQuoteError(
              'Pair quote timed out or was cancelled. Request a fresh quote.',
              408,
            ),
          );
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      }),
    ]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
}
