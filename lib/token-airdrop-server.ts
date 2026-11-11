import { address, isOffCurveAddress } from '@solana/kit';
import { TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import { balanceRpc, SOLANA_MAINNET_GENESIS } from './wallet-balances';
import {
  getSolanaRpcEndpoint,
  requireConsistentSolanaSlots,
} from './solana-rpc';
import { TOKEN_2022 } from './token-withdrawal-fee';
import { formatNativeBalance } from './wallet-balance-format';
import {
  readSupplyMint,
  readSupplyTokenAccount,
} from './token-supply-action-server';
import {
  AIRDROP_PROGRAM,
  airdropAccounts,
  airdropBase64,
  airdropBytes,
  airdropClaimStatus,
  airdropMessage,
  airdropSchedule,
  airdropSettled,
  airdropSha256,
  airdropShares,
  airdropTree,
  airdropUint,
  inspectAirdrop,
  unsignedAirdropPacket,
  type AirdropTerms,
  type TokenAirdropReceipt,
  type TokenAirdropReview,
} from './token-airdrop';

const SYSTEM = '11111111111111111111111111111111';
type Rpc = (method: string, params: unknown[]) => Promise<unknown>;
type Account = Parameters<typeof readSupplyMint>[0];
export type AirdropPrepareInput =
  | {
      kind: 'create';
      wallet: string;
      walletRevision: number;
      mint: string;
      percentPpm: bigint;
      recipients: string[];
    }
  | {
      kind: 'claim' | 'clawback';
      wallet: string;
      walletRevision: number;
      /** The finalized create review this claim or clawback belongs to. */
      parent: TokenAirdropReview;
    };

const slot = (value: unknown) => {
  const n = Number(airdropUint(String(value)));
  if (!Number.isSafeInteger(n)) throw new Error('Invalid airdrop slot.');
  return n;
};
const lamports = (account: Account) => airdropUint(String(account?.lamports));

async function observe(review: TokenAirdropReview, rpc: Rpc) {
  const t = review.terms,
    keys = [review.wallet, review.mint, review.tokenAccount, t.distributor];
  keys.push(
    t.vault,
    ...(review.kind === 'claim'
      ? [await airdropClaimStatus(t.distributor, review.wallet)]
      : []),
  );
  const result = (await rpc('getMultipleAccounts', [
    keys,
    {
      encoding: 'base64',
      commitment: 'finalized',
      minContextSlot: review.slot,
    },
  ])) as { context: { slot: number }; value: Account[] };
  if (!Array.isArray(result?.value) || result.value.length !== keys.length)
    throw new Error('Incomplete airdrop accounts.');
  const [wallet, mintAccount, own, distributor, vault, claimed] = result.value;
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
  if (mint.extensions.includes('TransferFeeConfig'))
    throw new Error('Transfer-fee tokens cannot be airdropped here.');
  if (review.kind === 'create') {
    if (distributor !== null || vault !== null)
      throw new Error('Airdrop account already exists. Prepare again.');
  } else {
    if (
      !distributor ||
      distributor.owner !== AIRDROP_PROGRAM ||
      distributor.executable !== false
    )
      throw new Error('This airdrop is not on chain yet or was closed.');
    if (review.kind === 'claim' && claimed)
      throw new Error('This wallet already claimed its share.');
  }
  return {
    slot: slot(result.context.slot),
    walletLamports: lamports(wallet),
    // An output wallet may not hold this token yet; the claim creates its account.
    balance:
      own === null && review.kind !== 'create'
        ? 0n
        : readSupplyTokenAccount(
            own,
            review.program,
            review.mint,
            review.wallet,
          ),
    vault:
      review.kind === 'create'
        ? 0n
        : readSupplyTokenAccount(
            vault,
            review.program,
            review.mint,
            t.distributor,
          ),
  };
}

async function simulate(review: TokenAirdropReview, rpc: Rpc) {
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
        addresses: [review.wallet, review.tokenAccount],
      },
    },
  ])) as {
    context: { slot: number };
    value: { err: unknown; accounts: Account[] | null };
  };
  if (result?.value?.err !== null)
    throw new Error(
      review.kind === 'claim'
        ? 'Claim simulation failed. Claims open a few minutes after the airdrop is created.'
        : review.kind === 'clawback'
          ? 'Take-back simulation failed. Unclaimed tokens can be taken back one day after the airdrop opened.'
          : 'Airdrop simulation failed.',
    );
  const [wallet, own] = result.value.accounts ?? [];
  if (!wallet || !own) throw new Error('Simulation state unavailable.');
  return {
    slot: slot(result.context.slot),
    walletLamports: lamports(wallet),
    balance: readSupplyTokenAccount(
      own,
      review.program,
      review.mint,
      review.wallet,
    ),
  };
}

function connect(signal: AbortSignal, fetcher: typeof fetch) {
  const endpoint = getSolanaRpcEndpoint('mainnet'),
    rpc: Rpc = (method, params) =>
      balanceRpc(endpoint, method, params, signal, fetcher);
  return { endpoint, rpc };
}

export async function prepareAirdrop(
  input: AirdropPrepareInput,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<TokenAirdropReview> {
  const started = Date.now(),
    preparedAt = new Date(started).toISOString(),
    id = crypto.randomUUID();
  if (isOffCurveAddress(address(input.wallet)))
    throw new Error('Ordinary wallet key required.');
  const parent = input.kind === 'create' ? null : input.parent,
    mintAddress = input.kind === 'create' ? input.mint : input.parent.mint;
  if (parent) {
    await inspectAirdrop(parent, parent.transaction, false);
    if (parent.kind !== 'create')
      throw new Error('Choose a created airdrop first.');
    if (input.kind === 'clawback' && started / 1000 < parent.terms.clawbackTs)
      throw new Error(
        `Unclaimed tokens can be taken back from ${new Date(parent.terms.clawbackTs * 1000).toISOString()}.`,
      );
    if (input.kind === 'claim' && started / 1000 < parent.terms.startTs)
      throw new Error(
        `Claims open at ${new Date(parent.terms.startTs * 1000).toISOString()}.`,
      );
  }
  const { endpoint, rpc } = connect(signal, fetcher);
  if ((await rpc('getGenesisHash', [])) !== SOLANA_MAINNET_GENESIS)
    throw new Error('Airdrop network differs.');
  const mintInfo = (await rpc('getAccountInfo', [
    mintAddress,
    { encoding: 'base64', commitment: 'finalized' },
  ])) as { context: { slot: number }; value: Account };
  const program = mintInfo?.value?.owner;
  if (program !== TOKEN_PROGRAM_ADDRESS && program !== TOKEN_2022)
    throw new Error('Unsupported token mint program.');
  if (parent && program !== parent.program)
    throw new Error('Mint program differs from the airdrop.');
  const mint = readSupplyMint(mintInfo.value, program);
  const latest = (await rpc('getLatestBlockhash', [
    { commitment: 'finalized' },
  ])) as {
    context: { slot: number };
    value: { blockhash: string; lastValidBlockHeight: number | string };
  };
  let terms: AirdropTerms;
  if (parent) {
    const { recipients, proof: _none, ...shared } = parent.terms;
    void _none;
    if (input.kind === 'claim') {
      const index = (recipients ?? []).indexOf(input.wallet);
      if (index < 0)
        throw new Error('This wallet is not an output wallet of the airdrop.');
      const tree = await airdropTree(
        recipients!,
        airdropUint(shared.perRecipientRaw),
      );
      if (tree.root !== shared.root)
        throw new Error('Airdrop terms differ from their recipients.');
      terms = { ...shared, proof: tree.proofs[index] };
    } else {
      if (input.wallet !== shared.creator)
        throw new Error('Only the creating wallet can take back an airdrop.');
      terms = shared;
    }
  } else {
    // Milliseconds plus three random digits: unique per mint without a lookup.
    const version =
      BigInt(started) * 1000n +
      BigInt(crypto.getRandomValues(new Uint16Array(1))[0] % 1000);
    terms = {
      airdropId: id,
      version: version.toString(),
      ...(await airdropAccounts({ mint: mintAddress, program, version })),
      root: '',
      perRecipientRaw: '0',
      ...airdropSchedule(preparedAt),
      creator: input.wallet,
      recipients: (input as { recipients: string[] }).recipients,
    };
  }
  const review: TokenAirdropReview = {
    id,
    network: 'mainnet',
    kind: input.kind,
    wallet: input.wallet,
    walletRevision: input.walletRevision,
    mint: mintAddress,
    program,
    decimals: mint.decimals,
    tokenAccount: '',
    terms,
    ...(input.kind === 'create'
      ? { percentPpm: input.percentPpm.toString() }
      : {}),
    tokenChangeRaw: '0',
    amount: '0',
    blockhash: latest.value.blockhash,
    lastValidBlockHeight: String(latest.value.lastValidBlockHeight),
    slot: slot(latest.context.slot),
    feeLamports: '0',
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
  // The signer's token account does not depend on the amounts filled in below.
  review.tokenAccount = (
    await airdropMessage({
      ...review,
      terms: { ...terms, root: '00'.repeat(32), perRecipientRaw: '1' },
    })
  ).tokenAccount;
  const before = await observe(review, rpc);
  if (input.kind === 'create') {
    const share = airdropShares(
      before.balance,
      input.percentPpm,
      input.recipients.length,
    );
    terms.perRecipientRaw = share.perRecipient.toString();
    terms.root = (await airdropTree(input.recipients, share.perRecipient)).root;
  } else if (input.kind === 'clawback' && before.vault < 1n)
    throw new Error('Nothing is left to take back.');
  else if (
    input.kind === 'claim' &&
    before.vault < airdropUint(terms.perRecipientRaw)
  )
    throw new Error('The airdrop no longer holds this share.');
  const { message } = await airdropMessage(review);
  review.transaction = airdropBase64(unsignedAirdropPacket(message));
  review.sha256 = await airdropSha256(airdropBytes(review.transaction));
  const [fee, reserve] = (await Promise.all([
    rpc('getFeeForMessage', [
      airdropBase64(message),
      { commitment: 'finalized', minContextSlot: review.slot },
    ]),
    rpc('getMinimumBalanceForRentExemption', [0, { commitment: 'finalized' }]),
  ])) as [
    { context: { slot: number }; value: number | string | null },
    unknown,
  ];
  if (fee?.value === null || fee?.value === undefined)
    throw new Error('Airdrop fee unavailable.');
  review.feeLamports = airdropUint(String(fee.value)).toString();
  review.reserveLamports = airdropUint(String(reserve)).toString();
  const after = await simulate(review, rpc);
  const change = after.balance - before.balance,
    solDebit = before.walletLamports - after.walletLamports;
  const expected =
    input.kind === 'create'
      ? -airdropUint(terms.perRecipientRaw) * BigInt(input.recipients.length)
      : input.kind === 'claim'
        ? airdropUint(terms.perRecipientRaw)
        : null;
  if (expected === null ? change < 1n : change !== expected)
    throw new Error('Simulated token movement differs from the airdrop.');
  review.tokenChangeRaw = change.toString();
  review.amount = formatNativeBalance(
    (change < 0n ? -change : change).toString(),
    mint.decimals,
  );
  review.solDebitLamports = (solDebit > 0n ? solDebit : 0n).toString();
  if (
    before.walletLamports <
    airdropUint(review.solDebitLamports) +
      airdropUint(review.feeLamports) +
      airdropUint(review.reserveLamports)
  )
    throw new Error('Wallet SOL does not cover fees, rent and the reserve.');
  const slots = [review.slot, before.slot, slot(fee.context.slot), after.slot];
  if (slots.some((s) => s < review.slot))
    throw new Error('Stale airdrop context.');
  requireConsistentSolanaSlots(slots);
  await inspectAirdrop(review, review.transaction, false);
  return review;
}

/** Immediately before submission: same accounts, same token movement, same or lower simulated cost, live blockhash. */
export async function recheckAirdrop(
  review: TokenAirdropReview,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
) {
  await inspectAirdrop(review, review.transaction, false);
  if (Date.parse(review.expiresAt) <= Date.now())
    throw new Error('Airdrop approval expired.');
  const { rpc } = connect(signal, fetcher);
  if ((await rpc('getGenesisHash', [])) !== SOLANA_MAINNET_GENESIS)
    throw new Error('Airdrop network differs.');
  const before = await observe(review, rpc);
  const after = await simulate(review, rpc);
  if (
    !airdropSettled(review, after.balance - before.balance) ||
    (review.kind === 'clawback' && after.balance - before.balance < 1n) ||
    before.walletLamports - after.walletLamports >
      airdropUint(review.solDebitLamports) ||
    before.walletLamports <
      airdropUint(review.solDebitLamports) +
        airdropUint(review.feeLamports) +
        airdropUint(review.reserveLamports)
  )
    throw new Error('Airdrop cost or coverage changed since approval.');
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
    throw new Error('Airdrop blockhash expired.');
  signal.throwIfAborted();
}

type TokenBalance = {
  accountIndex: number | string;
  mint: string;
  owner?: string;
  uiTokenAmount: { amount: string };
};
export async function decodeAirdropReceipt(
  raw: unknown,
  review: TokenAirdropReview,
  signature: string,
): Promise<TokenAirdropReceipt> {
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
    throw new Error('Airdrop receipt unavailable.');
  const signed = await inspectAirdrop(review, result.transaction[0], true);
  if (signed.signature !== signature)
    throw new Error('Airdrop signature differs.');
  const fee = airdropUint(String(result.meta.fee));
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
    return row ? airdropUint(row.uiTokenAmount.amount) : 0n;
  };
  const tokenChange =
    amountAt(result.meta.postTokenBalances) -
    amountAt(result.meta.preTokenBalances);
  const failed = result.meta.err !== null;
  if (
    fee > airdropUint(review.feeLamports) ||
    (!failed &&
      (!airdropSettled(review, tokenChange) ||
        -walletChange > airdropUint(review.solDebitLamports) + fee))
  )
    throw new Error('Airdrop settlement differs from its approval.');
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
    observedAt: new Date().toISOString(),
  };
}
