import bs58 from 'bs58';
import {
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
} from '@solana/kit';
import { balanceRpc, SOLANA_MAINNET_GENESIS } from './wallet-balances';
import { prepareSolanaSwap, refreshPacketBlockhash } from './warmup-swap-quote';
import { simulateImportedSwap } from './imported-swap-simulation';
import { formatNativeBalance } from './wallet-balance-format';
import { readSwapLookupAccounts } from './swap-lookup-accounts';
import {
  getSolanaRpcEndpoint,
  requireConsistentSolanaSlots,
} from './solana-rpc';
import {
  CLEANUP_LIFETIME_MS,
  CLEANUP_MAX_CLOSE,
  CLEANUP_MAX_SELLS_PER_WALLET,
  CLEANUP_MAX_SKIPPED,
  CLEANUP_SIGNATURE_FEE_LAMPORTS,
  SYSTEM_PROGRAM,
  SYSTEM_RENT_EXEMPT_LAMPORTS,
  TOKEN_2022_PROGRAM,
  TOKEN_PROGRAM,
  WRAPPED_SOL_MINT,
  appendSettlementTransfer,
  cleanupMessage,
  encode,
  inspectWalletCleanup,
  sha,
  uint,
  type CleanupClose,
  type CleanupSkipped,
  type CleanupTokenProgram,
  type WalletCleanupFailure,
  type WalletCleanupBuyReceipt,
  type WalletCleanupBuyReview,
  type WalletCleanupReceipt,
  type WalletCleanupReview,
  type WalletCleanupSellReceipt,
  type WalletCleanupSellReview,
} from './wallet-cleanup';

type Rpc = (method: string, params: unknown[]) => Promise<unknown>;
type RawAccount = {
  lamports: string;
  owner: string;
  executable: boolean;
  data: [string, string];
};
const MAX_TOKEN_ACCOUNTS = 200;
// Token-2022 account extensions that do not block CloseAccount when the
// account balance (and any withheld transfer fee) is zero.
const CLOSE_SAFE_EXTENSIONS = new Set([2, 7, 8, 11, 13, 15]);
const slot = (value: unknown) => {
  const n = Number(uint(value));
  if (!Number.isSafeInteger(n)) throw new Error('Invalid cleanup slot.');
  return n;
};
const bytesOf = (account: RawAccount) => {
  if (!Array.isArray(account?.data) || account.data[1] !== 'base64')
    throw new Error('Cleanup account encoding differs.');
  return Uint8Array.from(atob(account.data[0]), (c) => c.charCodeAt(0));
};

/** Pure classification of one owned token account for cleanup. */
export function classifyCleanupAccount(
  address: string,
  program: CleanupTokenProgram,
  account: RawAccount,
  wallet: string,
): { close: CleanupClose } | { skipped: CleanupSkipped } {
  if (account.owner !== program || account.executable !== false)
    throw new Error('Cleanup token account owner differs.');
  const data = bytesOf(account);
  if (data.length < 165 || (program === TOKEN_PROGRAM && data.length !== 165))
    throw new Error('Cleanup token account layout differs.');
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const mint = bs58.encode(data.slice(0, 32)),
    owner = bs58.encode(data.slice(32, 64)),
    amount = view.getBigUint64(64, true),
    state = data[108],
    native = view.getUint32(109, true) === 1,
    closeAuthority =
      view.getUint32(129, true) === 1
        ? bs58.encode(data.slice(133, 165))
        : null;
  if (owner !== wallet) throw new Error('Cleanup token account owner differs.');
  const lamports = uint(account.lamports);
  const skip = (reason: CleanupSkipped['reason']) => ({
    skipped: { address, program, mint, amountRaw: amount.toString(), reason },
  });
  if (state === 2) return skip('frozen');
  if (state !== 1) throw new Error('Uninitialized cleanup token account.');
  if (closeAuthority !== null && closeAuthority !== wallet)
    return skip('foreign-close-authority');
  if (amount !== 0n && !native) return skip('holds-tokens');
  if (data.length > 165) {
    if (program !== TOKEN_2022_PROGRAM || data[165] !== 2)
      throw new Error('Cleanup token extension layout differs.');
    for (let offset = 166; offset < data.length;) {
      if (data.slice(offset).every((b) => b === 0)) break;
      if (offset + 4 > data.length)
        throw new Error('Truncated cleanup token extension.');
      const type = view.getUint16(offset, true),
        length = view.getUint16(offset + 2, true),
        end = offset + 4 + length;
      if (end > data.length)
        throw new Error('Truncated cleanup token extension.');
      if (!CLOSE_SAFE_EXTENSIONS.has(type))
        return skip('unsupported-extension');
      if (
        type === 2 &&
        (length !== 8 || view.getBigUint64(offset + 4, true) !== 0n)
      )
        return skip('withheld-fees');
      offset = end;
    }
  }
  if (native && mint !== WRAPPED_SOL_MINT)
    throw new Error('Native token account mint differs.');
  if (lamports === 0n) throw new Error('Cleanup token account has no rent.');
  return {
    close: {
      address,
      program,
      mint,
      lamports: lamports.toString(),
      kind: native ? 'wrapped-sol' : 'empty',
    },
  };
}

/** Pure sweep arithmetic: everything except the kept balance and the fee. */
export function cleanupSweep(
  walletLamports: bigint,
  keepLamports: bigint,
  feeLamports: bigint,
) {
  if (walletLamports < feeLamports)
    throw new Error('Wallet cannot pay the cleanup network fee.');
  const available = walletLamports - feeLamports;
  if (keepLamports >= available) return { keep: available, sweep: 0n };
  return { keep: keepLamports, sweep: available - keepLamports };
}

async function scanTokenAccounts(
  rpc: Rpc,
  wallet: string,
  minContextSlot?: number,
) {
  const close: CleanupClose[] = [],
    skipped: CleanupSkipped[] = [],
    slots: number[] = [];
  for (const program of [TOKEN_PROGRAM, TOKEN_2022_PROGRAM] as const) {
    const result = (await rpc('getTokenAccountsByOwner', [
      wallet,
      { programId: program },
      {
        encoding: 'base64',
        commitment: 'finalized',
        ...(minContextSlot === undefined ? {} : { minContextSlot }),
      },
    ])) as {
      context: { slot: string };
      value: { pubkey: string; account: RawAccount }[];
    };
    if (
      !Array.isArray(result?.value) ||
      result.value.length > MAX_TOKEN_ACCOUNTS
    )
      throw new Error('Cleanup token accounts unavailable or too many.');
    slots.push(slot(result.context.slot));
    for (const entry of result.value) {
      const outcome = classifyCleanupAccount(
        entry.pubkey,
        program,
        entry.account,
        wallet,
      );
      if ('close' in outcome) {
        if (close.length < CLEANUP_MAX_CLOSE) close.push(outcome.close);
        else
          skipped.push({
            address: outcome.close.address,
            program,
            mint: outcome.close.mint,
            amountRaw: '0',
            reason: 'over-limit',
          });
      } else skipped.push(outcome.skipped);
    }
  }
  close.sort((a, b) => (a.address < b.address ? -1 : 1));
  return { close, skipped, slots };
}

async function systemAccounts(
  rpc: Rpc,
  addresses: string[],
  minContextSlot?: number,
) {
  const result = (await rpc('getMultipleAccounts', [
    addresses,
    {
      encoding: 'base64',
      commitment: 'finalized',
      ...(minContextSlot === undefined ? {} : { minContextSlot }),
    },
  ])) as { context: { slot: string }; value: (RawAccount | null)[] };
  if (!Array.isArray(result?.value) || result.value.length !== addresses.length)
    throw new Error('Cleanup wallet accounts unavailable.');
  for (const account of result.value)
    if (
      account &&
      (account.owner !== SYSTEM_PROGRAM ||
        account.executable !== false ||
        account.data?.[0] !== '' ||
        account.data?.[1] !== 'base64')
    )
      throw new Error('Use ordinary system wallets without account data.');
  return {
    slot: slot(result.context.slot),
    lamports: result.value.map((a) => (a ? uint(a.lamports) : 0n)),
  };
}

async function simulate(
  rpc: Rpc,
  transaction: string,
  addresses: string[],
  minContextSlot: number,
) {
  const result = (await rpc('simulateTransaction', [
    transaction,
    {
      encoding: 'base64',
      commitment: 'finalized',
      sigVerify: false,
      replaceRecentBlockhash: false,
      minContextSlot,
      accounts: { encoding: 'base64', addresses },
    },
  ])) as {
    context: { slot: string };
    value: { err: unknown; accounts?: ({ lamports: string } | null)[] | null };
  };
  if (result?.value?.err !== null)
    throw new Error('Cleanup simulation failed.');
  const accounts = result.value.accounts;
  if (!Array.isArray(accounts) || accounts.length !== addresses.length)
    throw new Error('Cleanup simulation post-state unavailable.');
  return {
    slot: slot(result.context.slot),
    lamports: accounts.map((a) => (a ? uint(a.lamports) : 0n)),
  };
}

function expectSettlement(
  review: WalletCleanupReview,
  post: bigint[],
  feeCharged: bigint,
) {
  const keep = uint(review.keepLamports),
    received = uint(review.reclaimLamports) + uint(review.sweepLamports),
    unusedFee = uint(review.feeLamports) - feeCharged;
  if (
    post[0] !== keep + unusedFee ||
    post[1] !== uint(review.destinationLamports) + received ||
    post.slice(2).some((l) => l !== 0n)
  )
    throw new Error('Cleanup settlement differs from its review.');
}

export function cleanupRpc(signal: AbortSignal, fetcher: typeof fetch = fetch) {
  const endpoint = getSolanaRpcEndpoint('mainnet');
  return {
    source: new URL(endpoint).hostname,
    rpc: (method: string, params: unknown[]) =>
      balanceRpc(endpoint, method, params, signal, fetcher),
  };
}

export async function prepareWalletCleanup(
  input: {
    batchId: string;
    wallet: string;
    walletRevision: number;
    destination: string;
    keepLamports: bigint;
  },
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<WalletCleanupReview | null> {
  const { rpc, source } = cleanupRpc(signal, fetcher);
  if ((await rpc('getGenesisHash', [])) !== SOLANA_MAINNET_GENESIS)
    throw new Error('Cleanup network differs.');
  const latest = (await rpc('getLatestBlockhash', [
    { commitment: 'finalized' },
  ])) as {
    context: { slot: string };
    value: { blockhash: string; lastValidBlockHeight: string };
  };
  const floor = slot(latest.context.slot);
  const scan = await scanTokenAccounts(rpc, input.wallet, floor);
  const balances = await systemAccounts(
    rpc,
    [input.wallet, input.destination],
    floor,
  );
  const [walletLamports, destinationLamports] = balances.lamports;
  let { keep, sweep } = cleanupSweep(
    walletLamports,
    input.keepLamports,
    CLEANUP_SIGNATURE_FEE_LAMPORTS,
  );
  // A kept balance below the rent minimum would fail; sweep it all instead.
  if (keep !== 0n && keep < SYSTEM_RENT_EXEMPT_LAMPORTS) {
    sweep += keep;
    keep = 0n;
  }
  if (!scan.close.length && sweep === 0n) return null;
  const reclaim = scan.close.reduce((sum, c) => sum + uint(c.lamports), 0n);
  if (destinationLamports + reclaim + sweep < SYSTEM_RENT_EXEMPT_LAMPORTS)
    throw new Error('Destination would stay below the rent minimum.');
  const message = cleanupMessage({
    wallet: input.wallet,
    destination: input.destination,
    blockhash: latest.value.blockhash,
    close: scan.close,
    sweepLamports: sweep,
  });
  const fee = (await rpc('getFeeForMessage', [
    encode(message),
    { commitment: 'finalized', minContextSlot: floor },
  ])) as { context: { slot: string }; value: string | null };
  if (fee.value === null || uint(fee.value) !== CLEANUP_SIGNATURE_FEE_LAMPORTS)
    throw new Error('Cleanup network fee differs from one signature.');
  const unsigned = Uint8Array.from([1, ...new Uint8Array(64), ...message]);
  const preparedAt = new Date();
  const review: WalletCleanupReview = {
    format: 'wallet-cleanup-v1',
    id: crypto.randomUUID(),
    batchId: input.batchId,
    network: 'mainnet',
    wallet: input.wallet,
    walletRevision: input.walletRevision,
    destination: input.destination,
    walletLamports: walletLamports.toString(),
    destinationLamports: destinationLamports.toString(),
    keepLamports: keep.toString(),
    sweepLamports: sweep.toString(),
    feeLamports: CLEANUP_SIGNATURE_FEE_LAMPORTS.toString(),
    reclaimLamports: reclaim.toString(),
    close: scan.close,
    skipped: scan.skipped.slice(0, CLEANUP_MAX_SKIPPED),
    skippedCount: scan.skipped.length,
    blockhash: latest.value.blockhash,
    lastValidBlockHeight: uint(latest.value.lastValidBlockHeight).toString(),
    slot: floor,
    transaction: encode(unsigned),
    sha256: await sha(unsigned),
    preparedAt: preparedAt.toISOString(),
    expiresAt: new Date(
      preparedAt.getTime() + CLEANUP_LIFETIME_MS,
    ).toISOString(),
    source,
  };
  await inspectWalletCleanup(review, review.transaction, false);
  const addresses = [
    review.wallet,
    review.destination,
    ...review.close.map((c) => c.address),
  ];
  const sim = await simulate(rpc, review.transaction, addresses, floor);
  expectSettlement(review, sim.lamports, uint(review.feeLamports));
  requireConsistentSolanaSlots([
    floor,
    ...scan.slots,
    balances.slot,
    slot(fee.context.slot),
    sim.slot,
  ]);
  signal.throwIfAborted();
  return review;
}

/** Fresh pre-submission check: unchanged balances/accounts, live blockhash, passing simulation. */
export async function recheckWalletCleanup(
  review: WalletCleanupReview,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
) {
  await inspectWalletCleanup(review, review.transaction, false);
  if (Date.parse(review.expiresAt) <= Date.now())
    throw new Error('Cleanup approval expired.');
  const { rpc } = cleanupRpc(signal, fetcher);
  if ((await rpc('getGenesisHash', [])) !== SOLANA_MAINNET_GENESIS)
    throw new Error('Cleanup network differs.');
  const scan = await scanTokenAccounts(rpc, review.wallet, review.slot);
  const fresh = new Map(scan.close.map((c) => [c.address, c]));
  for (const c of review.close) {
    const now = fresh.get(c.address);
    if (!now || now.lamports !== c.lamports || now.program !== c.program)
      throw new Error('Cleanup token accounts changed. Prepare again.');
  }
  const balances = await systemAccounts(
    rpc,
    [review.wallet, review.destination],
    review.slot,
  );
  if (balances.lamports[0] !== uint(review.walletLamports))
    throw new Error('Wallet SOL balance changed. Prepare the cleanup again.');
  const addresses = [
    review.wallet,
    review.destination,
    ...review.close.map((c) => c.address),
  ];
  const sim = await simulate(rpc, review.transaction, addresses, review.slot);
  if (
    sim.lamports[0] !== uint(review.keepLamports) ||
    sim.lamports.slice(2).some((l) => l !== 0n) ||
    sim.lamports[1] - balances.lamports[1] !==
      uint(review.reclaimLamports) + uint(review.sweepLamports)
  )
    throw new Error('Cleanup simulation differs from its review.');
  const valid = (await rpc('isBlockhashValid', [
    review.blockhash,
    { commitment: 'finalized', minContextSlot: review.slot },
  ])) as { context: { slot: string }; value: boolean };
  const slots = [
    ...scan.slots,
    balances.slot,
    sim.slot,
    slot(valid.context.slot),
  ];
  if (slots.some((s) => s < review.slot))
    throw new Error('Cleanup checks returned a stale context slot.');
  requireConsistentSolanaSlots(slots);
  if (
    valid.value !== true ||
    uint(await rpc('getBlockHeight', [{ commitment: 'finalized' }])) >=
      uint(review.lastValidBlockHeight) ||
    Date.parse(review.expiresAt) <= Date.now()
  )
    throw new Error('Cleanup blockhash or approval expired.');
  signal.throwIfAborted();
}

export async function decodeWalletCleanupReceipt(
  raw: unknown,
  review: WalletCleanupReview,
  signature: string,
  source: string,
): Promise<WalletCleanupReceipt | WalletCleanupFailure> {
  const result = raw as {
    slot: string;
    blockTime: string | null;
    version: 'legacy';
    transaction: [string, string];
    meta: {
      err: unknown;
      fee: string;
      preBalances: string[];
      postBalances: string[];
    };
  };
  if (
    !result ||
    result.version !== 'legacy' ||
    !Array.isArray(result.transaction) ||
    result.transaction[1] !== 'base64' ||
    !result.meta ||
    result.meta.err === undefined ||
    slot(result.slot) < review.slot
  )
    throw new Error('Finalized cleanup receipt unavailable.');
  const signed = await inspectWalletCleanup(
    review,
    result.transaction[0],
    true,
  );
  if (signed.signature !== signature)
    throw new Error('Finalized cleanup signature differs.');
  const fee = uint(result.meta.fee);
  if (fee > uint(review.feeLamports))
    throw new Error('Finalized cleanup fee differs.');
  if (result.meta.err !== null)
    return {
      failed: true,
      signature,
      error: JSON.stringify(result.meta.err).slice(0, 512),
      networkFeeLamports: fee.toString(),
      slot: slot(result.slot),
      observedAt: new Date().toISOString(),
    };
  const programs = new Set(review.close.map((c) => c.program)).size,
    keys =
      2 +
      review.close.length +
      programs +
      (uint(review.sweepLamports) > 0n ? 1 : 0);
  const pre = result.meta.preBalances?.map(uint),
    post = result.meta.postBalances?.map(uint);
  if (!pre || !post || pre.length !== keys || post.length !== keys)
    throw new Error('Cleanup receipt account balances differ.');
  const walletChange = post[0] - pre[0],
    destinationChange = post[1] - pre[1];
  if (
    destinationChange !==
      uint(review.reclaimLamports) + uint(review.sweepLamports) ||
    walletChange !== -(uint(review.sweepLamports) + fee) ||
    post.slice(2, 2 + review.close.length).some((l) => l !== 0n)
  )
    throw new Error('Finalized cleanup settlement differs.');
  return {
    network: 'mainnet',
    commitment: 'finalized',
    signatureVerified: true,
    signature,
    wallet: review.wallet,
    destination: review.destination,
    networkFeeLamports: fee.toString(),
    walletChangeLamports: walletChange.toString(),
    destinationChangeLamports: destinationChange.toString(),
    closedAccounts: review.close.length,
    slot: slot(result.slot),
    blockTime: result.blockTime === null ? null : slot(result.blockTime),
    sha256: review.sha256,
    observedAt: new Date().toISOString(),
    source,
  };
}

type SellDependencies = {
  prepare: typeof prepareSolanaSwap;
  simulate: typeof simulateImportedSwap;
};
const defaultSell: SellDependencies = {
  prepare: prepareSolanaSwap,
  simulate: simulateImportedSwap,
};

/**
 * Jupiter sells of whole token balances to native SOL, one unsigned packet per
 * holding. Each packet must simulate successfully, sell from the scanned
 * account and deliver at least its minimum output in native SOL.
 */
export async function prepareWalletCleanupSells(
  input: {
    batchId: string;
    wallet: string;
    walletRevision: number;
    destination: string;
  },
  apiKey: string | undefined,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
  deps: SellDependencies = defaultSell,
) {
  const { rpc } = cleanupRpc(signal, fetcher);
  if ((await rpc('getGenesisHash', [])) !== SOLANA_MAINNET_GENESIS)
    throw new Error('Cleanup network differs.');
  const scan = await scanTokenAccounts(rpc, input.wallet);
  const seen = new Set<string>();
  const holdings = scan.skipped.filter(
    (s) =>
      s.reason === 'holds-tokens' &&
      s.mint !== WRAPPED_SOL_MINT &&
      !seen.has(s.mint) &&
      seen.add(s.mint),
  );
  const chosen = holdings.slice(0, CLEANUP_MAX_SELLS_PER_WALLET);
  const sells: WalletCleanupSellReview[] = [],
    errors: { mint: string; error: string }[] = [];
  if (!chosen.length) return { sells, errors, remaining: 0 };
  const mints = (await rpc('getMultipleAccounts', [
    chosen.map((h) => h.mint),
    { encoding: 'base64', commitment: 'finalized' },
  ])) as { value: (RawAccount | null)[] };
  if (!Array.isArray(mints?.value) || mints.value.length !== chosen.length)
    throw new Error('Cleanup mint accounts unavailable.');
  for (const [index, holding] of chosen.entries()) {
    try {
      const mint = mints.value[index];
      if (!mint || mint.owner !== holding.program)
        throw new Error('Token mint unavailable.');
      const data = bytesOf(mint);
      if (data.length < 82 || data[45] !== 1)
        throw new Error('Token mint layout differs.');
      const decimals = data[44];
      const order = await deps.prepare(
        {
          tokenMint: holding.mint,
          side: 'Sell',
          amount: formatNativeBalance(holding.amountRaw, decimals),
          decimals,
          wallet: input.wallet,
        },
        apiKey,
        signal,
        fetcher,
      );
      if (
        order.inAmount !== holding.amountRaw ||
        order.inputMint !== holding.mint ||
        order.outputMint !== WRAPPED_SOL_MINT
      )
        throw new Error('Sell order differs from the token balance.');
      // The sell must hand its proceeds to the paired buyer, so the packet
      // carries a System transfer of the swap's own minimum output. An
      // underdelivering swap then reverts the whole transaction.
      const transfer = BigInt(order.minimumOutAmount);
      // Resolve the packet's lookup tables so the transfer can reference an
      // account that is already loaded instead of adding a duplicate.
      const loaded = { writable: [] as string[], readonly: [] as string[] };
      const packetMessage = getCompiledTransactionMessageDecoder().decode(
        getTransactionDecoder().decode(
          getBase64Encoder().encode(order.preparation.transaction),
        ).messageBytes,
      );
      if (
        packetMessage.version === 0 &&
        (packetMessage.addressTableLookups ?? []).length
      ) {
        const observed = await readSwapLookupAccounts(
          packetMessage,
          Number(await rpc('getSlot', [{ commitment: 'confirmed' }])),
          rpc,
        );
        if (observed) {
          loaded.writable.push(...observed.writable);
          loaded.readonly.push(...observed.readonly);
        }
      }
      const packet = process.env.CLEANUP_NO_TRANSFER
        ? order.preparation.transaction
        : appendSettlementTransfer(
            order.preparation.transaction,
            input.destination,
            transfer,
            loaded,
          );
      const fundedCount = getCompiledTransactionMessageDecoder().decode(
        getTransactionDecoder().decode(getBase64Encoder().encode(packet))
          .messageBytes,
      ).staticAccounts.length;
      const funded = {
        ...order,
        preparation: {
          ...order.preparation,
          accountCount: fundedCount,
          transaction: packet,
          sha256: await sha(Buffer.from(packet, 'base64')),
        },
      };
      const sim = await deps.simulate(funded, signal, fetcher, true);
      const native =
        sim.nativeChangeRaw === null ? null : BigInt(sim.nativeChangeRaw);
      if (
        !sim.succeeded ||
        sim.routeAssessment.status !== 'Matched fields' ||
        sim.routeAssessment.decoded?.sourceAccount !== holding.address ||
        sim.inputAmountMatches !== true ||
        native === null ||
        // The wrapped-SOL account rent stays locked on the seller, so the
        // delivered amount is measured with a rent allowance on top.
        native + transfer + uint(sim.networkFeeLamports) + 2_100_000n <
          uint(order.minimumOutAmount)
      ) {
        console.error('sell guard', {
          ok: sim.succeeded,
          route: sim.routeAssessment.status,
          src: sim.routeAssessment.decoded?.sourceAccount,
          holding: holding.address,
          input: sim.inputAmountMatches,
          native: sim.nativeChangeRaw,
          transfer: String(transfer),
          min: order.minimumOutAmount,
          fee: sim.networkFeeLamports,
        });
        throw new Error('Sell simulation did not deliver the reviewed SOL.');
      }
      const refreshed = await refreshPacketBlockhash(packet, signal, fetcher);
      const finalPacket = refreshed?.transaction ?? packet;
      const finalSha = refreshed
        ? await sha(Buffer.from(finalPacket, 'base64'))
        : funded.preparation.sha256;
      const preparedAt = new Date();
      const expiresAt = Math.min(
        Date.parse(order.expiresAt),
        preparedAt.getTime() + CLEANUP_LIFETIME_MS,
      );
      const review: WalletCleanupSellReview = {
        format: 'wallet-cleanup-sell-v1',
        id: crypto.randomUUID(),
        batchId: input.batchId,
        network: 'mainnet',
        wallet: input.wallet,
        walletRevision: input.walletRevision,
        destination: input.destination,
        mint: holding.mint,
        decimals,
        sourceAccount: holding.address,
        amountRaw: holding.amountRaw,
        expectedOutLamports: order.outAmount,
        minimumOutLamports: order.minimumOutAmount,
        transferLamports: transfer.toString(),
        router: order.router,
        priceImpactPct:
          'priceImpactPct' in order && typeof order.priceImpactPct === 'string'
            ? order.priceImpactPct
            : null,
        networkFeeLamports: sim.networkFeeLamports,
        simulatedNativeChangeLamports: native.toString(),
        lastValidBlockHeight:
          refreshed?.lastValidBlockHeight ?? order.preparation.lastValidBlockHeight,
        slot: sim.simulationSlot,
        transaction: finalPacket,
        sha256: finalSha,
        preparedAt: preparedAt.toISOString(),
        expiresAt: new Date(expiresAt).toISOString(),
        source: sim.source,
      };
      await inspectWalletCleanup(review, review.transaction, false);
      sells.push(review);
    } catch (error) {
      console.error('cleanup sell failed', error);
      errors.push({
        mint: holding.mint,
        error:
          error instanceof Error && /^[\w .,'()-]{1,160}$/.test(error.message)
            ? error.message
            : 'Sell route unavailable.',
      });
    }
  }
  signal.throwIfAborted();
  return { sells, errors, remaining: holdings.length - chosen.length };
}

/** Fresh pre-submission check for a reviewed sell: live blockhash and passing simulation. */
export async function recheckWalletCleanupSell(
  review: WalletCleanupSellReview,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
) {
  await inspectWalletCleanup(review, review.transaction, false);
  if (Date.parse(review.expiresAt) <= Date.now())
    throw new Error('Cleanup sell quote expired. Prepare again.');
  const { rpc } = cleanupRpc(signal, fetcher);
  if ((await rpc('getGenesisHash', [])) !== SOLANA_MAINNET_GENESIS)
    throw new Error('Cleanup network differs.');
  if (
    uint(await rpc('getBlockHeight', [{ commitment: 'confirmed' }])) >=
    uint(review.lastValidBlockHeight)
  )
    throw new Error('Cleanup sell blockhash expired.');
  const sim = (await rpc('simulateTransaction', [
    review.transaction,
    {
      encoding: 'base64',
      commitment: 'confirmed',
      sigVerify: false,
      replaceRecentBlockhash: false,
      minContextSlot: review.slot,
    },
  ])) as { context: { slot: string }; value: { err: unknown } };
  if (sim?.value?.err !== null || slot(sim.context.slot) < review.slot)
    throw new Error('Cleanup sell simulation failed.');
  signal.throwIfAborted();
}

export async function decodeWalletCleanupSellReceipt(
  raw: unknown,
  review: WalletCleanupSellReview,
  signature: string,
  source: string,
): Promise<WalletCleanupSellReceipt | WalletCleanupFailure> {
  type TokenBalance = {
    mint: string;
    owner?: string;
    uiTokenAmount: { amount: string };
  };
  const result = raw as {
    slot: string;
    blockTime: string | null;
    version: string | number;
    transaction: [string, string];
    meta: {
      err: unknown;
      fee: string;
      preBalances: string[];
      postBalances: string[];
      preTokenBalances?: TokenBalance[];
      postTokenBalances?: TokenBalance[];
    };
  };
  if (
    !result ||
    !['0', 0].includes(result.version) ||
    !Array.isArray(result.transaction) ||
    result.transaction[1] !== 'base64' ||
    !result.meta ||
    result.meta.err === undefined ||
    slot(result.slot) < review.slot
  )
    throw new Error('Finalized cleanup sell receipt unavailable.');
  const signed = await inspectWalletCleanup(
    review,
    result.transaction[0],
    true,
  );
  if (signed.signature !== signature)
    throw new Error('Finalized cleanup signature differs.');
  const fee = uint(result.meta.fee);
  if (fee > uint(review.networkFeeLamports))
    throw new Error('Finalized cleanup sell fee differs.');
  if (result.meta.err !== null)
    return {
      failed: true,
      signature,
      error: JSON.stringify(result.meta.err).slice(0, 512),
      networkFeeLamports: fee.toString(),
      slot: slot(result.slot),
      observedAt: new Date().toISOString(),
    };
  const owned = (list: TokenBalance[] | undefined) => {
    if (!Array.isArray(list))
      throw new Error('Cleanup sell token balances unavailable.');
    return list
      .filter((b) => b.mint === review.mint && b.owner === review.wallet)
      .reduce((sum, b) => sum + uint(b.uiTokenAmount?.amount), 0n);
  };
  const sold =
    owned(result.meta.preTokenBalances) - owned(result.meta.postTokenBalances);
  const pre = result.meta.preBalances?.map(uint),
    post = result.meta.postBalances?.map(uint);
  if (!pre?.length || !post?.length || pre.length !== post.length)
    throw new Error('Cleanup sell receipt balances differ.');
  if (sold !== uint(review.amountRaw))
    throw new Error('Finalized cleanup sell amount differs.');
  return {
    kind: 'sell',
    network: 'mainnet',
    commitment: 'finalized',
    signatureVerified: true,
    signature,
    wallet: review.wallet,
    mint: review.mint,
    soldRaw: sold.toString(),
    deliveredLamports: review.transferLamports,
    nativeChangeLamports: (post[0] - pre[0]).toString(),
    networkFeeLamports: fee.toString(),
    slot: slot(result.slot),
    blockTime: result.blockTime === null ? null : slot(result.blockTime),
    sha256: review.sha256,
    observedAt: new Date().toISOString(),
    source,
  };
}

/**
 * Jupiter buy-back on the paired buyer wallet, funded by the SOL its sell
 * delivered. Only prepared after the sell finalizes, because the buyer has no
 * SOL before that. The packet must simulate successfully and spend no more than
 * the reviewed lamports.
 */
export async function prepareWalletCleanupBuy(
  input: {
    batchId: string;
    wallet: string;
    walletRevision: number;
    mint: string;
    lamports: bigint;
  },
  apiKey: string | undefined,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
  deps: SellDependencies = defaultSell,
) {
  if (input.lamports <= 0n) throw new Error('Cleanup buy has no SOL to spend.');
  const { rpc } = cleanupRpc(signal, fetcher);
  if ((await rpc('getGenesisHash', [])) !== SOLANA_MAINNET_GENESIS)
    throw new Error('Cleanup network differs.');
  const account = (await rpc('getMultipleAccounts', [
    [input.mint],
    { encoding: 'base64', commitment: 'finalized' },
  ])) as { value: (RawAccount | null)[] } | null;
  const mint = account?.value?.[0];
  if (
    !mint ||
    (mint.owner !== TOKEN_PROGRAM && mint.owner !== TOKEN_2022_PROGRAM)
  )
    throw new Error('Token mint unavailable.');
  const data = bytesOf(mint);
  if (data.length < 82 || data[45] !== 1)
    throw new Error('Token mint layout differs.');
  const decimals = data[44];
  const order = await deps.prepare(
    {
      tokenMint: input.mint,
      side: 'Buy',
      amount: formatNativeBalance(input.lamports.toString(), 9),
      decimals: 9,
      wallet: input.wallet,
    },
    apiKey,
    signal,
    fetcher,
  );
  if (
    order.inAmount !== input.lamports.toString() ||
    order.inputMint !== WRAPPED_SOL_MINT ||
    order.outputMint !== input.mint
  )
    throw new Error('Buy order differs from the delivered SOL.');
  const sim = await deps.simulate(order, signal, fetcher, true);
  const native = sim.nativeChangeRaw === null ? null : BigInt(sim.nativeChangeRaw);
  if (
    !sim.succeeded ||
    native === null ||
    native >= 0n ||
    // Router shapes (DFlow) can leave the decoded assessment unavailable, and
    // wrapped-SOL rent stays locked, so bound the spend instead of matching it.
    -native >
      input.lamports +
        2_100_000n +
        uint(sim.networkFeeLamports) +
        uint(order.preparation.estimatedFeesLamports)
  )
    throw new Error('Buy simulation did not spend the reviewed SOL.');
  const refreshed = await refreshPacketBlockhash(
    order.preparation.transaction,
    signal,
    fetcher,
  );
  const packet = refreshed?.transaction ?? order.preparation.transaction;
  const preparedAt = new Date();
  const expiresAt = Math.min(
    Date.parse(order.expiresAt),
    preparedAt.getTime() + CLEANUP_LIFETIME_MS,
  );
  const review: WalletCleanupBuyReview = {
    format: 'wallet-cleanup-buy-v1',
    id: crypto.randomUUID(),
    batchId: input.batchId,
    network: 'mainnet',
    wallet: input.wallet,
    walletRevision: input.walletRevision,
    destination: input.mint,
    mint: input.mint,
    decimals,
    amountInLamports: input.lamports.toString(),
    expectedOutRaw: order.outAmount,
    minimumOutRaw: order.minimumOutAmount,
    router: order.router,
    priceImpactPct:
      'priceImpactPct' in order && typeof order.priceImpactPct === 'string'
        ? order.priceImpactPct
        : null,
    networkFeeLamports: sim.networkFeeLamports,
    simulatedNativeChangeLamports: native.toString(),
    lastValidBlockHeight:
      refreshed?.lastValidBlockHeight ?? order.preparation.lastValidBlockHeight,
    slot: sim.simulationSlot,
    transaction: packet,
    sha256: refreshed
      ? await sha(Buffer.from(packet, 'base64'))
      : order.preparation.sha256,
    preparedAt: preparedAt.toISOString(),
    expiresAt: new Date(expiresAt).toISOString(),
    source: sim.source,
  };
  await inspectWalletCleanup(review, review.transaction, false);
  return review;
}

/** Fresh pre-submission check for a reviewed buy: live blockhash and passing simulation. */
export async function recheckWalletCleanupBuy(
  review: WalletCleanupBuyReview,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
) {
  await inspectWalletCleanup(review, review.transaction, false);
  if (Date.parse(review.expiresAt) <= Date.now())
    throw new Error('Cleanup buy quote expired. Prepare again.');
  const { rpc } = cleanupRpc(signal, fetcher);
  if ((await rpc('getGenesisHash', [])) !== SOLANA_MAINNET_GENESIS)
    throw new Error('Cleanup network differs.');
  if (
    uint(await rpc('getBlockHeight', [{ commitment: 'confirmed' }])) >=
    uint(review.lastValidBlockHeight)
  )
    throw new Error('Cleanup buy blockhash expired.');
  const sim = (await rpc('simulateTransaction', [
    review.transaction,
    {
      encoding: 'base64',
      commitment: 'confirmed',
      sigVerify: false,
      replaceRecentBlockhash: false,
      minContextSlot: review.slot,
    },
  ])) as { context: { slot: string }; value: { err: unknown } };
  if (sim?.value?.err !== null || slot(sim.context.slot) < review.slot)
    throw new Error('Cleanup buy simulation failed.');
  signal.throwIfAborted();
}

export async function decodeWalletCleanupBuyReceipt(
  raw: unknown,
  review: WalletCleanupBuyReview,
  signature: string,
  source: string,
): Promise<WalletCleanupBuyReceipt | WalletCleanupFailure> {
  type TokenBalance = {
    mint: string;
    owner?: string;
    uiTokenAmount: { amount: string };
  };
  const result = raw as {
    slot: string;
    blockTime: string | null;
    version: string | number;
    transaction: [string, string];
    meta: {
      err: unknown;
      fee: string;
      preBalances: string[];
      postBalances: string[];
      preTokenBalances?: TokenBalance[];
      postTokenBalances?: TokenBalance[];
    };
  };
  if (
    !result ||
    !['0', 0].includes(result.version) ||
    !Array.isArray(result.transaction) ||
    result.transaction[1] !== 'base64' ||
    !result.meta ||
    result.meta.err === undefined ||
    slot(result.slot) < review.slot
  )
    throw new Error('Finalized cleanup buy receipt unavailable.');
  const signed = await inspectWalletCleanup(review, result.transaction[0], true);
  if (signed.signature !== signature)
    throw new Error('Finalized cleanup signature differs.');
  const fee = uint(result.meta.fee);
  if (fee > uint(review.networkFeeLamports))
    throw new Error('Finalized cleanup buy fee differs.');
  if (result.meta.err !== null)
    return {
      failed: true,
      signature,
      error: JSON.stringify(result.meta.err).slice(0, 512),
      networkFeeLamports: fee.toString(),
      slot: slot(result.slot),
      observedAt: new Date().toISOString(),
    };
  const owned = (list: TokenBalance[] | undefined) => {
    if (!Array.isArray(list))
      throw new Error('Cleanup buy token balances unavailable.');
    return list
      .filter((b) => b.mint === review.mint && b.owner === review.wallet)
      .reduce((sum, b) => sum + uint(b.uiTokenAmount?.amount), 0n);
  };
  const bought =
    owned(result.meta.postTokenBalances) - owned(result.meta.preTokenBalances);
  if (bought < uint(review.minimumOutRaw))
    throw new Error('Finalized cleanup buy delivered less than the minimum.');
  const pre = result.meta.preBalances?.map(uint),
    post = result.meta.postBalances?.map(uint);
  if (!pre?.length || !post?.length || pre.length !== post.length)
    throw new Error('Cleanup buy receipt balances differ.');
  return {
    kind: 'buy',
    network: 'mainnet',
    commitment: 'finalized',
    signatureVerified: true,
    signature,
    wallet: review.wallet,
    mint: review.mint,
    boughtRaw: bought.toString(),
    nativeChangeLamports: (post[0] - pre[0]).toString(),
    networkFeeLamports: fee.toString(),
    slot: slot(result.slot),
    blockTime: result.blockTime === null ? null : slot(result.blockTime),
    sha256: review.sha256,
    observedAt: new Date().toISOString(),
    source,
  };
}
