import { decodeWithdrawalFailure } from './withdrawal-failure-receipt';
import type { NativeWithdrawalFailureReceipt } from './withdrawal-failure';
import bs58 from 'bs58';
import {
  address,
  isOffCurveAddress,
  getCompiledTransactionMessageDecoder,
} from '@solana/kit';
import { TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import { getExtensionEncoder } from '@solana-program/token-2022';
import {
  TOKEN_2022,
  withdrawalTransferFee,
  type WithdrawalTransferFee,
} from './token-withdrawal-fee';
import {
  withdrawalExtensions,
  withdrawalTokenAccountSize,
} from './token-withdrawal-extensions';
import { solanaTokenTransferMessage } from './solana-token-transfer-message';
import { balanceRpc, SOLANA_MAINNET_GENESIS } from './wallet-balances';
import {
  getSolanaRpcEndpoint,
  requireConsistentSolanaSlots,
} from './solana-rpc';
import {
  inspectNativeWithdrawal,
  type NativeWithdrawalReview,
  type NativeWithdrawalReceipt,
  type tokenWithdrawalInput,
} from './native-withdrawal';
const SYSTEM = '11111111111111111111111111111111';
const uint = (v: unknown) => {
  if (
    typeof v !== 'string' ||
    !/^(0|[1-9]\d{0,19})$/.test(v) ||
    BigInt(v) > (1n << 64n) - 1n
  )
    throw new Error('Invalid withdrawal integer.');
  return BigInt(v);
};
const slot = (v: unknown) => {
  const n = Number(uint(v));
  if (!Number.isSafeInteger(n)) throw new Error('Invalid withdrawal slot.');
  return n;
};
const encode = (v: Uint8Array) => btoa(String.fromCharCode(...v));
const decode = (v: string) => Uint8Array.from(atob(v), (c) => c.charCodeAt(0));
type Account = {
  owner: string;
  executable: boolean;
  lamports: string;
  data: [string, string];
} | null;
function data(
  account: Account,
  size: number,
  program: string = TOKEN_PROGRAM_ADDRESS,
) {
  if (
    !account ||
    account.owner !== program ||
    account.executable !== false ||
    !Array.isArray(account.data) ||
    account.data[1] !== 'base64' ||
    typeof account.data[0] !== 'string' ||
    account.data[0].length > 21848 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      account.data[0],
    )
  )
    throw new Error('Token account program or encoding differs.');
  const bytes = decode(account.data[0]);
  if (bytes.length < size || encode(bytes) !== account.data[0])
    throw new Error('Token account extensions are unsupported.');
  uint(account.lamports);
  return bytes;
}
function balance(
  account: Account,
  mint: string,
  owner: string,
  program: string,
  fee: boolean,
) {
  const bytes = data(account, 165, program),
    view = new DataView(bytes.buffer);
  const extensions = withdrawalExtensions(bytes, program, false);
  if (extensions.some((e) => e.__kind === 'TransferFeeAmount') !== fee)
    throw new Error('Token account fee extension differs.');
  if (
    bs58.encode(bytes.slice(0, 32)) !== mint ||
    bs58.encode(bytes.slice(32, 64)) !== owner ||
    bytes[108] !== 1 ||
    view.getUint32(72, true) > 1 ||
    view.getUint32(109, true) !== 0 ||
    view.getUint32(129, true) > 1
  )
    throw new Error('Token account owner, mint or transferable state differs.');
  return view.getBigUint64(64, true);
}
async function accounts(
  review: NativeWithdrawalReview,
  rpc: (method: string, params: unknown[]) => Promise<unknown>,
  preparing = false,
) {
  const token = review.token;
  if (!token) throw new Error('Token withdrawal context required.');
  const result = (await rpc('getMultipleAccounts', [
    [review.wallet, token.mint, token.sourceAccount, token.destinationAccount],
    {
      encoding: 'base64',
      commitment: 'finalized',
      minContextSlot: review.slot,
    },
  ])) as { context: { slot: string }; value: Account[] };
  if (
    !Array.isArray(result.value) ||
    result.value.length !== 4 ||
    result.value.some((a) => a === undefined)
  )
    throw new Error('Incomplete token withdrawal accounts.');
  const [wallet, mint, source, destination] = result.value;
  if (
    !wallet ||
    wallet.owner !== SYSTEM ||
    wallet.executable !== false ||
    wallet.data?.[0] !== '' ||
    wallet.data?.[1] !== 'base64'
  )
    throw new Error('Ordinary funded source wallet required.');
  const mintData = data(mint, 82, token.program),
    view = new DataView(mintData.buffer);
  const extensions = withdrawalExtensions(mintData, token.program, true);
  const mintExtensions = extensions.map((e) => e.__kind).sort();
  const feeConfig = extensions.find((e) => e.__kind === 'TransferFeeConfig');
  let transferFee: WithdrawalTransferFee | undefined;
  if (feeConfig?.__kind === 'TransferFeeConfig') {
    const epochInfo = (await rpc('getEpochInfo', [
      { commitment: 'finalized', minContextSlot: review.slot },
    ])) as { epoch: string; absoluteSlot: string };
    const epoch = uint(epochInfo.epoch);
    const epochSlot = slot(epochInfo.absoluteSlot);
    if (epochSlot < review.slot)
      throw new Error('Stale token transfer fee epoch.');
    requireConsistentSolanaSlots([epochSlot, slot(result.context.slot)]);
    for (const schedule of [
      feeConfig.olderTransferFee,
      feeConfig.newerTransferFee,
    ])
      withdrawalTransferFee(
        uint(review.amountRaw),
        schedule.transferFeeBasisPoints,
        schedule.maximumFee,
      );
    const schedule =
      epoch >= feeConfig.newerTransferFee.epoch
        ? feeConfig.newerTransferFee
        : feeConfig.olderTransferFee;
    const feeRaw = withdrawalTransferFee(
      uint(review.amountRaw),
      schedule.transferFeeBasisPoints,
      schedule.maximumFee,
    );
    const net = uint(review.amountRaw) - feeRaw;
    if (net <= 0n)
      throw new Error('Token transfer fee leaves no recipient amount.');
    // Fee authority and both schedules are pinned; changing unrelated harvested balances does not invalidate approval.
    const configBytes = Uint8Array.from(
      getExtensionEncoder().encode({ ...feeConfig, withheldAmount: 0n }),
    );
    const configSha256 = Array.from(
      new Uint8Array(await crypto.subtle.digest('SHA-256', configBytes.buffer)),
      (b) => b.toString(16).padStart(2, '0'),
    ).join('');
    transferFee = {
      epoch: epoch.toString(),
      configSha256,
      basisPoints: schedule.transferFeeBasisPoints,
      maximumFeeRaw: schedule.maximumFee.toString(),
      feeRaw: feeRaw.toString(),
      netAmountRaw: net.toString(),
    };
  }
  if (
    !preparing &&
    token.program === TOKEN_2022 &&
    (JSON.stringify(token.mintExtensions) !== JSON.stringify(mintExtensions) ||
      JSON.stringify(token.transferFee) !== JSON.stringify(transferFee))
  )
    throw new Error('Token extension or transfer fee approval changed.');
  if (
    mintData[45] !== 1 ||
    mintData[44] !== token.decimals ||
    view.getUint32(0, true) > 1 ||
    view.getUint32(46, true) > 1
  )
    throw new Error('Mint precision or initialization differs.');
  if (
    balance(
      source,
      token.mint,
      review.wallet,
      token.program,
      Boolean(feeConfig),
    ) < uint(review.amountRaw)
  )
    throw new Error('Associated token account does not cover the withdrawal.');
  if (!destination && !token.createAccount)
    throw new Error('Reviewed destination token account is missing.');
  if (
    destination &&
    balance(
      destination,
      token.mint,
      review.recipient,
      token.program,
      Boolean(feeConfig),
    ) +
      uint(transferFee?.netAmountRaw ?? review.amountRaw) >
      (1n << 64n) - 1n
  )
    throw new Error('Destination balance exceeds token limits.');
  const [reserve, rent, sourceRent, destinationRent] = await Promise.all([
    rpc('getMinimumBalanceForRentExemption', [0, { commitment: 'finalized' }]),
    rpc('getMinimumBalanceForRentExemption', [
      token.program === TOKEN_2022
        ? withdrawalTokenAccountSize(Boolean(feeConfig))
        : 165,
      { commitment: 'finalized' },
    ]),
    rpc('getMinimumBalanceForRentExemption', [
      data(source, 165, token.program).length,
      { commitment: 'finalized' },
    ]),
    destination
      ? rpc('getMinimumBalanceForRentExemption', [
          data(destination, 165, token.program).length,
          { commitment: 'finalized' },
        ])
      : Promise.resolve('0'),
  ]);
  if (
    uint(source!.lamports) < uint(sourceRent) ||
    (destination && uint(destination.lamports) < uint(destinationRent))
  )
    throw new Error('Token account rent minimum differs.');
  return {
    wallet,
    destination,
    slot: slot(result.context.slot),
    reserve: uint(reserve),
    rent: uint(rent),
    mintExtensions,
    transferFee,
  };
}
export async function prepareTokenWithdrawal(
  input: ReturnType<typeof tokenWithdrawalInput>,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<NativeWithdrawalReview> {
  const started = Date.now();
  if (
    [input.wallet, input.recipient].some((k) => isOffCurveAddress(address(k)))
  )
    throw new Error('Ordinary wallet keys required.');
  const endpoint = getSolanaRpcEndpoint('mainnet'),
    rpc = (method: string, params: unknown[]) =>
      balanceRpc(endpoint, method, params, signal, fetcher);
  if ((await rpc('getGenesisHash', [])) !== SOLANA_MAINNET_GENESIS)
    throw new Error('Withdrawal network differs.');
  const mintInfo = (await rpc('getAccountInfo', [
    input.mint,
    { encoding: 'base64', commitment: 'finalized' },
  ])) as { context: { slot: string }; value: Account };
  const program = mintInfo.value?.owner;
  if (program !== TOKEN_PROGRAM_ADDRESS && program !== TOKEN_2022)
    throw new Error('Unsupported token mint program.');
  const latest = (await rpc('getLatestBlockhash', [
    { commitment: 'finalized' },
  ])) as {
    context: { slot: string };
    value: { blockhash: string; lastValidBlockHeight: string };
  };
  const packet = await solanaTokenTransferMessage({
    funder: input.wallet,
    recipient: input.recipient,
    mint: input.mint,
    decimals: input.decimals,
    raw: uint(input.amountRaw),
    blockhash: latest.value.blockhash,
    lastValidBlockHeight: uint(latest.value.lastValidBlockHeight),
    createAccount: true,
    tokenProgram: program,
  });
  const review: NativeWithdrawalReview = {
    id: crypto.randomUUID(),
    network: 'mainnet',
    wallet: input.wallet,
    walletRevision: input.walletRevision,
    recipient: input.recipient,
    amountRaw: input.amountRaw,
    amount: input.amount,
    feeLamports: '0',
    reserveLamports: '0',
    maximumDebitRaw: '0',
    blockhash: latest.value.blockhash,
    lastValidBlockHeight: latest.value.lastValidBlockHeight,
    slot: slot(latest.context.slot),
    transaction: '',
    sha256: '',
    preparedAt: new Date(started).toISOString(),
    expiresAt: new Date(started + 60000).toISOString(),
    source: new URL(endpoint).hostname,
    token: {
      mint: input.mint,
      decimals: input.decimals,
      program,
      sourceAccount: packet.source,
      destinationAccount: packet.destination,
      createAccount: true,
      accountRentLamports: '0',
    },
  };
  if (slot(mintInfo.context.slot) > review.slot)
    throw new Error('Token mint context is ahead of the blockhash.');
  requireConsistentSolanaSlots([slot(mintInfo.context.slot), review.slot]);
  const snapshot = await accounts(review, rpc, true);
  if (program === TOKEN_2022) {
    review.token!.mintExtensions = snapshot.mintExtensions;
    review.token!.transferFee = snapshot.transferFee;
  }
  review.token!.createAccount = snapshot.destination === null;
  review.token!.accountRentLamports = review.token!.createAccount
    ? snapshot.rent.toString()
    : '0';
  const actual = await solanaTokenTransferMessage({
    funder: input.wallet,
    recipient: input.recipient,
    mint: input.mint,
    decimals: input.decimals,
    raw: uint(input.amountRaw),
    blockhash: review.blockhash,
    lastValidBlockHeight: uint(review.lastValidBlockHeight),
    createAccount: review.token!.createAccount,
    tokenProgram: program,
    transferFee: snapshot.transferFee
      ? uint(snapshot.transferFee.feeRaw)
      : undefined,
  });
  review.transaction = encode(
    Uint8Array.from([1, ...new Uint8Array(64), ...actual.message]),
  );
  review.sha256 = Array.from(
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', decode(review.transaction).buffer),
    ),
    (b) => b.toString(16).padStart(2, '0'),
  ).join('');
  const fee = (await rpc('getFeeForMessage', [
    encode(actual.message),
    { commitment: 'finalized', minContextSlot: review.slot },
  ])) as { context: { slot: string }; value: string | null };
  if (fee.value === null) throw new Error('Token withdrawal fee unavailable.');
  review.feeLamports = uint(fee.value).toString();
  review.reserveLamports = snapshot.reserve.toString();
  review.maximumDebitRaw = (
    uint(review.feeLamports) + uint(review.token!.accountRentLamports)
  ).toString();
  const slots = [review.slot, snapshot.slot, slot(fee.context.slot)];
  if (slots.some((s) => s < review.slot))
    throw new Error('Stale token withdrawal accounts.');
  requireConsistentSolanaSlots(slots);
  await recheckTokenWithdrawal(review, signal, fetcher);
  return review;
}
export async function recheckTokenWithdrawal(
  review: NativeWithdrawalReview,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
) {
  await inspectNativeWithdrawal(review, review.transaction, false);
  if (!review.token || Date.parse(review.expiresAt) <= Date.now())
    throw new Error('Token withdrawal approval expired.');
  const endpoint = getSolanaRpcEndpoint('mainnet'),
    rpc = (method: string, params: unknown[]) =>
      balanceRpc(endpoint, method, params, signal, fetcher);
  if ((await rpc('getGenesisHash', [])) !== SOLANA_MAINNET_GENESIS)
    throw new Error('Token withdrawal network differs.');
  const snapshot = await accounts(review, rpc);
  if (
    snapshot.reserve > uint(review.reserveLamports) ||
    (!snapshot.destination &&
      snapshot.rent > uint(review.token.accountRentLamports)) ||
    uint(snapshot.wallet.lamports) <
      uint(review.maximumDebitRaw) + snapshot.reserve
  )
    throw new Error('SOL fee, rent or retained reserve coverage differs.');
  const { message } = await inspectNativeWithdrawal(
    review,
    review.transaction,
    false,
  );
  const fee = (await rpc('getFeeForMessage', [
    encode(message),
    { commitment: 'finalized', minContextSlot: review.slot },
  ])) as { context: { slot: string }; value: string | null };
  if (fee.value === null || uint(fee.value) > uint(review.feeLamports))
    throw new Error('Token withdrawal fee exceeds approval.');
  const simulation = (await rpc('simulateTransaction', [
    review.transaction,
    {
      encoding: 'base64',
      commitment: 'finalized',
      sigVerify: false,
      replaceRecentBlockhash: false,
      minContextSlot: review.slot,
    },
  ])) as { context: { slot: string }; value: { err: unknown } };
  if (simulation.value?.err !== null)
    throw new Error('Token withdrawal simulation failed.');
  const valid = (await rpc('isBlockhashValid', [
    review.blockhash,
    { commitment: 'finalized', minContextSlot: review.slot },
  ])) as { context: { slot: string }; value: boolean };
  const slots = [
    snapshot.slot,
    slot(fee.context.slot),
    slot(simulation.context.slot),
    slot(valid.context.slot),
  ];
  if (slots.some((s) => s < review.slot))
    throw new Error('Stale withdrawal context.');
  requireConsistentSolanaSlots(slots);
  if (
    valid.value !== true ||
    uint(await rpc('getBlockHeight', [{ commitment: 'finalized' }])) >=
      uint(review.lastValidBlockHeight) ||
    Date.parse(review.expiresAt) <= Date.now()
  )
    throw new Error('Token withdrawal blockhash expired.');
  signal.throwIfAborted();
}
export async function decodeTokenWithdrawalReceipt(
  raw: unknown,
  review: NativeWithdrawalReview,
  signature: string,
): Promise<NativeWithdrawalReceipt | NativeWithdrawalFailureReceipt> {
  if (!review.token) throw new Error('Token review required.');
  const token = review.token;
  const result = raw as {
    version: unknown;
    transaction: [string, string];
    slot: string;
    blockTime: string | null;
    meta: {
      err: unknown;
      fee: string;
      preBalances: string[];
      postBalances: string[];
      preTokenBalances: unknown[];
      postTokenBalances: unknown[];
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
    throw new Error('Token withdrawal receipt unavailable.');
  const signed = await inspectNativeWithdrawal(
    review,
    result.transaction[0],
    true,
  );
  if (signed.signature !== signature)
    throw new Error('Token withdrawal signature differs.');
  if (result.meta.err !== null)
    return decodeWithdrawalFailure(result, review, signature, signed.message);
  const compiled = getCompiledTransactionMessageDecoder().decode(
      signed.message,
    ),
    keys = compiled.staticAccounts.map(String),
    source = keys.indexOf(token.sourceAccount),
    destination = keys.indexOf(token.destinationAccount);
  if (
    source < 1 ||
    destination < 1 ||
    !Array.isArray(result.meta.preBalances) ||
    !Array.isArray(result.meta.postBalances) ||
    result.meta.preBalances.length !== keys.length ||
    result.meta.postBalances.length !== keys.length
  )
    throw new Error('Token withdrawal balance context differs.');
  const before = result.meta.preBalances.map(uint),
    after = result.meta.postBalances.map(uint),
    fee = uint(result.meta.fee),
    rent = after[destination] - before[destination];
  if (
    fee > uint(review.feeLamports) ||
    rent < 0n ||
    rent > uint(token.accountRentLamports) ||
    (!token.createAccount && rent !== 0n) ||
    after[0] - before[0] !== -(fee + rent) ||
    keys.some((_, i) => i !== 0 && i !== destination && before[i] !== after[i])
  )
    throw new Error('Token withdrawal native settlement differs.');
  function balances(rows: unknown[], post: boolean) {
    if (!Array.isArray(rows) || rows.length > 2)
      throw new Error('Token balance evidence differs.');
    const values = new Map<number, bigint>();
    for (const value of rows) {
      const b = value as {
        accountIndex: string | number;
        mint: string;
        owner: string;
        programId: string;
        uiTokenAmount: { amount: string; decimals: string | number };
      };
      const index = slot(
        typeof b.accountIndex === 'number'
          ? String(b.accountIndex)
          : b.accountIndex,
      );
      const decimals = slot(
        typeof b.uiTokenAmount?.decimals === 'number'
          ? String(b.uiTokenAmount.decimals)
          : b.uiTokenAmount?.decimals,
      );
      if (
        ![source, destination].includes(index) ||
        values.has(index) ||
        b.mint !== token.mint ||
        b.owner !== (index === source ? review.wallet : review.recipient) ||
        b.programId !== token.program ||
        decimals !== token.decimals
      )
        throw new Error('Token balance identity differs.');
      values.set(index, uint(b.uiTokenAmount.amount));
    }
    if (
      !values.has(source) ||
      (!values.has(destination) &&
        (post || !token.createAccount || before[destination] !== 0n))
    )
      throw new Error('Incomplete token withdrawal balance evidence.');
    return [values.get(source)!, values.get(destination) ?? 0n];
  }
  const pre = balances(result.meta.preTokenBalances, false),
    post = balances(result.meta.postTokenBalances, true),
    amount = uint(review.amountRaw);
  const net = uint(token.transferFee?.netAmountRaw ?? review.amountRaw);
  if (post[0] - pre[0] !== -amount || post[1] - pre[1] !== net)
    throw new Error('Token withdrawal transfer units differ.');
  return {
    network: 'mainnet',
    commitment: 'finalized',
    signatureVerified: true,
    signature,
    wallet: review.wallet,
    recipient: review.recipient,
    amountRaw: review.amountRaw,
    networkFeeLamports: fee.toString(),
    walletChangeRaw: (-(fee + rent)).toString(),
    recipientChangeRaw: '0',
    slot: slot(result.slot),
    blockTime: result.blockTime === null ? null : slot(result.blockTime),
    sha256: review.sha256,
    observedAt: new Date().toISOString(),
    source: new URL(getSolanaRpcEndpoint('mainnet')).hostname,
    token: {
      mint: token.mint,
      decimals: token.decimals,
      sourceAccount: token.sourceAccount,
      destinationAccount: token.destinationAccount,
      sourceChangeRaw: (-amount).toString(),
      destinationChangeRaw: net.toString(),
      accountRentLamports: rent.toString(),
      ...(token.transferFee
        ? { transferFeeRaw: token.transferFee.feeRaw }
        : {}),
    },
  };
}
