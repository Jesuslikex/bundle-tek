import {
  address,
  getBase64Decoder,
  getTransactionDecoder,
  getTransactionEncoder,
  isOffCurveAddress,
} from '@solana/kit';
import { findAssociatedTokenPda } from '@solana-program/token';
import bs58 from 'bs58';
import { validateProjectDocument } from './workspace-project';
import { quoteCatalog, validateQuoteSelection } from './quote-catalog';
import { artworkIdValid } from './artwork';
import { verifySolanaSignature } from './solana-signature';
import { getSolanaRpcEndpoint, rpcCall } from './solana-rpc';
import {
  DBC_PROGRAM,
  DBC_QUOTES,
  TOKEN_PROGRAM,
  WRAPPED_SOL,
  buildMeteoraDbcMessage,
  parseDbcConfig,
  type MeteoraDbcInput,
} from './meteora-dbc-launch';

export const METEORA_DBC_VENUE = 'Meteora DBC';
export class MeteoraDbcError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
export type MeteoraDbcTerms = {
  projectId: string;
  updatedAt: string;
  releaseId: string;
  origin: string;
  payer: string;
  payerRevision: number;
  mint: string;
  /** Existing DBC config key the pool is created from. */
  config: string;
  /** Raw quote units for the creator buy, "0" for create only. */
  devBuyRaw: string;
  /** Upper bound on SOL for fees, rent and the config's pool creation fee, in lamports. */
  solLimitLamports: string;
};
export type MeteoraDbcRpc = (
  method: string,
  params: unknown[],
  signal: AbortSignal,
) => Promise<unknown>;
export type MeteoraDbcDeps = { rpc?: MeteoraDbcRpc; now?: () => number };

const defaultRpc: MeteoraDbcRpc = (method, params) =>
  rpcCall(getSolanaRpcEndpoint('mainnet'), method, params);
/** A blockhash lives ~60-90s; the review expires well before. */
export const METEORA_DBC_REVIEW_MS = 45_000;
/** Configs may charge a pool creation fee, so the limit allows up to 5 SOL. */
export const METEORA_DBC_MAX_SOL_LIMIT = 5_000_000_000n;

type Row = { document: string; updated_at: string; archived: number };

/** Owner, saved Meteora DBC plan, released metadata and verified payer, from the database only. */
async function ownedSelection(
  db: D1Database,
  owner: string,
  t: MeteoraDbcTerms,
) {
  let origin: URL;
  try {
    origin = new URL(t.origin);
  } catch {
    throw new MeteoraDbcError('Review the launch on this site.', 400);
  }
  if (
    !artworkIdValid(t.releaseId) ||
    origin.protocol !== 'https:' ||
    origin.origin !== t.origin ||
    !Number.isSafeInteger(t.payerRevision) ||
    t.payerRevision < 1
  )
    throw new MeteoraDbcError(
      'Review a saved project, payer and public metadata release.',
      400,
    );
  const read = () =>
    db
      .prepare(
        `SELECT p.document,p.updated_at,p.archived FROM workspace_projects p
    JOIN launch_metadata_releases m ON m.owner_id=p.owner_id AND m.project_id=p.id AND m.id=?
    JOIN workspace_wallets w ON w.owner_id=p.owner_id AND w.chain='Solana' AND w.address=? AND w.revision=? AND w.archived=0
    WHERE p.owner_id=? AND p.id=? AND EXISTS(SELECT 1 FROM wallet_ownership_proofs o WHERE o.owner_id=w.owner_id AND o.chain='Solana' AND o.address=w.address)`,
      )
      .bind(t.releaseId, t.payer, t.payerRevision, owner, t.projectId)
      .first<Row>();
  const check = (row: Row | null) => {
    if (!row)
      throw new MeteoraDbcError(
        'Owned project, released metadata or verified payer is unavailable.',
        404,
      );
    if (row.archived || row.updated_at !== t.updatedAt)
      throw new MeteoraDbcError(
        'Reload and review the current active project.',
        409,
      );
    const doc = validateProjectDocument(JSON.parse(row.document)),
      deployer = doc.options.wallets?.deployer;
    if (doc.plan.chain !== 'Solana' || doc.plan.launchpad !== METEORA_DBC_VENUE)
      throw new MeteoraDbcError('Save a Meteora DBC launch first.', 400);
    if (
      !deployer ||
      doc.options.wallets?.chain !== 'Solana' ||
      deployer.address !== t.payer ||
      deployer.revision !== t.payerRevision
    )
      throw new MeteoraDbcError(
        'Save this exact verified payer as the launch deployer.',
        409,
      );
    validateQuoteSelection(doc.plan);
    const quotes = quoteCatalog('Solana', METEORA_DBC_VENUE).assets.filter(
      (q) =>
        q.symbol === doc.plan.currency &&
        (!doc.plan.quoteAddress || q.address === doc.plan.quoteAddress),
    );
    if (
      quotes.length !== 1 ||
      DBC_QUOTES[quotes[0].address]?.decimals !== quotes[0].decimals
    )
      throw new MeteoraDbcError(
        'Select SOL or USDC as the Meteora DBC quote token.',
        409,
      );
    return { row, doc, quote: quotes[0] };
  };
  const original = check(await read());
  return {
    original,
    identity: {
      name: original.doc.plan.tokenName,
      symbol: original.doc.plan.ticker,
      uri: `${t.origin}/api/launch/metadata/${t.releaseId}`,
    },
    async assertUnchanged() {
      const latest = await read();
      if (!latest || JSON.stringify(latest) !== JSON.stringify(original.row))
        throw new MeteoraDbcError(
          'The project or payer changed during review. Review again.',
          409,
        );
      check(latest);
    },
  };
}

type AccountInfo = {
  data: [string, 'base64'];
  owner: string;
  lamports: number;
} | null;
const b64 = (v: string) => Uint8Array.from(Buffer.from(v, 'base64'));
function tokenAmount(account: AccountInfo, mint: string, owner: string) {
  if (!account) return 0n;
  const data = b64(account.data[0]);
  if (data.length < 72) throw new Error('Token account differs.');
  if (
    bs58.encode(data.slice(0, 32)) !== mint ||
    bs58.encode(data.slice(32, 64)) !== owner
  )
    throw new Error('Token account identity differs.');
  return new DataView(data.buffer, data.byteOffset).getBigUint64(64, true);
}
function mintSupply(account: AccountInfo) {
  if (!account) return 0n;
  const data = b64(account.data[0]);
  if (data.length < 82) throw new Error('Mint account differs.');
  return new DataView(data.buffer, data.byteOffset).getBigUint64(36, true);
}

async function readChain(
  rpc: MeteoraDbcRpc,
  t: MeteoraDbcTerms,
  quoteMint: string,
  signal: AbortSignal,
) {
  const [quoteAta] = await findAssociatedTokenPda({
    mint: address(quoteMint),
    owner: address(t.payer),
    tokenProgram: address(TOKEN_PROGRAM),
  });
  const [multi, balance, latest] = await Promise.all([
    rpc(
      'getMultipleAccounts',
      [
        [t.config, quoteMint, t.mint, quoteAta],
        { encoding: 'base64', commitment: 'confirmed' },
      ],
      signal,
    ) as Promise<{ context: { slot: number }; value: AccountInfo[] }>,
    rpc(
      'getBalance',
      [t.payer, { commitment: 'confirmed' }],
      signal,
    ) as Promise<{ value: number }>,
    rpc(
      'getLatestBlockhash',
      [{ commitment: 'confirmed' }],
      signal,
    ) as Promise<{
      value: { blockhash: string; lastValidBlockHeight: number };
    }>,
  ]);
  const [configAccount, quoteAccount, mint, payerQuote] = multi.value;
  if (!configAccount || configAccount.owner !== DBC_PROGRAM)
    throw new MeteoraDbcError(
      'No Meteora DBC config exists at this address.',
      409,
    );
  let config;
  try {
    config = parseDbcConfig(b64(configAccount.data[0]));
  } catch (error) {
    throw new MeteoraDbcError(
      error instanceof Error ? error.message : 'DBC config differs.',
      409,
    );
  }
  if (config.quoteMint !== quoteMint)
    throw new MeteoraDbcError(
      `This DBC config pairs with ${DBC_QUOTES[config.quoteMint]?.symbol ?? config.quoteMint}, not the saved quote token.`,
      409,
    );
  if (!quoteAccount || quoteAccount.owner !== TOKEN_PROGRAM)
    throw new MeteoraDbcError('Quote mint differs.', 409);
  const qm = b64(quoteAccount.data[0]);
  if (qm.length < 82 || qm[44] !== DBC_QUOTES[quoteMint].decimals)
    throw new MeteoraDbcError('Quote precision differs.', 409);
  if (mint)
    throw new MeteoraDbcError(
      'This mint already exists on-chain. It may already be launched; check it before using a new mint.',
      409,
    );
  return {
    slot: multi.context.slot,
    config,
    quoteBalanceRaw:
      quoteMint === WRAPPED_SOL
        ? BigInt(balance.value)
        : tokenAmount(payerQuote, quoteMint, t.payer),
    solLamports: BigInt(balance.value),
    blockhash: latest.value.blockhash,
    lastValidBlockHeight: String(latest.value.lastValidBlockHeight),
  };
}

type Simulation = {
  context: { slot: number };
  value: {
    err: unknown;
    unitsConsumed?: number;
    logs?: string[];
    accounts?: AccountInfo[];
  };
};
async function simulate(
  rpc: MeteoraDbcRpc,
  transaction: string,
  watch: string[],
  minContextSlot: number,
  signal: AbortSignal,
  sigVerify = false,
) {
  const result = (await rpc(
    'simulateTransaction',
    [
      transaction,
      {
        encoding: 'base64',
        commitment: 'confirmed',
        sigVerify,
        replaceRecentBlockhash: false,
        minContextSlot,
        accounts: { encoding: 'base64', addresses: watch },
      },
    ],
    signal,
  )) as Simulation;
  if (result.value.err) {
    const log = (result.value.logs ?? [])
      .filter((l) => /Error|failed|insufficient/i.test(l))
      .slice(-2)
      .join(' ')
      .slice(0, 300);
    throw new MeteoraDbcError(
      `Simulation rejected the launch.${log ? ' ' + log : ''}`,
      409,
    );
  }
  return result;
}

export type MeteoraDbcReview = {
  format: 'meteora-dbc-launch-review-v1';
  terms: Omit<MeteoraDbcTerms, 'origin'>;
  input: MeteoraDbcInput;
  transaction: string;
  sha256: string;
  expiresAt: string;
  summary: {
    config: string;
    feeClaimer: string;
    pool: string;
    quoteSymbol: string;
    quoteDecimals: number;
    baseDecimals: number;
    tokenStandard: 'SPL' | 'Token-2022';
    migrationThresholdRaw: string;
    creatorTradingFeePercent: number;
    poolCreationFeeLamports: string;
    supplyRaw: string;
    devBuyRaw: string;
    tokensOutRaw: string;
    devSupplyBps: number;
    solCostLamports: string;
    solLimitLamports: string;
    unitsConsumed: number | null;
  };
};

/** Unsigned, simulated review. Grants nothing: the browser rebuilds it and the user signs it. */
export async function prepareMeteoraDbcLaunch(
  db: D1Database,
  owner: string,
  t: MeteoraDbcTerms,
  signal: AbortSignal,
  deps: MeteoraDbcDeps = {},
): Promise<MeteoraDbcReview> {
  const rpc = deps.rpc ?? defaultRpc,
    now = deps.now ?? Date.now;
  if (
    isOffCurveAddress(address(t.payer)) ||
    isOffCurveAddress(address(t.mint)) ||
    t.payer === t.mint
  )
    throw new MeteoraDbcError(
      'Payer and mint must be distinct wallet keys.',
      400,
    );
  const solLimit = BigInt(t.solLimitLamports);
  if (solLimit <= 0n || solLimit > METEORA_DBC_MAX_SOL_LIMIT)
    throw new MeteoraDbcError('Set a SOL limit up to 5 SOL.', 400);
  const selection = await ownedSelection(db, owner, t);
  const quote = selection.original.quote,
    quoteInfo = DBC_QUOTES[quote.address];
  const chain = await readChain(rpc, t, quote.address, signal);
  const devBuy = BigInt(t.devBuyRaw);
  if (devBuy > 0n && chain.quoteBalanceRaw < devBuy)
    throw new MeteoraDbcError(
      `The deployer holds too little ${quoteInfo.symbol} for this creator buy.`,
      409,
    );
  const input: MeteoraDbcInput = {
    ...selection.identity,
    payer: t.payer,
    mint: t.mint,
    config: t.config,
    quoteMint: quote.address,
    baseTokenType: chain.config.tokenType,
    firstSwapWithMinFee: chain.config.enableFirstSwapWithMinFee,
    devBuyRaw: t.devBuyRaw,
    // Placeholder for the first simulation; replaced by the exact output below.
    minTokensOutRaw: devBuy > 0n ? '1' : '0',
    blockhash: chain.blockhash,
    lastValidBlockHeight: chain.lastValidBlockHeight,
  };
  const build = async (status: number) => {
    try {
      return await buildMeteoraDbcMessage(input);
    } catch (error) {
      throw new MeteoraDbcError(
        error instanceof Error ? error.message : 'Launch packet differs.',
        status,
      );
    }
  };
  let built = await build(400);
  const watch = [
    t.payer,
    t.mint,
    ...(built.baseTokenAccount ? [built.baseTokenAccount] : []),
  ];
  const first = await simulate(
    rpc,
    built.transaction,
    watch,
    chain.slot,
    signal,
  );
  let tokensOut = 0n;
  if (built.baseTokenAccount) {
    // The pool is created in this same transaction, so nobody can trade ahead
    // of the creator buy: the simulated output is exact and becomes the minimum.
    tokensOut = tokenAmount(first.value.accounts?.[2] ?? null, t.mint, t.payer);
    if (tokensOut === 0n)
      throw new MeteoraDbcError('Simulation produced no creator tokens.', 409);
    input.minTokensOutRaw = tokensOut.toString();
    built = await build(409);
  }
  const final = await simulate(
    rpc,
    built.transaction,
    watch,
    chain.slot,
    signal,
  );
  if (
    built.baseTokenAccount &&
    tokenAmount(final.value.accounts?.[2] ?? null, t.mint, t.payer) !==
      tokensOut
  )
    throw new MeteoraDbcError(
      'Creator buy output changed between simulations.',
      409,
    );
  const payerAfter = final.value.accounts?.[0];
  if (!payerAfter)
    throw new MeteoraDbcError('Simulation omitted the payer.', 502);
  const supply = mintSupply(final.value.accounts?.[1] ?? null);
  if (supply === 0n || tokensOut > supply)
    throw new MeteoraDbcError('Simulation omitted the new token supply.', 502);
  const solCost = chain.solLamports - BigInt(payerAfter.lamports) + 10000n;
  const solSpentOnQuote = quote.address === WRAPPED_SOL ? devBuy : 0n;
  if (solCost - solSpentOnQuote > solLimit)
    throw new MeteoraDbcError(
      `Fees, rent and the pool creation fee need ${(solCost - solSpentOnQuote).toString()} lamports, above your limit.`,
      409,
    );
  await selection.assertUnchanged();
  return {
    format: 'meteora-dbc-launch-review-v1',
    terms: {
      projectId: t.projectId,
      updatedAt: t.updatedAt,
      releaseId: t.releaseId,
      payer: t.payer,
      payerRevision: t.payerRevision,
      mint: t.mint,
      config: t.config,
      devBuyRaw: t.devBuyRaw,
      solLimitLamports: t.solLimitLamports,
    },
    input,
    transaction: built.transaction,
    sha256: built.packetSha256,
    expiresAt: new Date(now() + METEORA_DBC_REVIEW_MS).toISOString(),
    summary: {
      config: t.config,
      feeClaimer: chain.config.feeClaimer,
      pool: built.pool,
      quoteSymbol: quoteInfo.symbol,
      quoteDecimals: quoteInfo.decimals,
      baseDecimals: chain.config.tokenDecimal,
      tokenStandard: chain.config.tokenType === 0 ? 'SPL' : 'Token-2022',
      migrationThresholdRaw: chain.config.migrationQuoteThreshold.toString(),
      creatorTradingFeePercent: chain.config.creatorTradingFeePercentage,
      poolCreationFeeLamports: chain.config.poolCreationFee.toString(),
      supplyRaw: supply.toString(),
      devBuyRaw: t.devBuyRaw,
      tokensOutRaw: tokensOut.toString(),
      devSupplyBps: Number((tokensOut * 10000n) / supply),
      solCostLamports: (solCost - solSpentOnQuote).toString(),
      solLimitLamports: t.solLimitLamports,
      unitsConsumed:
        typeof final.value.unitsConsumed === 'number'
          ? final.value.unitsConsumed
          : null,
    },
  };
}

/**
 * Relays one browser-signed launch. The server rebuilds the packet from the
 * reviewed input, rechecks ownership and the on-chain config, requires both
 * exact signatures and a passing signed simulation, then sends once with no
 * retries.
 */
export async function submitMeteoraDbcLaunch(
  db: D1Database,
  owner: string,
  t: MeteoraDbcTerms,
  input: MeteoraDbcInput,
  signed: string,
  signal: AbortSignal,
  deps: MeteoraDbcDeps = {},
) {
  const rpc = deps.rpc ?? defaultRpc;
  if (
    typeof signed !== 'string' ||
    signed.length > 1800 ||
    btoa(atob(signed)) !== signed
  )
    throw new MeteoraDbcError('Invalid signed launch packet.', 400);
  const selection = await ownedSelection(db, owner, t);
  if (
    !input ||
    input.payer !== t.payer ||
    input.mint !== t.mint ||
    input.config !== t.config ||
    input.devBuyRaw !== t.devBuyRaw ||
    input.name !== selection.identity.name ||
    input.symbol !== selection.identity.symbol ||
    input.uri !== selection.identity.uri ||
    input.quoteMint !== selection.original.quote.address
  )
    throw new MeteoraDbcError(
      'Signed launch differs from the saved project.',
      409,
    );
  // The config decides the token standard and swap accounts; recheck it now.
  const chain = await readChain(rpc, t, input.quoteMint, signal);
  if (
    input.baseTokenType !== chain.config.tokenType ||
    input.firstSwapWithMinFee !== chain.config.enableFirstSwapWithMinFee
  )
    throw new MeteoraDbcError(
      'The DBC config changed since review. Review again.',
      409,
    );
  let built;
  try {
    built = await buildMeteoraDbcMessage(input);
  } catch {
    throw new MeteoraDbcError('Signed launch packet differs.', 400);
  }
  const decode = (v: string) => getTransactionDecoder().decode(b64(v));
  const original = decode(built.transaction),
    tx = decode(signed);
  const same = (a: ArrayLike<number>, b: ArrayLike<number>) =>
    a.length === b.length && Array.from(a).every((v, i) => v === b[i]);
  if (
    !same(tx.messageBytes, original.messageBytes) ||
    getBase64Decoder().decode(getTransactionEncoder().encode(tx)) !== signed ||
    Object.keys(tx.signatures).length !== 2
  )
    throw new MeteoraDbcError('Signed launch message changed.', 409);
  for (const key of [input.payer, input.mint]) {
    const sig = tx.signatures[address(key)];
    if (
      !sig ||
      !verifySolanaSignature(
        Uint8Array.from(tx.messageBytes),
        Uint8Array.from(sig),
        bs58.decode(key),
      )
    )
      throw new MeteoraDbcError(
        'Both payer and mint signatures are required.',
        400,
      );
  }
  await simulate(rpc, signed, [input.payer], 0, signal, true);
  await selection.assertUnchanged();
  const signature = bs58.encode(tx.signatures[address(input.payer)]!);
  const result = (state: 'sent' | 'unknown') => ({
    state,
    signature,
    mint: input.mint,
    pool: built.pool,
  });
  let sent: unknown;
  try {
    sent = await rpc(
      'sendTransaction',
      [
        signed,
        {
          encoding: 'base64',
          skipPreflight: false,
          preflightCommitment: 'confirmed',
          maxRetries: 0,
        },
      ],
      signal,
    );
  } catch {
    // Never resend: the packet may already be in flight.
    return result('unknown');
  }
  return result(sent === signature ? 'sent' : 'unknown');
}
