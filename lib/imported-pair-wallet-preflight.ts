import {
  ImportedPairQuoteError,
  importedPairProviderError,
  importedPairQuoteRequest,
  quoteOwnedImportedPair,
  configuredPairQuoteDependencies,
  type ImportedPairQuoteDependencies,
  type ImportedPairQuoteRequest,
} from './imported-pair-quote-service';
import { walletAddress } from './wallet-workspace';
import { parseImportedPairQuote } from './imported-trade-pair';
import {
  PairMintPolicyError,
  type PairMintEvidence,
} from './pair-mint-evidence';
import {
  readPairWalletEvidence,
  assertStablePairWalletEvidence,
  assessPairWalletFunding,
  pairWalletUint,
} from './pair-wallet-evidence';
import { SOLANA_MAINNET_GENESIS } from './wallet-balances';
import { requireConsistentSolanaSlots } from './solana-rpc';
export type ImportedPairWalletRequest = ImportedPairQuoteRequest & {
  wallet: string;
  walletRevision: number;
  feeAndRentLimitRaw: string;
};
export function importedPairWalletRequest(
  value: unknown,
): ImportedPairWalletRequest {
  const v = value as ImportedPairWalletRequest;
  try {
    if (
      !v ||
      Object.keys(v).sort().join(',') !==
        'amount,feeAndRentLimitRaw,id,quoteMint,revision,side,wallet,walletRevision' ||
      !Number.isSafeInteger(v.walletRevision) ||
      v.walletRevision < 1 ||
      v.walletRevision > 1e9 ||
      pairWalletUint(v.feeAndRentLimitRaw) < 1n
    )
      throw Error();
    const request = importedPairQuoteRequest({
      id: v.id,
      revision: v.revision,
      quoteMint: v.quoteMint,
      side: v.side,
      amount: v.amount,
    });
    return {
      ...request,
      wallet: walletAddress(v.wallet, 'Solana'),
      walletRevision: v.walletRevision,
      feeAndRentLimitRaw: v.feeAndRentLimitRaw,
    };
  } catch {
    throw new ImportedPairQuoteError(
      'Choose the current pair and saved wallet revision with an exact positive fee and rent allowance.',
      400,
    );
  }
}
export type ImportedPairWalletPreflight = Awaited<
  ReturnType<typeof preflightOwnedImportedPairWallet>
>;
/** Fresh owned quote and selected-account funding review; no order, signature, reservation or send. */
export async function preflightOwnedImportedPairWallet(
  db: D1Database,
  owner: string,
  value: ImportedPairWalletRequest,
  signal: AbortSignal,
  dependencies?: ImportedPairQuoteDependencies,
) {
  const input = importedPairWalletRequest(value);
  signal = AbortSignal.any([signal, AbortSignal.timeout(30000)]);
  let abort: () => void = () => {};
  const run = async () => {
    signal.throwIfAborted();
    const readWallet = () =>
      db
        .prepare(
          "SELECT revision,archived,role,updated_at FROM workspace_wallets WHERE owner_id=? AND chain='Solana' AND address=?",
        )
        .bind(owner, input.wallet)
        .first<{
          revision: number;
          archived: number;
          role: string;
          updated_at: string;
        }>();
    const wallet = await readWallet();
    signal.throwIfAborted();
    if (!wallet)
      throw new ImportedPairQuoteError('Saved wallet not found.', 404);
    if (
      wallet.archived ||
      wallet.revision !== input.walletRevision ||
      !['Recipient', 'Deployer', 'Funder'].includes(wallet.role)
    )
      throw new ImportedPairQuoteError(
        'Saved wallet changed or is archived. Reload its details.',
      );
    const provider = dependencies ?? configuredPairQuoteDependencies(signal),
      now = provider.now ?? Date.now;
    const checked = async (method: string, params: unknown[]) => {
      signal.throwIfAborted();
      let result: unknown;
      try {
        result = await provider.rpc(method, params);
      } catch (error) {
        signal.throwIfAborted();
        throw importedPairProviderError(
          error,
          'Pair wallet provider reads are unavailable.',
        );
      }
      signal.throwIfAborted();
      return result;
    };
    const quote = await quoteOwnedImportedPair(
      db,
      owner,
      {
        id: input.id,
        revision: input.revision,
        quoteMint: input.quoteMint,
        side: input.side,
        amount: input.amount,
      },
      signal,
      provider,
    );
    const pair = quote.pair;
    const quoted: PairMintEvidence = {
      slot: pair.mintPolicy.recheckSlot,
      unixTimestamp: pair.mintPolicy.recheckUnixTimestamp,
      mints: [pair.base, pair.quote].map((a, i) => ({
        address: a.address,
        program: a.program,
        decimals: a.decimals,
        amountPolicy: a.amountPolicy,
        extensions: a.extensions,
        issuerControls: a.issuerControls,
        policySha256:
          i === 0 ? pair.mintPolicy.baseSha256 : pair.mintPolicy.quoteSha256,
      })),
    };
    const before = await readPairWalletEvidence(
      quoted,
      input.wallet,
      checked,
      now(),
    );
    const after = await readPairWalletEvidence(
      { ...quoted, slot: before.slot, unixTimestamp: before.unixTimestamp },
      input.wallet,
      checked,
      now(),
    );
    assertStablePairWalletEvidence(before, after);
    requireConsistentSolanaSlots([
      quoted.slot,
      pair.mintPolicy.slot,
      before.slot,
      after.slot,
    ]);
    if ((await checked('getGenesisHash', [])) !== SOLANA_MAINNET_GENESIS)
      throw new ImportedPairQuoteError(
        'Pair wallet provider network changed.',
        502,
      );
    const currentWallet = await readWallet();
    signal.throwIfAborted();
    const project = await db
      .prepare(
        'SELECT chain,address,revision,archived,document FROM imported_token_projects WHERE owner_id=? AND id=?',
      )
      .bind(owner, input.id)
      .first<{
        chain: string;
        address: string;
        revision: number;
        archived: number;
        document: string;
      }>();
    signal.throwIfAborted();
    if (
      JSON.stringify(wallet) !== JSON.stringify(currentWallet) ||
      !project ||
      project.chain !== 'Solana' ||
      project.address !== pair.base.address ||
      project.archived ||
      project.revision !== pair.projectRevision
    )
      throw new ImportedPairQuoteError(
        'Project or wallet changed during funding review. Reload before continuing.',
      );
    const sha = async (v: string) =>
      Array.from(
        new Uint8Array(
          await crypto.subtle.digest('SHA-256', new TextEncoder().encode(v)),
        ),
        (b) => b.toString(16).padStart(2, '0'),
      ).join('');
    if ((await sha(project.document)) !== pair.projectDocumentSha256)
      throw new ImportedPairQuoteError(
        'Project document changed during funding review.',
      );
    const funding = assessPairWalletFunding(
      quote,
      after,
      input.feeAndRentLimitRaw,
    );
    const observedAt = new Date(now()).toISOString(),
      expiresAt = new Date(
        Math.min(Date.parse(pair.expiresAt), Date.parse(quote.quote.expiresAt)),
      ).toISOString();
    const result = {
      format: 'imported-pair-wallet-preflight-v1' as const,
      quote,
      wallet: input.wallet,
      walletRevision: input.walletRevision,
      evidence: after,
      sourceRecheckSlot: after.slot,
      funding,
      observedAt,
      expiresAt,
      transactionPrepared: false as const,
      signingAllowed: false as const,
      executionAllowed: false as const,
    };
    const contextSha256 = await sha(JSON.stringify(result));
    try {
      await parseImportedPairQuote(
        quote,
        {
          projectId: pair.projectId,
          projectRevision: pair.projectRevision,
          baseMint: pair.base.address,
          baseDecimals: pair.base.decimals,
          baseSymbol: pair.base.symbol,
          quoteMint: pair.quote.address,
          quoteDecimals: pair.quote.decimals,
          quoteSymbol: pair.quote.symbol,
          side: quote.side,
          amount: quote.requestedInputAmount,
        },
        now(),
      );
    } catch {
      throw new ImportedPairQuoteError(
        'Pair quote expired or changed during wallet funding review. Request a fresh preflight.',
      );
    }
    signal.throwIfAborted();
    return { ...result, contextSha256 };
  };
  try {
    return await Promise.race([
      run(),
      new Promise<never>((_resolve, reject) => {
        abort = () =>
          reject(
            new ImportedPairQuoteError(
              'Pair wallet preflight timed out or was cancelled.',
              408,
            ),
          );
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      }),
    ]);
  } catch (error) {
    if (error instanceof PairMintPolicyError)
      throw new ImportedPairQuoteError(error.message);
    throw error;
  } finally {
    signal.removeEventListener('abort', abort);
  }
}
