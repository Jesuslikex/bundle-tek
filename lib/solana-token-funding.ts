import bs58 from 'bs58';
import { address, isOffCurveAddress } from '@solana/kit';
import {
  findAssociatedTokenPda,
  TOKEN_PROGRAM_ADDRESS,
} from '@solana-program/token';
import { solanaTokenTransferMessage } from './solana-token-transfer-message';
export { solanaTokenTransferMessage } from './solana-token-transfer-message';
import { validateFunding } from './funding-plan';
import { chainQuoteAssets } from './quote-catalog';
import { balanceRpc, SOLANA_MAINNET_GENESIS } from './wallet-balances';
import {
  getSolanaRpcEndpoint,
  requireConsistentSolanaSlots,
} from './solana-rpc';
import { formatNativeBalance } from './wallet-balance-format';
import { SolanaFundingError } from './solana-funding-error';

const SYSTEM = '11111111111111111111111111111111';
const U64 = (1n << 64n) - 1n;
const base64 = (v: Uint8Array) => btoa(String.fromCharCode(...v));
const uint = (v: unknown) => {
  if (typeof v !== 'string' || !/^\d{1,20}$/.test(v) || BigInt(v) > U64)
    throw new SolanaFundingError('Invalid Solana provider integer.');
  return BigInt(v);
};
type Account = {
  owner: string;
  executable: boolean;
  lamports: string;
  data: [string, string];
} | null;
function bytes(account: Account, owner: string, length: number) {
  if (
    !account ||
    account.owner !== owner ||
    account.executable !== false ||
    !Array.isArray(account.data) ||
    account.data[1] !== 'base64' ||
    typeof account.data[0] !== 'string' ||
    account.data[0].length > 1024 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(account.data[0])
  )
    throw new SolanaFundingError(
      'Unsupported mint or token account. Use the standard SPL Token program.',
    );
  const value = Uint8Array.from(atob(account.data[0]), (c) => c.charCodeAt(0));
  if (value.length !== length)
    throw new SolanaFundingError(
      'Unsupported mint or token account data. Token extensions are not supported.',
    );
  return value;
}
export type SolanaTokenFundingBatch = Awaited<
  ReturnType<typeof prepareSolanaTokenFunding>
>;
function tokenAccount(account: Account, mint: string, owner: string) {
  const data = bytes(account, TOKEN_PROGRAM_ADDRESS, 165);
  if (
    bs58.encode(data.slice(0, 32)) !== mint ||
    bs58.encode(data.slice(32, 64)) !== owner ||
    data[108] !== 1
  )
    throw new SolanaFundingError(
      'Token account is frozen, uninitialized or does not match the mint and owner.',
    );
  const view = new DataView(data.buffer);
  for (const offset of [72, 109, 129])
    if (view.getUint32(offset, true) > 1)
      throw new SolanaFundingError('Invalid token account option.');
  if (
    (mint === 'So11111111111111111111111111111111111111112') !==
    (view.getUint32(109, true) === 1)
  )
    throw new SolanaFundingError(
      'Token account native-mint state is inconsistent.',
    );
  return view.getBigUint64(64, true);
}
export async function prepareSolanaTokenFunding(
  value: unknown,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
) {
  const document = validateFunding(value),
    started = Date.now();
  const asset = chainQuoteAssets('Solana').find(
    (a) => a.address === document.assetAddress,
  );
  if (
    document.chain !== 'Solana' ||
    !asset ||
    document.source !== 'Wallet' ||
    !document.funderAddress
  )
    throw new SolanaFundingError(
      'Choose an exact Solana token asset, wallet source and funder address.',
    );
  if (document.delaySeconds || Date.parse(document.startAt) > started)
    throw new SolanaFundingError(
      'Prepare an immediate draft with zero recipient delay.',
    );
  const funder = document.funderAddress,
    mint = asset.address;
  if (
    document.recipients.some((r) => r.address === funder) ||
    [funder, ...document.recipients.map((r) => r.address)].some(
      (a) => a === SYSTEM || isOffCurveAddress(address(a)),
    )
  )
    throw new SolanaFundingError(
      'Use distinct ordinary wallet public keys for the funder and recipients.',
    );
  const endpoint = getSolanaRpcEndpoint('mainnet');
  const rpc = (method: string, params: unknown[]) =>
    balanceRpc(endpoint, method, params, signal, fetcher);
  if ((await rpc('getGenesisHash', [])) !== SOLANA_MAINNET_GENESIS)
    throw new SolanaFundingError('Solana provider network mismatch.');
  const latest = (await rpc('getLatestBlockhash', [
    { commitment: 'finalized' },
  ])) as {
    context: { slot: string };
    value: { blockhash: string; lastValidBlockHeight: string };
  };
  const baseline = Number(uint(latest.context.slot));
  if (!Number.isSafeInteger(baseline))
    throw new SolanaFundingError('Invalid Solana context slot.');
  const slots = [baseline],
    checkContext = (value: { context: { slot: string } }) => {
      const s = Number(uint(value.context.slot));
      if (!Number.isSafeInteger(s) || s < baseline)
        throw new SolanaFundingError('Provider returned a stale context slot.');
      slots.push(s);
      requireConsistentSolanaSlots(slots);
    };
  const config = {
    commitment: 'finalized',
    encoding: 'base64',
    minContextSlot: baseline,
  };
  const getAccount = async (key: string) => {
    const response = (await rpc('getAccountInfo', [key, config])) as {
      context: { slot: string };
      value: Account;
    };
    checkContext(response);
    if (response.value === undefined)
      throw new SolanaFundingError('Incomplete account snapshot.');
    return response.value;
  };
  const mintData = bytes(await getAccount(mint), TOKEN_PROGRAM_ADDRESS, 82);
  const mintView = new DataView(mintData.buffer);
  if (
    mintData[45] !== 1 ||
    mintData[44] !== asset.decimals ||
    mintView.getUint32(0, true) > 1 ||
    mintView.getUint32(46, true) > 1
  )
    throw new SolanaFundingError(
      'Mint initialization or decimals do not match the saved asset.',
    );
  const funderAccount = await getAccount(funder);
  if (
    !funderAccount ||
    funderAccount.owner !== SYSTEM ||
    funderAccount.executable !== false ||
    funderAccount.data?.[0] !== '' ||
    funderAccount.data?.[1] !== 'base64'
  )
    throw new SolanaFundingError(
      'Funder must be an ordinary funded system wallet.',
    );
  const [sourceTokenAccount] = await findAssociatedTokenPda({
    owner: address(funder),
    mint: address(mint),
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  });
  const sourceAccount = await getAccount(sourceTokenAccount);
  const tokenBalance = tokenAccount(sourceAccount, mint, funder);
  const destinations = await Promise.all(
    document.recipients.map(
      async (r) =>
        (
          await findAssociatedTokenPda({
            owner: address(r.address),
            mint: address(mint),
            tokenProgram: TOKEN_PROGRAM_ADDRESS,
          })
        )[0],
    ),
  );
  const recipientSnapshot = (await rpc('getMultipleAccounts', [
    destinations,
    config,
  ])) as { context: { slot: string }; value: Account[] };
  checkContext(recipientSnapshot);
  if (
    !Array.isArray(recipientSnapshot.value) ||
    recipientSnapshot.value.length !== destinations.length ||
    recipientSnapshot.value.some((a) => a === undefined)
  )
    throw new SolanaFundingError('Incomplete token account snapshot.');
  const rentReserve = uint(
    await rpc('getMinimumBalanceForRentExemption', [
      0,
      { commitment: 'finalized' },
    ]),
  );
  const tokenRent = uint(
    await rpc('getMinimumBalanceForRentExemption', [
      165,
      { commitment: 'finalized' },
    ]),
  );
  if (uint(sourceAccount!.lamports) < tokenRent)
    throw new SolanaFundingError(
      'Source token account is below its rent minimum.',
    );
  const heightLimit = uint(latest.value.lastValidBlockHeight);
  let total = 0n,
    fees = 0n,
    accountRent = 0n;
  const transactions: Array<{
    recipient: string;
    amount: string;
    raw: string;
    sourceTokenAccount: string;
    destinationTokenAccount: string;
    createAccount: boolean;
    messageBase64: string;
    unsignedTransactionBase64: string;
    feeLamports: string;
    accountRentLamports: string;
  }> = [];
  for (const [i, r] of document.recipients.entries()) {
    const [whole, fraction = ''] = r.amount.split('.');
    const raw =
      BigInt(whole) * 10n ** BigInt(asset.decimals) +
      BigInt(fraction.padEnd(asset.decimals, '0') || '0');
    if (raw <= 0n || raw > U64)
      throw new SolanaFundingError(
        'Token amount exceeds the u64 transfer limit.',
      );
    total += raw;
    const existing = recipientSnapshot.value[i],
      createAccount = existing === null;
    if (
      existing &&
      (tokenAccount(existing, mint, r.address) + raw > U64 ||
        uint(existing.lamports) < tokenRent)
    )
      throw new SolanaFundingError(
        'Recipient token account balance or rent is unsupported.',
      );
    const { message, source, destination } = await solanaTokenTransferMessage({
      funder,
      recipient: r.address,
      mint,
      blockhash: latest.value.blockhash,
      lastValidBlockHeight: heightLimit,
      raw,
      decimals: asset.decimals,
      createAccount,
    });
    const messageBase64 = base64(message);
    const fee = (await rpc('getFeeForMessage', [
      messageBase64,
      { commitment: 'finalized', minContextSlot: baseline },
    ])) as { context: { slot: string }; value: string | null };
    checkContext(fee);
    if (fee.value === null)
      throw new SolanaFundingError(
        'Blockhash fee is unavailable. Prepare again.',
      );
    const cost = uint(fee.value),
      rent = createAccount ? tokenRent : 0n;
    fees += cost;
    accountRent += rent;
    transactions.push({
      recipient: r.address,
      amount: r.amount,
      raw: raw.toString(),
      sourceTokenAccount: source,
      destinationTokenAccount: destination,
      createAccount,
      messageBase64,
      unsignedTransactionBase64: base64(
        Uint8Array.from([1, ...new Uint8Array(64), ...message]),
      ),
      feeLamports: cost.toString(),
      accountRentLamports: rent.toString(),
    });
  }
  if (tokenBalance < total)
    throw new SolanaFundingError(
      'Source associated token account does not cover the total allocation.',
    );
  if (uint(funderAccount.lamports) < fees + accountRent + rentReserve)
    throw new SolanaFundingError(
      'Funder SOL does not cover quoted fees, new token accounts and rent reserve.',
    );
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(3, transactions.length) }, async () => {
      while (next < transactions.length) {
        const item = transactions[next++];
        const simulation = (await rpc('simulateTransaction', [
          item.unsignedTransactionBase64,
          {
            encoding: 'base64',
            commitment: 'finalized',
            sigVerify: false,
            replaceRecentBlockhash: false,
            minContextSlot: baseline,
          },
        ])) as { context: { slot: string }; value: { err: unknown } };
        checkContext(simulation);
        if (simulation.value?.err !== null)
          throw new SolanaFundingError('A token transfer simulation failed.');
      }
    }),
  );
  const valid = (await rpc('isBlockhashValid', [
    latest.value.blockhash,
    { commitment: 'finalized', minContextSlot: baseline },
  ])) as { context: { slot: string }; value: boolean };
  checkContext(valid);
  if (
    valid.value !== true ||
    uint(await rpc('getBlockHeight', [{ commitment: 'finalized' }])) >=
      heightLimit ||
    signal.aborted ||
    Date.now() >= started + 60000
  )
    throw new SolanaFundingError(
      'Funding blockhash or preparation has expired.',
    );
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify(document)),
  );
  return {
    format: 'pulseforge-solana-unsigned-token-funding-v1',
    executionAllowed: false as const,
    signed: false as const,
    chain: 'Solana',
    currency: asset.symbol,
    assetAddress: mint,
    decimals: asset.decimals,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
    funder,
    sourceTokenAccount,
    blockhash: latest.value.blockhash,
    lastValidBlockHeight: heightLimit.toString(),
    slot: Math.max(...slots),
    source: new URL(endpoint).hostname,
    preparedAt: new Date(started).toISOString(),
    expiresAt: new Date(started + 60000).toISOString(),
    draftHash: Array.from(new Uint8Array(digest), (b) =>
      b.toString(16).padStart(2, '0'),
    ).join(''),
    total: formatNativeBalance(total.toString(), asset.decimals),
    fees: formatNativeBalance(fees.toString(), 9),
    accountRent: formatNativeBalance(accountRent.toString(), 9),
    rentReserve: formatNativeBalance(rentReserve.toString(), 9),
    required: formatNativeBalance(
      (fees + accountRent + rentReserve).toString(),
      9,
    ),
    transactions,
    limitations:
      'Unsigned standard SPL Token transfers from the funder associated token account only. Missing recipient accounts use idempotent creation paid by the funder. Token-2022 extensions, multisig authorities, custom source accounts and priority fees are not supported. Transfers are independent, not atomic. Simulations do not reserve balances. No signing or sending. Recheck account states, balances and blockhash before signing.',
  };
}
