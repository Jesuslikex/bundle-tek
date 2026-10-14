import bs58 from 'bs58';
import {
  getBase64Encoder,
  getBase64Decoder,
  getTransactionDecoder,
  getCompiledTransactionMessageDecoder,
} from '@solana/kit';
import type { CounterBuyPreparation } from './counter-buy-preparation';
import { assessCounterBuySimulationBalances } from './counter-buy-simulation-balances';
import { reviewUnsignedSwapEnvelope } from './unsigned-swap-order';
import { reviewSwapInstructions } from './swap-instruction-review';
import { assessJupiterExactOutRoute } from './jupiter-exact-out-assessment';
import {
  readSwapLookupAccounts,
  assertSameSwapLookups,
} from './swap-lookup-accounts';
import { balanceRpc, SOLANA_MAINNET_GENESIS } from './wallet-balances';
import {
  getSolanaIndexerRpcEndpoint,
  requireConsistentSolanaSlots,
} from './solana-rpc';
import { walletAddress } from './wallet-workspace';
import { WRAPPED_SOL } from './warmup-swap-quote';

const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  TOKEN2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
  SYSTEM = '11111111111111111111111111111111';
export type CounterSimulationRpc = (
  method: string,
  params: unknown[],
  signal: AbortSignal,
) => Promise<unknown>;
const uint = (value: unknown) => {
  if (
    typeof value !== 'string' ||
    !/^(0|[1-9]\d{0,19})$/.test(value) ||
    BigInt(value) > (1n << 64n) - 1n
  )
    throw new Error('Invalid Counter RPC integer.');
  return BigInt(value);
};
const slot = (value: unknown) => {
  const n = Number(uint(value));
  if (!Number.isSafeInteger(n)) throw new Error('Invalid Counter RPC slot.');
  return n;
};
type Account = {
  owner: string;
  executable: boolean;
  lamports: string;
  data: [string, 'base64'];
} | null;
function account(value: unknown): Account {
  if (value === null) return null;
  const a = value as Account;
  if (
    !a ||
    typeof a.executable !== 'boolean' ||
    !Array.isArray(a.data) ||
    a.data.length !== 2 ||
    a.data[1] !== 'base64' ||
    typeof a.data[0] !== 'string' ||
    a.data[0].length > 1048576
  )
    throw new Error('Invalid Counter account response.');
  walletAddress(a.owner, 'Solana');
  uint(a.lamports);
  if (btoa(atob(a.data[0])) !== a.data[0])
    throw new Error('Noncanonical Counter account bytes.');
  return {
    owner: a.owner,
    executable: a.executable,
    lamports: a.lamports,
    data: a.data,
  };
}
const bytes = (a: NonNullable<Account>) =>
  Uint8Array.from(atob(a.data[0]), (c) => c.charCodeAt(0));
function token(a: Account) {
  if (!a) return null;
  if (a.owner === TOKEN2022)
    throw new Error('Counter Token-2022 extension review is unavailable.');
  if (a.owner !== TOKEN) return null;
  const b = bytes(a);
  if (b.length === 82) return null;
  if (a.executable || b.length !== 165)
    throw new Error('Unsupported Counter token account layout.');
  const v = new DataView(b.buffer),
    option = (offset: number) => {
      const n = v.getUint32(offset, true);
      if (n > 1) throw new Error('Invalid Counter token option.');
      return n === 1;
    };
  const delegate = option(72),
    native = option(109),
    close = option(129);
  if (b[108] !== 1)
    throw new Error('Uninitialized or frozen Counter token account.');
  return {
    mint: bs58.encode(b.slice(0, 32)),
    owner: bs58.encode(b.slice(32, 64)),
    amount: v.getBigUint64(64, true).toString(),
    delegate,
    delegated: v.getBigUint64(121, true),
    closeAuthority: close ? bs58.encode(b.slice(133, 165)) : null,
    nativeReserve: native ? v.getBigUint64(113, true) : null,
  };
}
function mint(a: Account) {
  if (!a || a.owner !== TOKEN || a.executable)
    throw new Error('Counter mint program or extensions are unsupported.');
  const b = bytes(a),
    v = new DataView(b.buffer);
  if (
    b.length !== 82 ||
    b[45] !== 1 ||
    v.getUint32(0, true) > 1 ||
    v.getUint32(46, true) > 1
  )
    throw new Error('Invalid Counter mint layout.');
  return b[44];
}
async function digest(a: Account) {
  const data = new TextEncoder().encode(JSON.stringify(a));
  return Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', data)),
    (b) => b.toString(16).padStart(2, '0'),
  ).join('');
}

/** Read-only original-packet simulation with explicit chain and simulated account snapshots. */
export async function simulateCounterBuyPreparation(
  value: CounterBuyPreparation,
  reviewedFeeAndRentLimitRaw: string,
  signal: AbortSignal,
  suppliedRpc?: CounterSimulationRpc,
  fetcher: typeof fetch = fetch,
) {
  const order = structuredClone(value),
    deadline = AbortSignal.any([signal, AbortSignal.timeout(25000)]);
  uint(reviewedFeeAndRentLimitRaw);
  if (
    !Number.isFinite(Date.parse(order.expiresAt)) ||
    Date.parse(order.expiresAt) <= Date.now() ||
    !Number.isSafeInteger(order.quote.contextSlot) ||
    order.quote.contextSlot < 0
  )
    throw new Error('Counter preparation expired before simulation.');
  const envelope = await reviewUnsignedSwapEnvelope(
    order.preparation.transaction,
    order.preparation.wallet,
  );
  if (envelope.sha256 !== order.preparation.sha256)
    throw new Error('Counter simulation packet changed.');
  const message = getCompiledTransactionMessageDecoder().decode(
    getTransactionDecoder().decode(
      getBase64Encoder().encode(envelope.transaction),
    ).messageBytes,
  );
  if (message.version !== 0)
    throw new Error('Unsupported Counter simulation version.');
  let provider = suppliedRpc;
  if (!provider) {
    const endpoint = getSolanaIndexerRpcEndpoint(),
      url = new URL(endpoint);
    if (url.protocol !== 'https:' || url.username || url.password)
      throw new Error('Invalid Counter simulation RPC configuration.');
    provider = (method, params, s) =>
      balanceRpc(endpoint, method, params, s, fetcher, 2097152);
  }
  const rpc: CounterSimulationRpc = (method, params, s) =>
    new Promise((resolve, reject) => {
      const abort = () =>
        reject(new Error('Counter simulation was cancelled.'));
      if (s.aborted) {
        abort();
        return;
      }
      s.addEventListener('abort', abort, { once: true });
      Promise.resolve()
        .then(() => provider!(method, params, s))
        .then(resolve, () =>
          reject(new Error('Counter simulation RPC read unavailable.')),
        )
        .finally(() => s.removeEventListener('abort', abort));
    });
  const call = (method: string, params: unknown[]) =>
    rpc(method, params, deadline);
  if ((await call('getGenesisHash', [])) !== SOLANA_MAINNET_GENESIS)
    throw new Error('Wrong Counter simulation network.');
  const height = uint(
    await call('getBlockHeight', [{ commitment: 'confirmed' }]),
  );
  if (height > uint(order.preparation.lastValidBlockHeight))
    throw new Error('Counter packet blockhash expired.');
  const transaction = getTransactionDecoder().decode(
    getBase64Encoder().encode(envelope.transaction),
  );
  const fee = (await call('getFeeForMessage', [
    getBase64Decoder().decode(transaction.messageBytes),
    { commitment: 'confirmed', minContextSlot: order.quote.contextSlot },
  ])) as { context?: { slot?: unknown }; value?: unknown };
  const feeSlot = slot(fee.context?.slot),
    networkFee = uint(fee.value);
  requireConsistentSolanaSlots([order.quote.contextSlot, feeSlot]);
  if (networkFee === 0n || networkFee > uint(reviewedFeeAndRentLimitRaw))
    throw new Error('Counter network fee exceeds its separate allowance.');
  const lookup = await readSwapLookupAccounts(message, feeSlot, call);
  if (order.preparation.lookupAccounts)
    assertSameSwapLookups(order.preparation.lookupAccounts, lookup, null);
  else if (lookup) throw new Error('Missing retained Counter lookup evidence.');
  const keys = [
    ...message.staticAccounts.map(String),
    ...(lookup?.writable ?? []),
    ...(lookup?.readonly ?? []),
  ];
  if (
    keys.length !== envelope.accountCount ||
    new Set(keys).size !== keys.length
  )
    throw new Error('Counter simulation key mapping differs.');
  const review = reviewSwapInstructions(message, lookup ?? undefined),
    route = assessJupiterExactOutRoute(review, {
      swapMode: 'ExactOut',
      wallet: envelope.wallet,
      inputMint: order.quote.inputMint,
      outputMint: order.quote.outputMint,
      quotedInputRaw: order.quote.requiredSolInputRaw,
      outputTargetRaw: order.quote.outputTargetRaw,
      maximumInputRaw: order.quote.maximumSolInputRaw,
      reviewedInputBudgetRaw: order.quote.reviewedSolBudgetRaw,
      slippageBps: order.quote.slippageBps,
    });
  if (route.status !== 'Matched fields')
    throw new Error('Counter simulation route differs.');
  const routeCall = review.instructions.find(
    (i) => i.program.address === 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
  )!;
  const source = routeCall.accounts[3].address,
    destination = routeCall.accounts[6].address;
  const slots = [
    order.quote.contextSlot,
    feeSlot,
    ...(lookup ? [lookup.observedSlot] : []),
  ];
  async function snapshot(addresses: string[], minimum: number) {
    const values: Account[] = [];
    for (let offset = 0; offset < addresses.length; offset += 100) {
      const result = (await call('getMultipleAccounts', [
        addresses.slice(offset, offset + 100),
        {
          encoding: 'base64',
          commitment: 'confirmed',
          minContextSlot: minimum,
        },
      ])) as { context?: { slot?: unknown }; value?: unknown[] };
      const observed = slot(result.context?.slot);
      slots.push(observed);
      requireConsistentSolanaSlots(slots);
      if (
        observed < minimum ||
        !Array.isArray(result.value) ||
        result.value.length !== Math.min(100, addresses.length - offset)
      )
        throw new Error('Counter account snapshot differs.');
      values.push(...result.value.map(account));
    }
    return values;
  }
  const before = await snapshot(keys, Math.max(...slots));
  if (
    !before[0] ||
    before[0].owner !== SYSTEM ||
    before[0].executable ||
    before[0].data[0] !== ''
  )
    throw new Error('Counter signer is not a system wallet.');
  if (
    uint(before[0].lamports) <
    uint(order.quote.maximumSolInputRaw) + uint(reviewedFeeAndRentLimitRaw)
  )
    throw new Error(
      'Counter wallet cannot cover protected input and fee/rent allowance.',
    );
  const preTokens = before.map(token),
    mintKeys = [
      ...new Set([
        WRAPPED_SOL,
        order.quote.outputMint,
        ...preTokens.filter((t) => t !== null).map((t) => t.mint),
      ]),
    ];
  const mintAccounts = await snapshot(mintKeys, Math.max(...slots)),
    precisions = new Map(
      mintKeys.map((key, i) => [key, mint(mintAccounts[i])]),
    );
  if (
    precisions.get(WRAPPED_SOL) !== 9 ||
    precisions.get(order.quote.outputMint) !== order.tokenDecimals
  )
    throw new Error('Counter mint precision changed.');
  function balances(accounts: Account[]) {
    return accounts.flatMap((a, index) => {
      const t = token(a);
      if (!t) return [];
      const decimals = precisions.get(t.mint);
      if (decimals === undefined)
        throw new Error('Unexpected Counter simulated mint.');
      if (
        t.owner === envelope.wallet &&
        (t.delegate ||
          t.delegated !== 0n ||
          (t.closeAuthority !== null && t.closeAuthority !== envelope.wallet))
      )
        throw new Error('Unsupported Counter wallet token authority.');
      if (
        t.mint === WRAPPED_SOL &&
        (t.nativeReserve === null ||
          uint(a!.lamports) < BigInt(t.amount) + t.nativeReserve)
      )
        throw new Error('Counter WSOL reserve differs.');
      return [
        {
          accountIndex: String(index),
          mint: t.mint,
          owner: t.owner,
          programId: TOKEN,
          uiTokenAmount: { amount: t.amount, decimals: String(decimals) },
        },
      ];
    });
  }
  for (const [key, expected] of [
    [source, WRAPPED_SOL],
    [destination, order.quote.outputMint],
  ]) {
    const t = preTokens[keys.indexOf(key)];
    if (t && (t.owner !== envelope.wallet || t.mint !== expected))
      throw new Error('Counter route account owner or mint differs.');
  }
  const preTokenBalances = balances(before);
  const result = (await call('simulateTransaction', [
    envelope.transaction,
    {
      encoding: 'base64',
      commitment: 'confirmed',
      sigVerify: false,
      replaceRecentBlockhash: false,
      minContextSlot: Math.max(...slots),
      accounts: { encoding: 'base64', addresses: keys },
      innerInstructions: false,
    },
  ])) as {
    context?: { slot?: unknown };
    value?: {
      err?: unknown;
      unitsConsumed?: unknown;
      accounts?: unknown[];
      replacementBlockhash?: unknown;
      fee?: unknown;
      loadedAddresses?: unknown;
    };
  };
  const simulationSlot = slot(result.context?.slot),
    sim = result.value;
  slots.push(simulationSlot);
  requireConsistentSolanaSlots(slots);
  if (
    !sim ||
    sim.err === undefined ||
    simulationSlot < Math.max(...slots.filter((s) => s !== simulationSlot)) ||
    sim.replacementBlockhash != null ||
    (sim.fee != null && uint(sim.fee) !== networkFee)
  )
    throw new Error('Counter simulation context or fee changed.');
  let post: Account[] | undefined;
  if (sim.err === null) {
    if (!Array.isArray(sim.accounts) || sim.accounts.length !== keys.length)
      throw new Error('Missing Counter post-simulation accounts.');
    post = sim.accounts.map(account);
    if (
      !post[0] ||
      post[0].owner !== SYSTEM ||
      post[0].executable ||
      post[0].data[0] !== ''
    )
      throw new Error('Counter simulated wallet authority changed.');
    for (let i = 0; i < mintKeys.length; i++) {
      const index = keys.indexOf(mintKeys[i]);
      if (
        index >= 0 &&
        (await digest(post[index])) !== (await digest(mintAccounts[i]))
      )
        throw new Error('Counter simulation changed a mint account.');
    }
    const destinationAccount = token(post[keys.indexOf(destination)]);
    if (
      !destinationAccount ||
      destinationAccount.owner !== envelope.wallet ||
      destinationAccount.mint !== order.quote.outputMint
    )
      throw new Error('Counter simulated destination owner or mint differs.');
  }
  const afterLookup = await readSwapLookupAccounts(
    message,
    simulationSlot,
    call,
  );
  if (lookup) {
    assertSameSwapLookups(lookup, afterLookup, sim.loadedAddresses);
    slots.push(afterLookup!.observedSlot);
    requireConsistentSolanaSlots(slots);
  }
  const stableKeys = [
    ...new Set([
      envelope.wallet,
      source,
      destination,
      ...preTokens.flatMap((t, i) =>
        t?.owner === envelope.wallet ? [keys[i]] : [],
      ),
      ...mintKeys,
    ]),
  ];
  const stable = await snapshot(stableKeys, Math.max(...slots));
  const original = new Map([
    ...keys.map((key, i) => [key, before[i]] as const),
    ...mintKeys.map((key, i) => [key, mintAccounts[i]] as const),
  ]);
  const hashes = [];
  for (let i = 0; i < stableKeys.length; i++) {
    const sha256 = await digest(original.get(stableKeys[i])!);
    if (sha256 !== (await digest(stable[i])))
      throw new Error('Counter wallet or mint changed during simulation.');
    hashes.push({ address: stableKeys[i], sha256 });
  }
  if (deadline.aborted) throw new Error('Counter simulation was cancelled.');
  const observedAt = new Date().toISOString(),
    balanceAssessment = await assessCounterBuySimulationBalances(
      order,
      {
        sha256: envelope.sha256,
        observedAt,
        simulationSlot: String(simulationSlot),
        feeSlot: String(feeSlot),
        networkFeeLamports: networkFee.toString(),
        err: sim.err,
        unitsConsumed: uint(sim.unitsConsumed ?? '0').toString(),
        loadedAddresses: lookup
          ? { writable: lookup.writable, readonly: lookup.readonly }
          : sim.loadedAddresses,
        preBalances: before.map((a) => a?.lamports ?? '0'),
        postBalances: post?.map((a) => a?.lamports ?? '0'),
        preTokenBalances,
        postTokenBalances: post ? balances(post) : undefined,
      },
      reviewedFeeAndRentLimitRaw,
    );
  if (deadline.aborted) throw new Error('Counter simulation was cancelled.');
  return {
    format: 'counter-buy-simulation-v1' as const,
    executionAllowed: false as const,
    instructionsVerified: false as const,
    sha256: envelope.sha256,
    network: 'Solana mainnet' as const,
    observedAt,
    expiresAt: order.expiresAt,
    slots,
    originalBlockhashRetained: true as const,
    accountSnapshotHashes: hashes,
    balanceAssessment,
    limitations:
      'Read-only original-packet simulation and checked account snapshots. Busy pool accounts are not assumed unchanged. Gross debits, wrapping instructions, fee/rent sources, fresh project/source/ownership admission and durable proposal reservation still require verification before explicit approval. No signing clearance.',
  };
}
