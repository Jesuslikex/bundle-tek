import { address, isOffCurveAddress } from '@solana/kit';
import { findAssociatedTokenPda } from '@solana-program/token';
import bs58 from 'bs58';
import { validateProjectDocument } from './workspace-project';
import { getJitoTipAccounts } from './jito-provider';
import { getSolanaRpcEndpoint, rpcCall } from './solana-rpc';
import {
  prepareStonkLaunch,
  StonkLaunchError,
  type StonkDeps,
  type StonkLaunchReview,
  type StonkLaunchTerms,
} from './stonkfun-launch-service';
import { WRAPPED_SOL, LAUNCHLAB_PROGRAM } from './stonkfun-launch';
import {
  buildStonkBundle,
  verifyStonkBundleReview,
  decodeStonkPool,
  stonkBuyExactIn,
  stonkFeeRate,
  STONKFUN_BUNDLE_MAX_HOLDERS,
  type StonkBundlePacket,
  type StonkHolderBuy,
} from './stonkfun-bundle';

export type StonkBundleHolderTerm = {
  address: string;
  revision: number;
  buyRaw: string;
};
export type StonkBundleTerms = StonkLaunchTerms & {
  holders: StonkBundleHolderTerm[];
  tipLamports: string;
};
export type StonkBundleSummary = {
  format: 'stonkfun-holder-bundle-v1';
  sha256: string;
  tipAccount: string;
  tipLamports: string;
  holders: (StonkHolderBuy & {
    revision: number;
    expectedTokensOutRaw: string;
    solCostLamports: string;
  })[];
  packets: StonkBundlePacket[];
  /** Totals across all bundle holders, raw base/quote units. */
  holdersBuyRaw: string;
  holdersTokensOutRaw: string;
  holdersSupplyBps: number;
  /** True only when the configured RPC replayed the whole unsigned bundle in order. */
  bundleSimulated: boolean;
};
export { verifyStonkBundleReview };
export type StonkBundleReview = Omit<StonkLaunchReview, 'terms'> & {
  terms: Omit<StonkBundleTerms, 'origin'>;
  bundle: StonkBundleSummary;
};
export type StonkBundleDeps = StonkDeps & {
  tipAccounts?: (signal: AbortSignal) => Promise<string[]>;
  prepareLaunch?: typeof prepareStonkLaunch;
};

/** Minimum output is the curve-computed output less this tolerance. Bundle order is fixed, so this only absorbs rounding. */
export const STONKFUN_HOLDER_TOLERANCE_BPS = 100n;
/** Token-2022 holder ATA (170 bytes) rent plus one signature fee. */
const HOLDER_ATA_RENT = 2_074_080n;
const QUOTE_ATA_RENT = 2_039_280n;
const SIGNATURE_FEE = 5_000n;

export function isStonkBundleReview(
  review: unknown,
): review is StonkBundleReview {
  return (
    !!review &&
    typeof review === 'object' &&
    'bundle' in review &&
    !!(review as { bundle?: unknown }).bundle
  );
}

type AccountInfo = {
  data: [string, 'base64'];
  owner: string;
  lamports: number;
} | null;
const b64 = (v: string) => Uint8Array.from(Buffer.from(v, 'base64'));
const fail = (message: string, status = 409): never => {
  throw new StonkLaunchError(message, status);
};
function tokenAmount(account: AccountInfo, mint: string, owner: string) {
  if (!account) return 0n;
  const data = b64(account.data[0]);
  if (
    data.length < 72 ||
    bs58.encode(data.slice(0, 32)) !== mint ||
    bs58.encode(data.slice(32, 64)) !== owner
  )
    return fail('Holder quote token account differs.');
  return new DataView(data.buffer, data.byteOffset).getBigUint64(64, true);
}

export function validateStonkBundleHolders(
  t: Pick<StonkBundleTerms, 'holders' | 'tipLamports' | 'payer' | 'mint'>,
) {
  if (
    !Array.isArray(t.holders) ||
    t.holders.length < 1 ||
    t.holders.length > STONKFUN_BUNDLE_MAX_HOLDERS
  )
    return fail(
      `Choose 1 to ${STONKFUN_BUNDLE_MAX_HOLDERS} holder wallets for the bundle.`,
      400,
    );
  if (
    typeof t.tipLamports !== 'string' ||
    !/^[1-9]\d{3,7}$/.test(t.tipLamports) ||
    BigInt(t.tipLamports) > 10_000_000n
  )
    return fail('Choose a Jito tip from 0.000001 to 0.01 SOL.', 400);
  const seen = new Set([t.payer, t.mint]);
  for (const h of t.holders) {
    try {
      if (
        !h ||
        typeof h !== 'object' ||
        Object.keys(h).sort().join() !== 'address,buyRaw,revision' ||
        isOffCurveAddress(address(h.address)) ||
        !Number.isSafeInteger(h.revision) ||
        h.revision < 1 ||
        typeof h.buyRaw !== 'string' ||
        !/^[1-9]\d{0,18}$/.test(h.buyRaw)
      )
        throw new Error();
    } catch {
      return fail('Review each holder wallet and its buy amount.', 400);
    }
    if (seen.has(h.address))
      return fail(
        'Holder wallets must differ from each other, the deployer and the mint.',
        400,
      );
    seen.add(h.address);
  }
}

/** Saved recipients with current revisions and ownership proofs, from the database only. */
async function ownedHolders(
  db: D1Database,
  owner: string,
  t: StonkBundleTerms,
) {
  const project = await db
    .prepare(
      'SELECT document,updated_at,archived FROM workspace_projects WHERE owner_id=? AND id=?',
    )
    .bind(owner, t.projectId)
    .first<{ document: string; updated_at: string; archived: number }>();
  if (!project || project.archived || project.updated_at !== t.updatedAt)
    return fail('Reload and review the current active project.');
  const doc = validateProjectDocument(JSON.parse(project.document));
  const recipients = doc.options.wallets?.recipients ?? [];
  for (const h of t.holders) {
    if (
      !recipients.some(
        (r) => r.address === h.address && r.revision === h.revision,
      )
    )
      return fail(
        'Save each bundle wallet as a launch holder in this project first.',
      );
    const row = await db
      .prepare(
        `SELECT 1 AS ok FROM workspace_wallets w WHERE w.owner_id=? AND w.chain='Solana' AND w.address=? AND w.revision=? AND w.archived=0
        AND EXISTS(SELECT 1 FROM wallet_ownership_proofs o WHERE o.owner_id=w.owner_id AND o.chain='Solana' AND o.address=w.address)`,
      )
      .bind(owner, h.address, h.revision)
      .first<{ ok: number }>();
    if (!row)
      return fail(
        'Each bundle wallet must be an active, ownership-verified wallet.',
      );
  }
  return project.document;
}

/**
 * Unsigned, reviewed StonkFun holder bundle. Reuses the original create review
 * unchanged, then sizes holder buys on the created curve and packs them with a
 * deployer-paid Jito tip. Grants nothing: every wallet signs in the browser.
 */
export async function prepareStonkBundle(
  db: D1Database,
  owner: string,
  t: StonkBundleTerms,
  signal: AbortSignal,
  deps: StonkBundleDeps = {},
): Promise<StonkBundleReview> {
  validateStonkBundleHolders(t);
  const rpc =
    deps.rpc ??
    ((method: string, params: unknown[]) =>
      rpcCall(getSolanaRpcEndpoint('mainnet'), method, params));
  const projectBefore = await ownedHolders(db, owner, t);
  const { holders, tipLamports, ...launchTerms } = t;
  const base = await (deps.prepareLaunch ?? prepareStonkLaunch)(
    db,
    owner,
    launchTerms,
    signal,
    { rpc, fetcher: deps.fetcher, now: deps.now },
  );
  const launch = base.input;
  const quoteMint = launch.quoteMint,
    wrapped = quoteMint === WRAPPED_SOL;
  const quoteAtas = await Promise.all(
    holders.map(
      async (h) =>
        (
          await findAssociatedTokenPda({
            mint: address(quoteMint),
            owner: address(h.address),
            tokenProgram: address(launch.quoteTokenProgram),
          })
        )[0],
    ),
  );
  const keys = [
    launch.configId,
    launch.platformId,
    ...holders.map((h) => h.address),
    ...(wrapped ? [] : quoteAtas),
  ];
  const [multi, payerBalance, simulated] = await Promise.all([
    rpc(
      'getMultipleAccounts',
      [
        keys,
        {
          encoding: 'base64',
          commitment: 'confirmed',
          minContextSlot: base.minimumSlot,
        },
      ],
      signal,
    ) as Promise<{ value: AccountInfo[] }>,
    rpc(
      'getBalance',
      [launch.payer, { commitment: 'confirmed' }],
      signal,
    ) as Promise<{ value: number }>,
    rpc(
      'simulateTransaction',
      [
        base.transaction,
        {
          encoding: 'base64',
          commitment: 'confirmed',
          sigVerify: false,
          replaceRecentBlockhash: false,
          minContextSlot: base.minimumSlot,
          accounts: { encoding: 'base64', addresses: [base.summary.pool] },
        },
      ],
      signal,
    ) as Promise<{ value: { err: unknown; accounts?: AccountInfo[] } }>,
  ]);
  const [config, platform] = multi.value;
  if (
    !config ||
    config.owner !== LAUNCHLAB_PROGRAM ||
    !platform ||
    platform.owner !== LAUNCHLAB_PROGRAM
  )
    return fail('LaunchLab fee accounts are unavailable.');
  const feeRate = stonkFeeRate(b64(config.data[0]), b64(platform.data[0]));
  const poolAccount = simulated.value.accounts?.[0];
  if (
    simulated.value.err ||
    !poolAccount ||
    poolAccount.owner !== LAUNCHLAB_PROGRAM
  )
    return fail('The created StonkFun pool could not be simulated.');
  let state = decodeStonkPool(b64(poolAccount.data[0]));
  // Self-check the curve math against the simulated creator buy when there is one.
  if (BigInt(base.summary.devBuyRaw) > 0n) {
    const check = stonkBuyExactIn(
      { ...state, realA: 0n, realB: 0n },
      BigInt(base.summary.devBuyRaw),
      feeRate,
    );
    if (
      check.tokensOut !== BigInt(base.summary.tokensOutRaw) ||
      state.realA !== check.tokensOut
    )
      return fail(
        'StonkFun curve math differs from the simulated creator buy. Bundle sizing is unavailable.',
      );
  } else if (state.realA !== 0n)
    return fail('The created StonkFun pool differs.');

  const sized: StonkBundleSummary['holders'] = [];
  let totalBuy = 0n,
    totalOut = 0n;
  for (const [i, h] of holders.entries()) {
    const buy = BigInt(h.buyRaw);
    const step = stonkBuyExactIn(state, buy, feeRate);
    state = step.next;
    const minOut =
      (step.tokensOut * (10000n - STONKFUN_HOLDER_TOLERANCE_BPS)) / 10000n;
    const lamports = BigInt(multi.value[2 + i]?.lamports ?? 0);
    const solCost = HOLDER_ATA_RENT + SIGNATURE_FEE;
    if (solCost > BigInt(t.solLimitLamports))
      return fail('Holder fees and rent exceed your SOL limit.');
    const need = solCost + (wrapped ? buy + QUOTE_ATA_RENT : 0n);
    if (lamports < need)
      return fail(
        `Holder ${h.address.slice(0, 4)}…${h.address.slice(-4)} needs ${need.toString()} lamports, it holds ${lamports.toString()}.`,
      );
    if (!wrapped) {
      const quote = tokenAmount(
        multi.value[2 + holders.length + i] ?? null,
        quoteMint,
        h.address,
      );
      if (quote < buy)
        return fail(
          `Holder ${h.address.slice(0, 4)}…${h.address.slice(-4)} holds too little ${base.summary.quoteSymbol || 'quote'}.`,
        );
    }
    totalBuy += buy;
    totalOut += step.tokensOut;
    sized.push({
      holder: h.address,
      revision: h.revision,
      buyRaw: h.buyRaw,
      minTokensOutRaw: minOut.toString(),
      expectedTokensOutRaw: step.tokensOut.toString(),
      solCostLamports: solCost.toString(),
    });
  }
  const supply = BigInt(base.summary.supplyRaw);
  if ((BigInt(base.summary.tokensOutRaw) + totalOut) * 2n > supply)
    return fail(
      'Creator and holder buys together exceed 50% of supply. Lower the amounts.',
    );
  const tips = await (
    deps.tipAccounts ??
    ((s: AbortSignal) => getJitoTipAccounts(s, deps.fetcher))
  )(signal);
  if (!Array.isArray(tips) || !tips.length)
    return fail('Jito tip accounts are unavailable.', 502);
  const tipAccount =
    tips[crypto.getRandomValues(new Uint32Array(1))[0] % tips.length];
  const bundle = await buildStonkBundle(launch, {
    holders: sized.map(({ holder, buyRaw, minTokensOutRaw }) => ({
      holder,
      buyRaw,
      minTokensOutRaw,
    })),
    tipAccount,
    tipLamports,
  });
  if (bundle.create.packetSha256 !== base.sha256)
    return fail('StonkFun create packet differs.');
  const payerNeed =
    BigInt(base.summary.solCostLamports) +
    (wrapped ? BigInt(base.summary.devBuyRaw) : 0n) +
    BigInt(tipLamports) +
    SIGNATURE_FEE;
  if (BigInt(payerBalance.value) < payerNeed)
    return fail(
      `The deployer needs ${payerNeed.toString()} lamports for the launch and Jito tip.`,
    );
  // Best effort: replay the whole unsigned bundle in order when the RPC supports it.
  let bundleSimulated = false;
  try {
    const replay = (await rpc(
      'simulateBundle',
      [
        {
          encodedTransactions: [
            base.transaction,
            ...bundle.packets.map((p) => p.transaction),
          ],
        },
        {
          transactionEncoding: 'base64',
          skipSigVerify: true,
          replaceRecentBlockhash: false,
          preExecutionAccountsConfigs: Array(bundle.packets.length + 1).fill(
            null,
          ),
          postExecutionAccountsConfigs: Array(bundle.packets.length + 1).fill(
            null,
          ),
        },
      ],
      signal,
    )) as { value?: { summary?: unknown } } | undefined;
    if (replay?.value?.summary === 'succeeded') bundleSimulated = true;
    else if (replay?.value?.summary)
      return fail('Bundle simulation rejected the holder buys.');
  } catch (error) {
    if (error instanceof StonkLaunchError) throw error;
  }
  const projectAfter = await ownedHolders(db, owner, t);
  if (projectAfter !== projectBefore)
    return fail('The project changed during review. Review again.');
  return {
    ...base,
    terms: { ...base.terms, holders, tipLamports },
    bundle: {
      format: 'stonkfun-holder-bundle-v1',
      sha256: bundle.sha256,
      tipAccount,
      tipLamports,
      holders: sized,
      packets: bundle.packets,
      holdersBuyRaw: totalBuy.toString(),
      holdersTokensOutRaw: totalOut.toString(),
      holdersSupplyBps: Number((totalOut * 10000n) / supply),
      bundleSimulated,
    },
  };
}
