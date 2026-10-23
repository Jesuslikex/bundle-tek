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
  TOKEN_PROGRAM,
  WRAPPED_SOL,
  stonkAllowConfigId,
  stonkCurveRuleId,
} from './stonkfun-launch';
import {
  LAUNCHLAB_CURVES,
  LAUNCHLAB_PLATFORMS,
  buildLaunchLabMessage,
  isLaunchLabVenue,
  type LaunchLabInput,
  type LaunchLabVenue,
} from './launchlab-platform-launch';

export class LaunchLabError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
export type LaunchLabTerms = {
  venue: LaunchLabVenue;
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
export type LaunchLabRpc = (
  method: string,
  params: unknown[],
  signal: AbortSignal,
) => Promise<unknown>;
export type LaunchLabDeps = { rpc?: LaunchLabRpc; now?: () => number };

const defaultRpc: LaunchLabRpc = (method, params) =>
  rpcCall(getSolanaRpcEndpoint('mainnet'), method, params);
/** A blockhash lives ~60-90s; the review expires well before. */
export const LAUNCHLAB_REVIEW_MS = 45_000;
export const LAUNCHLAB_MAX_SOL_LIMIT = 1_000_000_000n;

type Row = { document: string; updated_at: string; archived: number };

/** Owner, saved plan for this venue, released metadata and verified payer, from the database only. */
async function ownedSelection(
  db: D1Database,
  owner: string,
  t: LaunchLabTerms,
) {
  let origin: URL;
  try {
    origin = new URL(t.origin);
  } catch {
    throw new LaunchLabError('Review the launch on this site.', 400);
  }
  if (
    !isLaunchLabVenue(t.venue) ||
    !artworkIdValid(t.releaseId) ||
    origin.protocol !== 'https:' ||
    origin.origin !== t.origin ||
    !Number.isSafeInteger(t.payerRevision) ||
    t.payerRevision < 1
  )
    throw new LaunchLabError(
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
      throw new LaunchLabError(
        'Owned project, released metadata or verified payer is unavailable.',
        404,
      );
    if (row.archived || row.updated_at !== t.updatedAt)
      throw new LaunchLabError(
        'Reload and review the current active project.',
        409,
      );
    const doc = validateProjectDocument(JSON.parse(row.document)),
      deployer = doc.options.wallets?.deployer;
    if (doc.plan.chain !== 'Solana' || doc.plan.launchpad !== t.venue)
      throw new LaunchLabError(`Save a ${t.venue} launch first.`, 400);
    if (
      !deployer ||
      doc.options.wallets?.chain !== 'Solana' ||
      deployer.address !== t.payer ||
      deployer.revision !== t.payerRevision
    )
      throw new LaunchLabError(
        'Save this exact verified payer as the launch deployer.',
        409,
      );
    validateQuoteSelection(doc.plan);
    const quotes = quoteCatalog('Solana', t.venue).assets.filter(
      (q) =>
        q.symbol === doc.plan.currency &&
        (!doc.plan.quoteAddress || q.address === doc.plan.quoteAddress),
    );
    if (quotes.length !== 1 || !LAUNCHLAB_CURVES[quotes[0].address])
      throw new LaunchLabError(
        `Select SOL or USD1 as the ${t.venue} quote token.`,
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
        throw new LaunchLabError(
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
  rpc: LaunchLabRpc,
  t: LaunchLabTerms,
  quoteMint: string,
  signal: AbortSignal,
) {
  const curve = LAUNCHLAB_CURVES[quoteMint],
    platformId = LAUNCHLAB_PLATFORMS[t.venue];
  const [quoteAta] = await findAssociatedTokenPda({
    mint: address(quoteMint),
    owner: address(t.payer),
    tokenProgram: address(TOKEN_PROGRAM),
  });
  const allowId = await stonkAllowConfigId(platformId, curve.configId),
    ruleId = await stonkCurveRuleId(platformId, curve.configId);
  const keys = [
    curve.configId,
    platformId,
    quoteMint,
    t.mint,
    quoteAta,
    ruleId,
    allowId,
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
  const [config, platform, mintB, mint, payerQuote, curveRule, allow] =
    multi.value;
  if (!config || config.owner !== LAUNCHLAB_PROGRAM)
    throw new LaunchLabError('LaunchLab has no curve for this quote.', 409);
  const cfg = b64(config.data[0]);
  // LaunchpadConfig: curveType u8 @16, index u16 @17, mintB @83.
  if (
    cfg.length < 115 ||
    cfg[16] !== 0 ||
    cfg[17] !== 0 ||
    cfg[18] !== 0 ||
    bs58.encode(cfg.slice(83, 115)) !== quoteMint
  )
    throw new LaunchLabError('LaunchLab curve config differs.', 409);
  if (!platform || platform.owner !== LAUNCHLAB_PROGRAM)
    throw new LaunchLabError(
      `${t.venue} platform account is unavailable.`,
      409,
    );
  const plat = b64(platform.data[0]);
  // PlatformConfig: name [u8;64] @112, restrictCurveParam u8 @833.
  if (plat.length < 834)
    throw new LaunchLabError(`${t.venue} platform account differs.`, 409);
  const curveRuleRequired = plat[833] === 1;
  if (
    curveRuleRequired &&
    (!curveRule || curveRule.owner !== LAUNCHLAB_PROGRAM)
  )
    throw new LaunchLabError(`${t.venue} curve rule is unavailable.`, 409);
  const nameBytes = plat.slice(112, 176),
    nameEnd = nameBytes.indexOf(0);
  const platformName = new TextDecoder().decode(
    nameEnd < 0 ? nameBytes : nameBytes.slice(0, nameEnd),
  );
  if (!mintB || mintB.owner !== TOKEN_PROGRAM)
    throw new LaunchLabError('Quote mint differs.', 409);
  const qm = b64(mintB.data[0]);
  if (qm.length < 82 || qm[44] !== curve.decimals)
    throw new LaunchLabError('Quote precision differs.', 409);
  if (mint)
    throw new LaunchLabError(
      'This mint already exists on-chain. It may already be launched; check it before using a new mint.',
      409,
    );
  return {
    slot: multi.context.slot,
    curveRuleRequired,
    allowConfig: !!allow && allow.owner === LAUNCHLAB_PROGRAM,
    platformName,
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
  rpc: LaunchLabRpc,
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
    throw new LaunchLabError(
      `Simulation rejected the launch.${log ? ' ' + log : ''}`,
      409,
    );
  }
  return result;
}

export type LaunchLabReview = {
  minimumSlot?: number;
  format: 'launchlab-launch-review-v1';
  terms: Omit<LaunchLabTerms, 'origin'>;
  input: LaunchLabInput;
  transaction: string;
  sha256: string;
  expiresAt: string;
  summary: {
    venue: LaunchLabVenue;
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
  };
};

/** Unsigned, simulated review. Grants nothing: the browser rebuilds it and the user signs it. */
export async function prepareLaunchLabLaunch(
  db: D1Database,
  owner: string,
  t: LaunchLabTerms,
  signal: AbortSignal,
  deps: LaunchLabDeps = {},
): Promise<LaunchLabReview> {
  const rpc = deps.rpc ?? defaultRpc,
    now = deps.now ?? Date.now;
  if (
    isOffCurveAddress(address(t.payer)) ||
    isOffCurveAddress(address(t.mint)) ||
    t.payer === t.mint
  )
    throw new LaunchLabError(
      'Payer and mint must be distinct wallet keys.',
      400,
    );
  const solLimit = BigInt(t.solLimitLamports);
  if (solLimit <= 0n || solLimit > LAUNCHLAB_MAX_SOL_LIMIT)
    throw new LaunchLabError('Set a SOL fee limit up to 1 SOL.', 400);
  const selection = await ownedSelection(db, owner, t);
  const quote = selection.original.quote,
    curve = LAUNCHLAB_CURVES[quote.address];
  if (quote.decimals !== curve.decimals)
    throw new LaunchLabError('Quote precision differs.', 409);
  const chain = await readChain(rpc, t, quote.address, signal);
  const devBuy = BigInt(t.devBuyRaw);
  if (devBuy > 0n && chain.quoteBalanceRaw < devBuy)
    throw new LaunchLabError(
      `The deployer holds too little ${curve.symbol} for this creator buy.`,
      409,
    );
  const input: LaunchLabInput = {
    venue: t.venue,
    ...selection.identity,
    payer: t.payer,
    mint: t.mint,
    quoteMint: quote.address,
    platformId: LAUNCHLAB_PLATFORMS[t.venue],
    configId: curve.configId,
    supply: curve.supply,
    totalSellA: curve.totalSellA,
    totalFundRaisingB: curve.totalFundRaisingB,
    allowConfig: chain.allowConfig,
    curveRule: chain.curveRuleRequired,
    devBuyRaw: t.devBuyRaw,
    // Placeholder for the first simulation; replaced by the exact output below.
    minTokensOutRaw: devBuy > 0n ? '1' : '0',
    blockhash: chain.blockhash,
    lastValidBlockHeight: chain.lastValidBlockHeight,
  };
  let built;
  try {
    built = await buildLaunchLabMessage(input);
  } catch (error) {
    throw new LaunchLabError(
      error instanceof Error ? error.message : 'Launch packet differs.',
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
      throw new LaunchLabError('Simulation produced no creator tokens.', 409);
    input.minTokensOutRaw = tokensOut.toString();
    try {
      built = await buildLaunchLabMessage(input);
    } catch (error) {
      throw new LaunchLabError(
        error instanceof Error ? error.message : 'Launch packet differs.',
        409,
      );
    }
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
    throw new LaunchLabError(
      'Creator buy output changed between simulations.',
      409,
    );
  const payerAfter = final.value.accounts?.[0];
  if (!payerAfter)
    throw new LaunchLabError('Simulation omitted the payer.', 502);
  const solCost = chain.solLamports - BigInt(payerAfter.lamports) + 10000n;
  const solSpentOnQuote = quote.address === WRAPPED_SOL ? devBuy : 0n;
  if (solCost - solSpentOnQuote > solLimit)
    throw new LaunchLabError(
      `Fees and rent need ${(solCost - solSpentOnQuote).toString()} lamports, above your limit.`,
      409,
    );
  await selection.assertUnchanged();
  return {
    format: 'launchlab-launch-review-v1',
    minimumSlot: chain.slot,
    terms: {
      venue: t.venue,
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
    expiresAt: new Date(now() + LAUNCHLAB_REVIEW_MS).toISOString(),
    summary: {
      venue: t.venue,
      platformName: chain.platformName,
      pool: built.pool,
      quoteSymbol: curve.symbol,
      quoteDecimals: curve.decimals,
      raiseRaw: curve.totalFundRaisingB,
      supplyRaw: curve.supply,
      devBuyRaw: t.devBuyRaw,
      tokensOutRaw: tokensOut.toString(),
      devSupplyBps: Number((tokensOut * 10000n) / BigInt(curve.supply)),
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
 * reviewed input, rechecks ownership, requires both exact signatures and a
 * passing signed simulation, then sends once with no retries.
 */
export async function submitLaunchLabLaunch(
  db: D1Database,
  owner: string,
  t: LaunchLabTerms,
  input: LaunchLabInput,
  signed: string,
  signal: AbortSignal,
  deps: LaunchLabDeps = {},
) {
  const rpc = deps.rpc ?? defaultRpc;
  if (
    typeof signed !== 'string' ||
    signed.length > 1800 ||
    btoa(atob(signed)) !== signed
  )
    throw new LaunchLabError('Invalid signed launch packet.', 400);
  const selection = await ownedSelection(db, owner, t);
  if (
    input.venue !== t.venue ||
    input.payer !== t.payer ||
    input.mint !== t.mint ||
    input.devBuyRaw !== t.devBuyRaw ||
    input.name !== selection.identity.name ||
    input.symbol !== selection.identity.symbol ||
    input.uri !== selection.identity.uri ||
    input.quoteMint !== selection.original.quote.address
  )
    throw new LaunchLabError(
      'Signed launch differs from the saved project.',
      409,
    );
  let built;
  try {
    built = await buildLaunchLabMessage(input);
  } catch {
    throw new LaunchLabError('Signed launch packet differs.', 400);
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
    throw new LaunchLabError('Signed launch message changed.', 409);
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
      throw new LaunchLabError(
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
