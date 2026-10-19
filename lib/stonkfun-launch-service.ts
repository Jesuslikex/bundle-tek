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
  LAUNCHLAB_PROGRAM,
  STONKFUN_MAX_DEV_SUPPLY_BPS,
  WRAPPED_SOL,
  buildStonkLaunchMessage,
  type StonkLaunchInput,
} from './stonkfun-launch';
import { fetchStonkPricing, type StonkPricing } from './stonkfun-pricing';

export class StonkLaunchError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
export type StonkLaunchTerms = {
  projectId: string;
  updatedAt: string;
  releaseId: string;
  origin: string;
  payer: string;
  payerRevision: number;
  mint: string;
  /** Raw quote units for the creator buy, "0" for create only. */
  devBuyRaw: string;
  /** Upper bound on SOL the payer may spend on fees and rent, in lamports. */
  solLimitLamports: string;
};
export type StonkRpc = (
  method: string,
  params: unknown[],
  signal: AbortSignal,
) => Promise<unknown>;
export type StonkDeps = {
  rpc?: StonkRpc;
  fetcher?: typeof fetch;
  now?: () => number;
};

const defaultRpc: StonkRpc = (method, params) =>
  rpcCall(getSolanaRpcEndpoint('mainnet'), method, params);
/** A LaunchLab blockhash lives ~60-90s; the review expires well before. */
export const STONKFUN_REVIEW_MS = 45_000;
export const STONKFUN_MAX_SOL_LIMIT = 1_000_000_000n;

type Row = {
  document: string;
  updated_at: string;
  archived: number;
};

/** Owner, saved StonkFun plan, released metadata and verified payer, read from the database only. */
async function ownedStonkSelection(
  db: D1Database,
  owner: string,
  t: StonkLaunchTerms,
) {
  let origin: URL;
  try {
    origin = new URL(t.origin);
  } catch {
    throw new StonkLaunchError('Review the launch on this site.', 400);
  }
  if (
    !artworkIdValid(t.releaseId) ||
    origin.protocol !== 'https:' ||
    origin.origin !== t.origin ||
    !Number.isSafeInteger(t.payerRevision) ||
    t.payerRevision < 1
  )
    throw new StonkLaunchError(
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
      throw new StonkLaunchError(
        'Owned project, released metadata or verified payer is unavailable.',
        404,
      );
    if (row.archived || row.updated_at !== t.updatedAt)
      throw new StonkLaunchError(
        'Reload and review the current active project.',
        409,
      );
    const doc = validateProjectDocument(JSON.parse(row.document)),
      deployer = doc.options.wallets?.deployer;
    if (doc.plan.chain !== 'Solana' || doc.plan.launchpad !== 'StonkFun')
      throw new StonkLaunchError('Save a StonkFun launch first.', 400);
    if (
      !deployer ||
      doc.options.wallets?.chain !== 'Solana' ||
      deployer.address !== t.payer ||
      deployer.revision !== t.payerRevision
    )
      throw new StonkLaunchError(
        'Save this exact verified payer as the launch deployer.',
        409,
      );
    validateQuoteSelection(doc.plan);
    const quotes = quoteCatalog('Solana', 'StonkFun').assets.filter(
      (q) =>
        q.symbol === doc.plan.currency &&
        (!doc.plan.quoteAddress || q.address === doc.plan.quoteAddress),
    );
    if (quotes.length !== 1)
      throw new StonkLaunchError('Select one exact quote token.', 409);
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
        throw new StonkLaunchError(
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

async function readChain(
  rpc: StonkRpc,
  pricing: StonkPricing,
  t: StonkLaunchTerms,
  signal: AbortSignal,
) {
  const [quoteAta] = await findAssociatedTokenPda({
    mint: address(pricing.quoteMint),
    owner: address(t.payer),
    tokenProgram: address(pricing.quoteTokenProgram),
  });
  const keys = [
    pricing.configId,
    pricing.platformId,
    pricing.quoteMint,
    t.mint,
    quoteAta,
    pricing.curveRuleId,
  ];
  const [multi, balance, latest] = await Promise.all([
    rpc(
      'getMultipleAccounts',
      [keys, { encoding: 'base64', commitment: 'confirmed' }],
      signal,
    ) as Promise<{ context: { slot: number }; value: AccountInfo[] }>,
    rpc(
      'getBalance',
      [t.payer, { commitment: 'confirmed' }],
      signal,
    ) as Promise<{
      value: number;
    }>,
    rpc(
      'getLatestBlockhash',
      [{ commitment: 'confirmed' }],
      signal,
    ) as Promise<{
      value: { blockhash: string; lastValidBlockHeight: number };
    }>,
  ]);
  const [config, platform, quoteMint, mint, payerQuote, curveRule] =
    multi.value;
  if (!config || config.owner !== LAUNCHLAB_PROGRAM)
    throw new StonkLaunchError(
      'LaunchLab has no curve for this quote yet.',
      409,
    );
  const cfg = b64(config.data[0]);
  // LaunchpadConfig: curveType u8 @16, index u16 @17, mintB @83.
  if (
    cfg.length < 115 ||
    cfg[16] !== 0 ||
    cfg[17] !== 0 ||
    cfg[18] !== 0 ||
    bs58.encode(cfg.slice(83, 115)) !== pricing.quoteMint
  )
    throw new StonkLaunchError('LaunchLab curve config differs.', 409);
  if (!platform || platform.owner !== LAUNCHLAB_PROGRAM)
    throw new StonkLaunchError(
      'StonkFun platform account is unavailable.',
      409,
    );
  const plat = b64(platform.data[0]);
  // PlatformConfig: name [u8;64] @112, restrictCurveParam u8 @833.
  if (plat.length < 834)
    throw new StonkLaunchError('StonkFun platform account differs.', 409);
  const curveRuleRequired = plat[833] === 1;
  if (
    curveRuleRequired &&
    (!curveRule || curveRule.owner !== LAUNCHLAB_PROGRAM)
  )
    throw new StonkLaunchError('StonkFun curve rule is unavailable.', 409);
  const nameBytes = plat.slice(112, 176);
  const nameEnd = nameBytes.indexOf(0);
  const platformName = new TextDecoder().decode(
    nameEnd < 0 ? nameBytes : nameBytes.slice(0, nameEnd),
  );
  if (!quoteMint || quoteMint.owner !== pricing.quoteTokenProgram)
    throw new StonkLaunchError(
      'Quote mint differs from StonkFun pricing.',
      409,
    );
  const qm = b64(quoteMint.data[0]);
  if (qm.length < 82 || qm[44] !== pricing.quoteDecimals)
    throw new StonkLaunchError(
      'Quote precision differs from StonkFun pricing.',
      409,
    );
  if (mint)
    throw new StonkLaunchError(
      'This mint already exists on-chain. It may already be launched; check it before using a new mint.',
      409,
    );
  return {
    slot: multi.context.slot,
    curveRuleRequired,
    platformName,
    quoteAta,
    quoteBalanceRaw:
      pricing.quoteMint === WRAPPED_SOL
        ? BigInt(balance.value)
        : tokenAmount(payerQuote, pricing.quoteMint, t.payer),
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
  rpc: StonkRpc,
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
    throw new StonkLaunchError(
      `Simulation rejected the launch.${log ? ' ' + log : ''}`,
      409,
    );
  }
  return result;
}

export type StonkLaunchReview = {
  format: 'stonkfun-launch-review-v1';
  terms: Omit<StonkLaunchTerms, 'origin'>;
  input: StonkLaunchInput;
  transaction: string;
  sha256: string;
  expiresAt: string;
  summary: {
    platformName: string;
    pool: string;
    quoteSymbol: string;
    quoteDecimals: number;
    raiseRaw: string;
    supplyRaw: string;
    devBuyRaw: string;
    tokensOutRaw: string;
    devSupplyBps: number;
    solCostLamports: string;
    solLimitLamports: string;
    unitsConsumed: number | null;
    startMarketCapUsd: number | null;
    graduationMarketCapUsd: number | null;
    pricingObservedAt: string;
  };
};

/** Unsigned, simulated review. Grants nothing: the browser rebuilds it and the user signs it. */
export async function prepareStonkLaunch(
  db: D1Database,
  owner: string,
  t: StonkLaunchTerms,
  signal: AbortSignal,
  deps: StonkDeps = {},
): Promise<StonkLaunchReview> {
  const rpc = deps.rpc ?? defaultRpc,
    now = deps.now ?? Date.now;
  if (
    isOffCurveAddress(address(t.payer)) ||
    isOffCurveAddress(address(t.mint)) ||
    t.payer === t.mint
  )
    throw new StonkLaunchError(
      'Payer and mint must be distinct wallet keys.',
      400,
    );
  const solLimit = BigInt(t.solLimitLamports);
  if (solLimit <= 0n || solLimit > STONKFUN_MAX_SOL_LIMIT)
    throw new StonkLaunchError('Set a SOL fee limit up to 1 SOL.', 400);
  const selection = await ownedStonkSelection(db, owner, t);
  const quote = selection.original.quote;
  let pricing: StonkPricing;
  try {
    pricing = await fetchStonkPricing(quote.address, signal, deps.fetcher);
  } catch (error) {
    throw new StonkLaunchError(
      error instanceof Error
        ? error.message
        : 'StonkFun pricing is unavailable.',
      502,
    );
  }
  if (pricing.quoteDecimals !== quote.decimals)
    throw new StonkLaunchError(
      'Quote precision differs from StonkFun pricing.',
      409,
    );
  const chain = await readChain(rpc, pricing, t, signal);
  const devBuy = BigInt(t.devBuyRaw);
  if (devBuy > 0n && chain.quoteBalanceRaw < devBuy)
    throw new StonkLaunchError(
      `The deployer holds too little ${pricing.quoteSymbol || 'quote'} for this creator buy.`,
      409,
    );
  const input: StonkLaunchInput = {
    ...selection.identity,
    payer: t.payer,
    mint: t.mint,
    quoteMint: pricing.quoteMint,
    quoteTokenProgram: pricing.quoteTokenProgram,
    platformId: pricing.platformId,
    configId: pricing.configId,
    supply: pricing.supply,
    totalSellA: pricing.totalSellA,
    totalFundRaisingB: pricing.totalFundRaisingB,
    cpmmCreatorFeeOn: pricing.cpmmCreatorFeeOn,
    allowConfig: pricing.allowConfig,
    curveRule: chain.curveRuleRequired,
    devBuyRaw: t.devBuyRaw,
    // Placeholder for the first simulation; replaced by the exact output below.
    minTokensOutRaw: devBuy > 0n ? '1' : '0',
    blockhash: chain.blockhash,
    lastValidBlockHeight: chain.lastValidBlockHeight,
  };
  let built;
  try {
    built = await buildStonkLaunchMessage(input);
  } catch (error) {
    throw new StonkLaunchError(
      error instanceof Error ? error.message : 'StonkFun packet differs.',
      400,
    );
  }
  const watch = [
    t.payer,
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
    tokensOut = tokenAmount(first.value.accounts?.[1] ?? null, t.mint, t.payer);
    if (tokensOut === 0n)
      throw new StonkLaunchError('Simulation produced no creator tokens.', 409);
    if (
      tokensOut * 10000n >
      BigInt(pricing.supply) * STONKFUN_MAX_DEV_SUPPLY_BPS
    )
      throw new StonkLaunchError(
        'StonkFun caps the creator buy at 50% of supply. Lower the amount.',
        409,
      );
    input.minTokensOutRaw = tokensOut.toString();
    built = await buildStonkLaunchMessage(input);
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
    tokenAmount(final.value.accounts?.[1] ?? null, t.mint, t.payer) !==
      tokensOut
  )
    throw new StonkLaunchError(
      'Creator buy output changed between simulations.',
      409,
    );
  const payerAfter = final.value.accounts?.[0];
  if (!payerAfter)
    throw new StonkLaunchError('Simulation omitted the payer.', 502);
  const solCost = chain.solLamports - BigInt(payerAfter.lamports) + 10000n;
  const solSpentOnQuote = pricing.quoteMint === WRAPPED_SOL ? devBuy : 0n;
  if (solCost - solSpentOnQuote > solLimit)
    throw new StonkLaunchError(
      `Fees and rent need ${(solCost - solSpentOnQuote).toString()} lamports, above your limit.`,
      409,
    );
  await selection.assertUnchanged();
  return {
    format: 'stonkfun-launch-review-v1',
    terms: {
      projectId: t.projectId,
      updatedAt: t.updatedAt,
      releaseId: t.releaseId,
      payer: t.payer,
      payerRevision: t.payerRevision,
      mint: t.mint,
      devBuyRaw: t.devBuyRaw,
      solLimitLamports: t.solLimitLamports,
    },
    input,
    transaction: built.transaction,
    sha256: built.packetSha256,
    expiresAt: new Date(now() + STONKFUN_REVIEW_MS).toISOString(),
    summary: {
      platformName: chain.platformName,
      pool: built.pool,
      quoteSymbol: pricing.quoteSymbol || quote.symbol,
      quoteDecimals: pricing.quoteDecimals,
      raiseRaw: pricing.totalFundRaisingB,
      supplyRaw: pricing.supply,
      devBuyRaw: t.devBuyRaw,
      tokensOutRaw: tokensOut.toString(),
      devSupplyBps: Number((tokensOut * 10000n) / BigInt(pricing.supply)),
      solCostLamports: (solCost - solSpentOnQuote).toString(),
      solLimitLamports: t.solLimitLamports,
      unitsConsumed:
        typeof final.value.unitsConsumed === 'number'
          ? final.value.unitsConsumed
          : null,
      startMarketCapUsd: pricing.startMarketCapUsd,
      graduationMarketCapUsd: pricing.graduationMarketCapUsd,
      pricingObservedAt: pricing.observedAt,
    },
  };
}

/**
 * Relays one browser-signed launch. The server rebuilds the packet from the
 * reviewed input, rechecks ownership, requires both exact signatures and a
 * passing signed simulation, then sends once with no retries.
 */
export async function submitStonkLaunch(
  db: D1Database,
  owner: string,
  t: StonkLaunchTerms,
  input: StonkLaunchInput,
  signed: string,
  signal: AbortSignal,
  deps: StonkDeps = {},
) {
  const rpc = deps.rpc ?? defaultRpc;
  if (
    typeof signed !== 'string' ||
    signed.length > 1800 ||
    btoa(atob(signed)) !== signed
  )
    throw new StonkLaunchError('Invalid signed launch packet.', 400);
  const selection = await ownedStonkSelection(db, owner, t);
  if (
    input.payer !== t.payer ||
    input.mint !== t.mint ||
    input.devBuyRaw !== t.devBuyRaw ||
    input.name !== selection.identity.name ||
    input.symbol !== selection.identity.symbol ||
    input.uri !== selection.identity.uri ||
    input.quoteMint !== selection.original.quote.address
  )
    throw new StonkLaunchError(
      'Signed launch differs from the saved project.',
      409,
    );
  let built;
  try {
    built = await buildStonkLaunchMessage(input);
  } catch {
    throw new StonkLaunchError('Signed launch packet differs.', 400);
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
    throw new StonkLaunchError('Signed launch message changed.', 409);
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
      throw new StonkLaunchError(
        'Both payer and mint signatures are required.',
        400,
      );
  }
  await simulate(rpc, signed, [input.payer], 0, signal, true);
  await selection.assertUnchanged();
  const signature = bs58.encode(tx.signatures[address(input.payer)]!);
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
    return {
      state: 'unknown' as const,
      signature,
      mint: input.mint,
      pool: built.pool,
    };
  }
  if (sent !== signature)
    return {
      state: 'unknown' as const,
      signature,
      mint: input.mint,
      pool: built.pool,
    };
  return {
    state: 'sent' as const,
    signature,
    mint: input.mint,
    pool: built.pool,
  };
}

/** Read-only confirmation lookup for a launch signature. */
export async function stonkLaunchStatus(
  signature: string,
  signal: AbortSignal,
  deps: StonkDeps = {},
) {
  const rpc = deps.rpc ?? defaultRpc;
  if (!/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(signature))
    throw new StonkLaunchError('Invalid signature.', 400);
  const result = (await rpc(
    'getSignatureStatuses',
    [[signature], { searchTransactionHistory: true }],
    signal,
  )) as { value: ({ confirmationStatus?: string; err: unknown } | null)[] };
  const status = result.value[0];
  if (!status) return { state: 'pending' as const };
  if (status.err) return { state: 'failed' as const };
  return {
    state:
      status.confirmationStatus === 'finalized'
        ? ('finalized' as const)
        : ('confirmed' as const),
  };
}
