import { env } from './server-env';
import { chainQuoteAssets } from './quote-catalog';
import { walletAddress } from './wallet-workspace';
import { UUID } from './wallet-operation';
import { solanaTokenAtoms } from './solana-token-amount';
import { formatNativeBalance } from './wallet-balance-format';
import { balanceRpc, SOLANA_MAINNET_GENESIS } from './wallet-balances';
import {
  getSolanaIndexerRpcEndpoint,
  requireConsistentSolanaSlots,
} from './solana-rpc';
import {
  readSwapMintEvidence,
  assertSameSwapMintEvidence,
  SwapMintIdentityError,
} from './swap-token-program-evidence';
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
  rpc: (method: string, params: unknown[]) => Promise<unknown>;
  quote: (
    input: Parameters<typeof quoteSolanaPair>[0],
    signal: AbortSignal,
  ) => Promise<Quote>;
  now?: () => number;
};
function configured(signal: AbortSignal): ImportedPairQuoteDependencies {
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
    let amountRaw: string;
    try {
      amountRaw = solanaTokenAtoms(
        input.amount,
        input.side === 'Buy' ? quoteAsset.decimals : token.decimals,
      ).toString();
    } catch {
      throw new ImportedPairQuoteError(
        'Use a positive amount within the selected input asset decimals and Solana limits.',
        400,
      );
    }
    const provider = dependencies ?? configured(signal),
      now = provider.now ?? Date.now,
      start = now();
    const gate = await db
      .prepare(
        'INSERT INTO imported_token_project_gates(owner_id,next_allowed_at) VALUES (?,?) ON CONFLICT(owner_id) DO UPDATE SET next_allowed_at=excluded.next_allowed_at WHERE imported_token_project_gates.next_allowed_at<=?',
      )
      .bind(owner, start + 15000, start)
      .run();
    signal.throwIfAborted();
    if (!gate.meta.changes)
      throw new ImportedPairQuoteError(
        'Wait 15 seconds between imported-token quote reads.',
        429,
      );
    const checked = async (method: string, params: unknown[]) => {
      signal.throwIfAborted();
      const result = await provider.rpc(method, params);
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
        return await readSwapMintEvidence(scope, slot, checked);
      } catch (error) {
        if (error instanceof SwapMintIdentityError)
          throw new ImportedPairQuoteError(
            'This pair has an unsupported or invalid mint policy. Stock-token scaled amounts and compliance extensions require a separate adapter. No trading approval was created.',
          );
        throw error;
      }
    };
    const before = await readMints(Number(rawSlot));
    if (
      before.mints[0].decimals !== token.decimals ||
      (token.tokenProgram !== undefined &&
        token.tokenProgram !== before.mints[0].program) ||
      before.mints[1].decimals !== quoteAsset.decimals
    )
      throw new ImportedPairQuoteError(
        'Saved token or quote-asset precision/program differs from the current chain identity.',
      );
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
    const after = await readMints(before.slot);
    try {
      assertSameSwapMintEvidence(before, after);
    } catch {
      throw new ImportedPairQuoteError(
        'Token or quote-asset transfer policy changed during the quote. Request a fresh observation.',
      );
    }
    requireConsistentSolanaSlots([Number(rawSlot), before.slot, after.slot]);
    if ((await checked('getGenesisHash', [])) !== SOLANA_MAINNET_GENESIS)
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
    const fresh = () => {
      const timestamp = now();
      if (
        !Number.isFinite(timestamp) ||
        timestamp >= start + 30000 ||
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
      format: 'imported-trade-pair-v1',
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
      },
      quote: {
        address: quoteAsset.address,
        symbol: quoteAsset.symbol,
        decimals: quoteAsset.decimals,
        program: before.mints[1].program,
      },
      catalogSnapshot: '2026-10-09',
      issuerVerified: false,
      mintPolicy: {
        slot: before.slot,
        recheckSlot: after.slot,
        baseSha256: before.mints[0].policySha256,
        quoteSha256: before.mints[1].policySha256,
      },
      observedAt: new Date(start).toISOString(),
      expiresAt: new Date(start + 30000).toISOString(),
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
        format: 'imported-pair-quote-v1',
        pair,
        side: input.side,
        inputRaw: amountRaw,
        inputAmount: formatNativeBalance(
          amountRaw,
          input.side === 'Buy' ? pair.quote.decimals : pair.base.decimals,
        ),
        outputAmount: formatNativeBalance(
          quote.outAmount,
          input.side === 'Buy' ? pair.base.decimals : pair.quote.decimals,
        ),
        minimumOutputAmount: formatNativeBalance(
          quote.minimumOutAmount,
          input.side === 'Buy' ? pair.base.decimals : pair.quote.decimals,
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
