import bs58 from 'bs58';
import { address, isOffCurveAddress } from '@solana/kit';
import { TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import { balanceRpc, SOLANA_MAINNET_GENESIS } from './wallet-balances';
import {
  getSolanaRpcEndpoint,
  requireConsistentSolanaSlots,
} from './solana-rpc';
import { withdrawalExtensions } from './token-withdrawal-extensions';
import { TOKEN_2022 } from './token-withdrawal-fee';
import { formatNativeBalance } from './wallet-balance-format';
import {
  encodeBase64,
  decodeBase64,
  inspectSupplyAction,
  sha256Hex,
  streamflowLockAccounts,
  streamflowLockName,
  supplyActionInput,
  supplyActionMessage,
  supplyShare,
  supplyUint,
  unsignedSupplyPacket,
  type TokenSupplyReceipt,
  type TokenSupplyReview,
} from './token-supply-action';

const SYSTEM = '11111111111111111111111111111111';
type Rpc = (method: string, params: unknown[]) => Promise<unknown>;
type Account = {
  owner: string;
  executable: boolean;
  lamports: string | number;
  data: [string, string];
} | null;
const slot = (value: unknown) => {
  const n = Number(supplyUint(String(value)));
  if (!Number.isSafeInteger(n)) throw new Error('Invalid supply action slot.');
  return n;
};
function accountData(account: Account, program: string, size: number) {
  if (
    !account ||
    account.owner !== program ||
    account.executable !== false ||
    !Array.isArray(account.data) ||
    account.data[1] !== 'base64' ||
    typeof account.data[0] !== 'string' ||
    account.data[0].length > 21848
  )
    throw new Error('Token account program or encoding differs.');
  const bytes = Uint8Array.from(atob(account.data[0]), (c) => c.charCodeAt(0));
  if (bytes.length < size) throw new Error('Token account is truncated.');
  return bytes;
}
export function readSupplyMint(account: Account, program: string) {
  const bytes = accountData(account, program, 82),
    view = new DataView(bytes.buffer);
  const extensions = withdrawalExtensions(bytes, program, true).map(
    (e) => e.__kind,
  );
  if (bytes[45] !== 1 || view.getUint32(0, true) > 1)
    throw new Error('Mint is not initialized.');
  return {
    supplyRaw: view.getBigUint64(36, true),
    decimals: bytes[44],
    extensions,
  };
}
export function readSupplyTokenAccount(
  account: Account,
  program: string,
  mint: string,
  owner: string,
) {
  const bytes = accountData(account, program, 165),
    view = new DataView(bytes.buffer);
  withdrawalExtensions(bytes, program, false);
  if (
    bs58.encode(bytes.slice(0, 32)) !== mint ||
    bs58.encode(bytes.slice(32, 64)) !== owner ||
    bytes[108] !== 1
  )
    throw new Error('Token account owner, mint or state differs.');
  return view.getBigUint64(64, true);
}
const lamports = (account: Account) => supplyUint(String(account?.lamports));

async function observe(
  review: TokenSupplyReview,
  rpc: Rpc,
  preparing: boolean,
) {
  const keys = [review.wallet, review.mint, review.sourceAccount];
  if (review.lock) keys.push(review.lock.metadata, review.lock.escrow);
  const result = (await rpc('getMultipleAccounts', [
    keys,
    {
      encoding: 'base64',
      commitment: 'finalized',
      minContextSlot: review.slot,
    },
  ])) as { context: { slot: number }; value: Account[] };
  if (!Array.isArray(result?.value) || result.value.length !== keys.length)
    throw new Error('Incomplete supply action accounts.');
  const [wallet, mintAccount, source, metadata, escrow] = result.value;
  if (
    !wallet ||
    wallet.owner !== SYSTEM ||
    wallet.executable !== false ||
    wallet.data?.[0] !== ''
  )
    throw new Error('Ordinary funded wallet required.');
  const mint = readSupplyMint(mintAccount, review.program);
  if (mint.decimals !== review.decimals)
    throw new Error('Mint precision changed.');
  if (review.kind === 'lock' && mint.extensions.includes('TransferFeeConfig'))
    throw new Error('Transfer-fee tokens need a separate lock adapter.');
  if (!preparing && mint.supplyRaw !== supplyUint(review.supplyRaw))
    throw new Error('Token supply changed since approval. Prepare again.');
  const balance = readSupplyTokenAccount(
    source,
    review.program,
    review.mint,
    review.wallet,
  );
  if (review.lock && (metadata !== null || escrow !== null))
    throw new Error('Streamflow lock account already exists. Prepare again.');
  return {
    slot: slot(result.context.slot),
    walletLamports: lamports(wallet),
    balance,
    mint,
  };
}

async function simulate(review: TokenSupplyReview, rpc: Rpc) {
  const result = (await rpc('simulateTransaction', [
    review.transaction,
    {
      encoding: 'base64',
      commitment: 'finalized',
      sigVerify: false,
      replaceRecentBlockhash: false,
      minContextSlot: review.slot,
      accounts: {
        encoding: 'base64',
        addresses: [review.wallet, review.sourceAccount, review.mint],
      },
    },
  ])) as {
    context: { slot: number };
    value: { err: unknown; accounts: Account[] | null; logs?: string[] };
  };
  if (result?.value?.err !== null)
    throw new Error('Supply action simulation failed.');
  const [wallet, source, mint] = result.value.accounts ?? [];
  if (!wallet || !mint) throw new Error('Simulation state unavailable.');
  return {
    slot: slot(result.context.slot),
    walletLamports: lamports(wallet),
    // A full burn may close nothing, but treat a missing account as empty.
    balance: source
      ? readSupplyTokenAccount(
          source,
          review.program,
          review.mint,
          review.wallet,
        )
      : 0n,
    supplyRaw: readSupplyMint(mint, review.program).supplyRaw,
  };
}

export async function prepareSupplyAction(
  input: ReturnType<typeof supplyActionInput>,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<TokenSupplyReview> {
  const started = Date.now();
  if (isOffCurveAddress(address(input.wallet)))
    throw new Error('Ordinary wallet key required.');
  const endpoint = getSolanaRpcEndpoint('mainnet'),
    rpc: Rpc = (method, params) =>
      balanceRpc(endpoint, method, params, signal, fetcher);
  if ((await rpc('getGenesisHash', [])) !== SOLANA_MAINNET_GENESIS)
    throw new Error('Supply action network differs.');
  const mintInfo = (await rpc('getAccountInfo', [
    input.mint,
    { encoding: 'base64', commitment: 'finalized' },
  ])) as { context: { slot: number }; value: Account };
  const program = mintInfo?.value?.owner;
  if (program !== TOKEN_PROGRAM_ADDRESS && program !== TOKEN_2022)
    throw new Error('Unsupported token mint program.');
  const mint = readSupplyMint(mintInfo.value, program);
  const amountRaw = supplyShare(mint.supplyRaw, input.percentPpm);
  const latest = (await rpc('getLatestBlockhash', [
    { commitment: 'finalized' },
  ])) as {
    context: { slot: number };
    value: { blockhash: string; lastValidBlockHeight: number | string };
  };
  const preparedAt = new Date(started).toISOString();
  let lock: TokenSupplyReview['lock'];
  if (input.kind === 'lock') {
    const metadata = input.lockMetadata!;
    if (isOffCurveAddress(address(metadata)))
      throw new Error('Streamflow metadata key must be a fresh keypair.');
    const accounts = await streamflowLockAccounts({
      mint: input.mint,
      program,
      metadata,
    });
    lock = {
      unlockAt: Math.floor(started / 1000) + input.durationSeconds!,
      durationSeconds: input.durationSeconds!,
      metadata,
      ...accounts,
      name: streamflowLockName(input.mint),
    };
  }
  const review: TokenSupplyReview = {
    id: crypto.randomUUID(),
    network: 'mainnet',
    kind: input.kind,
    wallet: input.wallet,
    walletRevision: input.walletRevision,
    mint: input.mint,
    program,
    decimals: mint.decimals,
    supplyRaw: mint.supplyRaw.toString(),
    percentPpm: input.percentPpm.toString(),
    amountRaw: amountRaw.toString(),
    amount: formatNativeBalance(amountRaw.toString(), mint.decimals),
    sourceAccount: '',
    ...(lock ? { lock } : {}),
    blockhash: latest.value.blockhash,
    lastValidBlockHeight: String(latest.value.lastValidBlockHeight),
    slot: slot(latest.context.slot),
    feeLamports: '0',
    tokenDebitRaw: '0',
    solDebitLamports: '0',
    reserveLamports: '0',
    transaction: '',
    sha256: '',
    preparedAt,
    expiresAt: new Date(started + 60_000).toISOString(),
    source: new URL(endpoint).hostname,
  };
  if (slot(mintInfo.context.slot) > review.slot)
    throw new Error('Mint context is ahead of the blockhash.');
  const { source, signers, message } = await supplyActionMessage(review);
  review.sourceAccount = source;
  const before = await observe(review, rpc, true);
  if (before.mint.supplyRaw !== mint.supplyRaw)
    throw new Error('Token supply moved during preparation. Try again.');
  if (before.balance < amountRaw)
    throw new Error(
      'This wallet does not hold that share of supply. Lower the percentage.',
    );
  review.transaction = encodeBase64(unsignedSupplyPacket(signers, message));
  review.sha256 = await sha256Hex(decodeBase64(review.transaction));
  const [fee, reserve] = (await Promise.all([
    rpc('getFeeForMessage', [
      encodeBase64(message),
      { commitment: 'finalized', minContextSlot: review.slot },
    ]),
    rpc('getMinimumBalanceForRentExemption', [0, { commitment: 'finalized' }]),
  ])) as [
    { context: { slot: number }; value: number | string | null },
    unknown,
  ];
  if (fee?.value === null || fee?.value === undefined)
    throw new Error('Supply action fee unavailable.');
  review.feeLamports = supplyUint(String(fee.value)).toString();
  review.reserveLamports = supplyUint(String(reserve)).toString();
  const after = await simulate(review, rpc);
  const tokenDebit = before.balance - after.balance,
    solDebit = before.walletLamports - after.walletLamports;
  if (
    tokenDebit < amountRaw ||
    (input.kind === 'burn' &&
      (tokenDebit !== amountRaw ||
        mint.supplyRaw - after.supplyRaw !== amountRaw)) ||
    (input.kind === 'lock' && after.supplyRaw !== mint.supplyRaw)
  )
    throw new Error('Simulated token movement differs from the action.');
  review.tokenDebitRaw = tokenDebit.toString();
  review.solDebitLamports = (solDebit > 0n ? solDebit : 0n).toString();
  if (
    before.walletLamports <
    supplyUint(review.solDebitLamports) +
      supplyUint(review.feeLamports) +
      supplyUint(review.reserveLamports)
  )
    throw new Error('Wallet SOL does not cover fees, rent and the reserve.');
  if (tokenDebit > before.balance)
    throw new Error('Wallet does not cover the action and its token fee.');
  const slots = [review.slot, before.slot, slot(fee.context.slot), after.slot];
  if (slots.some((s) => s < review.slot))
    throw new Error('Stale supply action context.');
  requireConsistentSolanaSlots(slots);
  await inspectSupplyAction(review, review.transaction, false);
  return review;
}

/** Immediately before submission: same supply, enough balance, same or lower simulated cost, live blockhash. */
export async function recheckSupplyAction(
  review: TokenSupplyReview,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
) {
  await inspectSupplyAction(review, review.transaction, false);
  if (Date.parse(review.expiresAt) <= Date.now())
    throw new Error('Supply action approval expired.');
  const endpoint = getSolanaRpcEndpoint('mainnet'),
    rpc: Rpc = (method, params) =>
      balanceRpc(endpoint, method, params, signal, fetcher);
  if ((await rpc('getGenesisHash', [])) !== SOLANA_MAINNET_GENESIS)
    throw new Error('Supply action network differs.');
  const before = await observe(review, rpc, false);
  const after = await simulate(review, rpc);
  if (
    before.balance - after.balance > supplyUint(review.tokenDebitRaw) ||
    before.balance - after.balance < supplyUint(review.amountRaw) ||
    before.walletLamports - after.walletLamports >
      supplyUint(review.solDebitLamports) ||
    before.walletLamports <
      supplyUint(review.solDebitLamports) +
        supplyUint(review.feeLamports) +
        supplyUint(review.reserveLamports)
  )
    throw new Error('Supply action cost or coverage changed since approval.');
  const valid = (await rpc('isBlockhashValid', [
    review.blockhash,
    { commitment: 'finalized', minContextSlot: review.slot },
  ])) as { context: { slot: number }; value: boolean };
  requireConsistentSolanaSlots([
    before.slot,
    after.slot,
    slot(valid.context.slot),
  ]);
  if (valid.value !== true || Date.parse(review.expiresAt) <= Date.now())
    throw new Error('Supply action blockhash expired.');
  signal.throwIfAborted();
}

type TokenBalance = {
  accountIndex: number | string;
  mint: string;
  owner?: string;
  uiTokenAmount: { amount: string };
};
export async function decodeSupplyActionReceipt(
  raw: unknown,
  review: TokenSupplyReview,
  signature: string,
): Promise<TokenSupplyReceipt> {
  const result = raw as {
    transaction: [string, string];
    slot: number | string;
    blockTime: number | string | null;
    meta: {
      err: unknown;
      fee: number | string;
      preBalances: (number | string)[];
      postBalances: (number | string)[];
      preTokenBalances: TokenBalance[];
      postTokenBalances: TokenBalance[];
    };
  };
  if (
    !result?.meta ||
    !Array.isArray(result.transaction) ||
    result.transaction[1] !== 'base64' ||
    result.meta.err === undefined ||
    slot(result.slot) < review.slot
  )
    throw new Error('Supply action receipt unavailable.');
  const signed = await inspectSupplyAction(review, result.transaction[0], true);
  if (signed.signature !== signature)
    throw new Error('Supply action signature differs.');
  const fee = supplyUint(String(result.meta.fee));
  const walletChange =
    BigInt(result.meta.postBalances?.[0] ?? 0) -
    BigInt(result.meta.preBalances?.[0] ?? 0);
  const amountAt = (rows: TokenBalance[]) => {
    const row = (rows ?? []).find(
      (b) =>
        b.mint === review.mint &&
        b.owner === review.wallet &&
        Number(b.accountIndex) > 0,
    );
    return row ? supplyUint(row.uiTokenAmount.amount) : 0n;
  };
  const tokenChange =
    amountAt(result.meta.postTokenBalances) -
    amountAt(result.meta.preTokenBalances);
  const failed = result.meta.err !== null;
  if (
    fee > supplyUint(review.feeLamports) ||
    (!failed &&
      (-tokenChange > supplyUint(review.tokenDebitRaw) ||
        -tokenChange < supplyUint(review.amountRaw) ||
        -walletChange > supplyUint(review.solDebitLamports) + fee))
  )
    throw new Error('Supply action settlement differs from its approval.');
  return {
    network: 'mainnet',
    commitment: 'finalized',
    signature,
    failed,
    error: failed ? JSON.stringify(result.meta.err).slice(0, 300) : null,
    slot: slot(result.slot),
    blockTime: result.blockTime === null ? null : slot(result.blockTime),
    networkFeeLamports: fee.toString(),
    walletLamportsChange: walletChange.toString(),
    tokenChangeRaw: tokenChange.toString(),
    // Burns reduce supply one-for-one; a lock leaves supply unchanged.
    supplyChangeRaw: failed
      ? null
      : review.kind === 'burn'
        ? tokenChange.toString()
        : '0',
    observedAt: new Date().toISOString(),
  };
}
