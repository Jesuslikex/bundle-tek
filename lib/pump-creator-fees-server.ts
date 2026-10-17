import { address } from '@solana/kit';
import bs58 from 'bs58';
import { balanceRpc, SOLANA_MAINNET_GENESIS } from './wallet-balances';
import {
  getSolanaRpcEndpoint,
  requireConsistentSolanaSlots,
} from './solana-rpc';
import { quoteCatalog } from './quote-catalog';
import {
  buildCreatorFeeClaimMessage,
  claimUint,
  creatorFeeAddresses,
  creatorFeeQuoteAddresses,
  encodeBase64,
  inspectCreatorFeeClaim,
  sha256Hex,
  vaultKey,
  wsolTokenVault,
  CLAIM_SYSTEM,
  CLAIM_TOKEN,
  CLAIM_TOKEN_2022,
  CLAIM_WSOL,
  type CreatorFeeClaimReview,
  type CreatorFeeVault,
} from './pump-creator-fees';

// Scanned by default: SOL, USDC and the featured stock quotes Bundle launches with.
export const DEFAULT_CLAIM_QUOTES = [
  CLAIM_WSOL,
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  'XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB',
  'Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh',
  'XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W',
];
/** Extra quote mints must be one of Pump.fun's listed quote assets. */
export function claimQuoteMints(extra?: unknown) {
  if (extra === undefined || extra === null || extra === '')
    return DEFAULT_CLAIM_QUOTES;
  const mint = typeof extra === 'string' ? address(extra) : null;
  if (
    !mint ||
    !quoteCatalog('Solana', 'PumpFun').assets.some((a) => a.address === mint)
  )
    throw new Error('Choose a quote asset Pump.fun lists.');
  return DEFAULT_CLAIM_QUOTES.includes(mint)
    ? DEFAULT_CLAIM_QUOTES
    : [...DEFAULT_CLAIM_QUOTES, mint];
}

type RpcAccount = {
  lamports: string;
  owner: string;
  executable: boolean;
  data: [string, string];
} | null;
type Rpc = (method: string, params: unknown[]) => Promise<unknown>;
const slotOf = (value: unknown) => {
  const n = Number(claimUint(value));
  if (!Number.isSafeInteger(n)) throw new Error('Invalid slot.');
  return n;
};
const accountBytes = (account: NonNullable<RpcAccount>) => {
  if (account.data?.[1] !== 'base64')
    throw new Error('Unexpected account encoding.');
  return Uint8Array.from(atob(account.data[0]), (c) => c.charCodeAt(0));
};
const u64 = (bytes: Uint8Array, offset: number) =>
  new DataView(bytes.buffer, bytes.byteOffset).getBigUint64(offset, true);
/** Initialized SPL/Token-2022 token account for the exact mint and owner, or null when absent. */
function tokenAccount(
  account: RpcAccount,
  program: string,
  mint: string,
  owner: string,
) {
  if (!account) return null;
  const bytes = accountBytes(account);
  if (
    account.owner !== program ||
    account.executable ||
    bytes.length < 165 ||
    (program === CLAIM_TOKEN && bytes.length !== 165) ||
    bs58.encode(bytes.slice(0, 32)) !== mint ||
    bs58.encode(bytes.slice(32, 64)) !== owner ||
    bytes[108] !== 1
  )
    throw new Error('Creator fee token account differs.');
  return { amount: u64(bytes, 64), lamports: claimUint(account.lamports) };
}
function rpcFor(signal: AbortSignal, fetcher: typeof fetch): Rpc {
  const endpoint = getSolanaRpcEndpoint('mainnet');
  return (method, params) =>
    balanceRpc(endpoint, method, params, signal, fetcher);
}
const many = async (rpc: Rpc, keys: string[], minContextSlot?: number) => {
  const result = (await rpc('getMultipleAccounts', [
    keys,
    {
      encoding: 'base64',
      commitment: 'confirmed',
      ...(minContextSlot ? { minContextSlot } : {}),
    },
  ])) as { context: { slot: string }; value: RpcAccount[] };
  if (!Array.isArray(result?.value) || result.value.length !== keys.length)
    throw new Error('Creator fee accounts unavailable.');
  return { slot: slotOf(result.context.slot), value: result.value };
};

export type CreatorFeeScan = {
  wallet: string;
  slot: number;
  vaults: CreatorFeeVault[];
  /** Receiving token accounts that do not exist yet, keyed by account. */
  missingAccounts: string[];
  accountRentLamports: string;
  observedAt: string;
  source: string;
};
/** Read-only: every creator vault for this wallet across the scanned quote mints. */
export async function scanCreatorFees(
  wallet: string,
  quotes: string[],
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<CreatorFeeScan> {
  const rpc = rpcFor(signal, fetcher);
  if ((await rpc('getGenesisHash', [])) !== SOLANA_MAINNET_GENESIS)
    throw new Error('Creator fee network differs.');
  const mints = await many(rpc, quotes);
  const quoteInfo = quotes.map((mint, i) => {
    const account = mints.value[i];
    if (!account) return null;
    const bytes = accountBytes(account);
    if (
      ![CLAIM_TOKEN, CLAIM_TOKEN_2022].includes(account.owner) ||
      bytes.length < 82 ||
      bytes[45] !== 1
    )
      throw new Error('Creator fee quote mint differs.');
    return { mint, tokenProgram: account.owner, decimals: bytes[44] };
  });
  const base = await creatorFeeAddresses(wallet);
  const derived = await Promise.all(
    quoteInfo.map(async (q) =>
      q
        ? {
            ...q,
            ...(await creatorFeeQuoteAddresses(wallet, {
              mint: q.mint,
              tokenProgram: q.tokenProgram,
            })),
          }
        : null,
    ),
  );
  const present = derived.filter((d) => d !== null);
  const keys = [
    wallet,
    base.pumpVault,
    ...present.flatMap((d) => [
      d.pumpTokenVault,
      d.ammTokenVault,
      d.destination,
    ]),
  ];
  const state = await many(rpc, keys, mints.slot);
  const [walletAccount, solVault] = state.value;
  if (walletAccount && walletAccount.owner !== CLAIM_SYSTEM)
    throw new Error('Choose an ordinary system wallet.');
  const [vaultRent, tokenRent] = await Promise.all([
    rpc('getMinimumBalanceForRentExemption', [0, { commitment: 'confirmed' }]),
    rpc('getMinimumBalanceForRentExemption', [
      165,
      { commitment: 'confirmed' },
    ]),
  ]);
  const vaults: CreatorFeeVault[] = [];
  if (solVault) {
    if (solVault.owner !== CLAIM_SYSTEM || solVault.executable)
      throw new Error('Creator SOL vault differs.');
    const claimable = claimUint(solVault.lamports) - claimUint(vaultRent);
    if (claimable > 0n)
      vaults.push({
        kind: 'pump-sol',
        quoteMint: CLAIM_WSOL,
        tokenProgram: null,
        decimals: 9,
        vault: base.pumpVault,
        destination: wallet,
        claimableRaw: claimable.toString(),
      });
  }
  const missingAccounts: string[] = [];
  present.forEach((d, i) => {
    const offset = 2 + i * 3;
    const pumpVault = tokenAccount(
        state.value[offset],
        d.tokenProgram,
        d.mint,
        base.pumpVault,
      ),
      ammVault = tokenAccount(
        state.value[offset + 1],
        d.tokenProgram,
        d.mint,
        base.ammAuthority,
      ),
      destination = tokenAccount(
        state.value[offset + 2],
        d.tokenProgram,
        d.mint,
        wallet,
      );
    if (!destination) missingAccounts.push(d.destination);
    const common = {
      quoteMint: d.mint,
      tokenProgram: d.tokenProgram,
      decimals: d.decimals,
      destination: d.destination,
    };
    if (d.mint !== CLAIM_WSOL && pumpVault && pumpVault.amount > 0n)
      vaults.push({
        kind: 'pump-token',
        ...common,
        vault: d.pumpTokenVault,
        claimableRaw: pumpVault.amount.toString(),
      });
    if (ammVault && ammVault.amount > 0n)
      vaults.push({
        kind: 'amm-token',
        ...common,
        vault: d.ammTokenVault,
        claimableRaw: ammVault.amount.toString(),
      });
  });
  return {
    wallet,
    slot: state.slot,
    vaults,
    missingAccounts,
    accountRentLamports: claimUint(tokenRent).toString(),
    observedAt: new Date().toISOString(),
    source: new URL(getSolanaRpcEndpoint('mainnet')).hostname,
  };
}

async function simulate(
  rpc: Rpc,
  transaction: string,
  wallet: string,
  receiving: string[],
  minContextSlot: number,
) {
  const sim = (await rpc('simulateTransaction', [
    transaction,
    {
      encoding: 'base64',
      commitment: 'confirmed',
      sigVerify: false,
      replaceRecentBlockhash: false,
      minContextSlot,
      accounts: { encoding: 'base64', addresses: [wallet, ...receiving] },
    },
  ])) as {
    context: { slot: string };
    value: { err: unknown; accounts: RpcAccount[] | null };
  };
  if (sim?.value?.err !== null)
    throw new Error('Creator fee claim simulation failed.');
  if (
    !Array.isArray(sim.value.accounts) ||
    sim.value.accounts.length !== receiving.length + 1 ||
    !sim.value.accounts[0]
  )
    throw new Error('Creator fee simulation accounts unavailable.');
  return { slot: slotOf(sim.context.slot), accounts: sim.value.accounts };
}
const tokenAmount = (
  account: RpcAccount,
  vault: CreatorFeeVault,
  wallet: string,
) =>
  tokenAccount(account, vault.tokenProgram!, vault.quoteMint, wallet)?.amount ??
  0n;

/** Builds and simulates one unsigned claim packet for the selected scanned vaults. */
export async function prepareCreatorFeeClaim(
  input: { wallet: string; walletRevision: number; select: string[] },
  quotes: string[],
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<CreatorFeeClaimReview> {
  const scan = await scanCreatorFees(input.wallet, quotes, signal, fetcher);
  const vaults = scan.vaults.filter((v) => input.select.includes(vaultKey(v)));
  if (!vaults.length || vaults.length !== new Set(input.select).size)
    throw new Error('Selected creator fees are no longer claimable.');
  const rpc = rpcFor(signal, fetcher);
  const latest = (await rpc('getLatestBlockhash', [
    { commitment: 'confirmed', minContextSlot: scan.slot },
  ])) as {
    context: { slot: string };
    value: { blockhash: string; lastValidBlockHeight: string };
  };
  const wsol = wsolTokenVault(vaults);
  const unwrapNative =
    !!wsol && scan.missingAccounts.includes(wsol.destination);
  const built = await buildCreatorFeeClaimMessage({
    wallet: input.wallet,
    vaults,
    unwrapNative,
    blockhash: latest.value.blockhash,
    lastValidBlockHeight: claimUint(latest.value.lastValidBlockHeight),
  });
  const newAccounts = built.receivingAccounts.filter((a) =>
    scan.missingAccounts.includes(a),
  );
  const keptRent =
    claimUint(scan.accountRentLamports) *
    BigInt(
      newAccounts.filter((a) => !(unwrapNative && a === wsol!.destination))
        .length,
    );
  const fee = (await rpc('getFeeForMessage', [
    encodeBase64(built.message),
    { commitment: 'confirmed', minContextSlot: scan.slot },
  ])) as { context: { slot: string }; value: string | null };
  if (fee.value === null)
    throw new Error('Creator fee network fee unavailable.');
  const unsigned = Uint8Array.from([
    1,
    ...new Uint8Array(64),
    ...built.message,
  ]);
  const transaction = encodeBase64(unsigned);
  const pre = await many(
    rpc,
    [input.wallet, ...built.receivingAccounts],
    scan.slot,
  );
  const sim = await simulate(
    rpc,
    transaction,
    input.wallet,
    built.receivingAccounts,
    scan.slot,
  );
  requireConsistentSolanaSlots([
    scan.slot,
    slotOf(latest.context.slot),
    slotOf(fee.context.slot),
    pre.slot,
    sim.slot,
  ]);
  const tokens = built.receivingAccounts.map((account, i) => {
    const vault = vaults.find((v) => v.destination === account)!;
    return {
      mint: vault.quoteMint,
      account,
      changeRaw: (
        tokenAmount(sim.accounts[i + 1], vault, input.wallet) -
        tokenAmount(pre.value[i + 1], vault, input.wallet)
      ).toString(),
    };
  });
  const now = Date.now();
  const review: CreatorFeeClaimReview = {
    format: 'pump-creator-fee-claim-v1',
    id: crypto.randomUUID(),
    network: 'mainnet',
    wallet: input.wallet,
    walletRevision: input.walletRevision,
    vaults,
    newAccounts,
    unwrapNative,
    feeLamports: claimUint(fee.value).toString(),
    accountRentLamports: keptRent.toString(),
    blockhash: latest.value.blockhash,
    lastValidBlockHeight: claimUint(
      latest.value.lastValidBlockHeight,
    ).toString(),
    slot: scan.slot,
    transaction,
    sha256: await sha256Hex(unsigned),
    preparedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 60000).toISOString(),
    source: scan.source,
    simulation: {
      walletChangeLamports: (
        claimUint(sim.accounts[0]!.lamports) -
        claimUint(pre.value[0]?.lamports ?? '0')
      ).toString(),
      tokens,
    },
  };
  // Simulation proves no unexpected wallet debit beyond the reviewed fee and kept rent.
  await inspectCreatorFeeClaim(review, review.transaction, false);
  return review;
}

/** Fresh checks right before the one submission attempt. Never re-signs or replaces. */
export async function recheckCreatorFeeClaim(
  review: CreatorFeeClaimReview,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
) {
  const inspected = await inspectCreatorFeeClaim(
    review,
    review.transaction,
    false,
  );
  if (Date.parse(review.expiresAt) <= Date.now())
    throw new Error('Creator fee approval expired.');
  const rpc = rpcFor(signal, fetcher);
  if ((await rpc('getGenesisHash', [])) !== SOLANA_MAINNET_GENESIS)
    throw new Error('Creator fee network differs.');
  const pre = await many(
    rpc,
    [review.wallet, ...inspected.receivingAccounts],
    review.slot,
  );
  // An unwrap closes the WSOL account, so it must still be the empty one this packet creates.
  const wsol = wsolTokenVault(review.vaults);
  if (
    review.unwrapNative &&
    pre.value[1 + inspected.receivingAccounts.indexOf(wsol!.destination)] !==
      null
  )
    throw new Error('WSOL receiving account appeared. Prepare a new claim.');
  const sim = await simulate(
    rpc,
    review.transaction,
    review.wallet,
    inspected.receivingAccounts,
    review.slot,
  );
  const walletChange =
    claimUint(sim.accounts[0]!.lamports) -
    claimUint(pre.value[0]?.lamports ?? '0');
  if (
    walletChange <
      -(
        claimUint(review.feeLamports) + claimUint(review.accountRentLamports)
      ) ||
    inspected.receivingAccounts.some((account, i) => {
      const vault = review.vaults.find((v) => v.destination === account)!;
      return (
        tokenAmount(sim.accounts[i + 1], vault, review.wallet) <
        tokenAmount(pre.value[i + 1], vault, review.wallet)
      );
    })
  )
    throw new Error('Creator fee claim would now debit the wallet.');
  const valid = (await rpc('isBlockhashValid', [
    review.blockhash,
    { commitment: 'confirmed', minContextSlot: review.slot },
  ])) as { context: { slot: string }; value: boolean };
  requireConsistentSolanaSlots([
    pre.slot,
    sim.slot,
    slotOf(valid.context.slot),
  ]);
  if (valid.value !== true || Date.parse(review.expiresAt) <= Date.now())
    throw new Error('Creator fee blockhash or approval expired.');
  signal.throwIfAborted();
}
