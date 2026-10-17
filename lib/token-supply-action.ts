import bs58 from 'bs58';
import nacl from 'tweetnacl';
import {
  AccountRole,
  address,
  appendTransactionMessageInstructions,
  blockhash as parseBlockhash,
  compileTransactionMessage,
  createNoopSigner,
  createTransactionMessage,
  getAddressEncoder,
  getCompiledTransactionMessageEncoder,
  getProgramDerivedAddress,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address,
  type Instruction,
} from '@solana/kit';
import {
  ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
  findAssociatedTokenPda,
  getBurnCheckedInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from '@solana-program/token';
import { verifySolanaSignature } from './solana-signature';
import { UUID } from './wallet-operation';
import { walletAddress } from './wallet-workspace';
import { formatNativeBalance } from './wallet-balance-format';
import { TOKEN_2022 } from './token-withdrawal-fee';
import { sendPercent, SEND_PERCENT_SCALE } from './token-send-plan';
import type { VaultSession } from './browser-wallet-vault';

// Burn and Streamflow lock of a share of a token's supply from one owned
// wallet. The server prepares and simulates an exact unsigned packet; the
// browser rebuilds it byte-for-byte before the user signs it locally.

export const STREAMFLOW_PROGRAM = 'strmRqUCoQUgGUan5YhzUZa6KqdzwX5L6FpUxfmKg5m';
export const STREAMFLOW_TREASURY =
  '5SEpbdjFK5FxwTvfsGMXVQTD2v4M2c5tyRTxhdsPkgDw';
export const STREAMFLOW_WITHDRAWOR =
  'wdrwhnCv4pzW8beKsbPa4S2UDZrXenjg16KJdKSpb5u';
export const STREAMFLOW_FEE_ORACLE =
  'B743wFVk2pCYhV91cn287e1xY7f1vt4gdY48hhNiuQmT';
const RENT_SYSVAR = 'SysvarRent111111111111111111111111111111111';
const SYSTEM = '11111111111111111111111111111111';
const WSOL = 'So11111111111111111111111111111111111111112';
// sha256("global:create")[0..8], Streamflow's Anchor discriminator. The
// original create takes a fresh metadata keypair as a second signer; that key
// is generated in the browser and never leaves it.
export const STREAMFLOW_CREATE = Uint8Array.from([
  24, 30, 200, 40, 5, 28, 7, 119,
]);
export const MIN_LOCK_SECONDS = 3600;
export const MAX_LOCK_SECONDS = 10 * 366 * 86400;
const LIFETIME_MS = 60_000;

export type SupplyActionKind = 'burn' | 'lock';
export type SupplyActionLock = {
  unlockAt: number;
  durationSeconds: number;
  /** Public key of the browser-generated Streamflow metadata account. */
  metadata: string;
  escrow: string;
  treasuryTokens: string;
  name: string;
};
export type TokenSupplyReview = {
  id: string;
  network: 'mainnet';
  kind: SupplyActionKind;
  wallet: string;
  walletRevision: number;
  mint: string;
  program: typeof TOKEN_PROGRAM_ADDRESS | typeof TOKEN_2022;
  decimals: number;
  supplyRaw: string;
  percentPpm: string;
  amountRaw: string;
  amount: string;
  sourceAccount: string;
  lock?: SupplyActionLock;
  blockhash: string;
  lastValidBlockHeight: string;
  slot: number;
  feeLamports: string;
  /** Exact token units the simulated packet removed from the wallet's account (lock adds Streamflow's token fee on top of the amount). */
  tokenDebitRaw: string;
  /** Lamports the simulated packet removed from the wallet (network fee, rent and Streamflow's SOL fee). */
  solDebitLamports: string;
  reserveLamports: string;
  transaction: string;
  sha256: string;
  preparedAt: string;
  expiresAt: string;
  source: string;
};
export type TokenSupplyState =
  | 'awaiting_signature'
  | 'signing'
  | 'signed'
  | 'submitted'
  | 'finalized'
  | 'failed'
  | 'cancelled';
export type TokenSupplyReceipt = {
  network: 'mainnet';
  commitment: 'finalized';
  signature: string;
  failed: boolean;
  error: string | null;
  slot: number;
  blockTime: number | null;
  networkFeeLamports: string;
  walletLamportsChange: string;
  tokenChangeRaw: string;
  supplyChangeRaw: string | null;
  observedAt: string;
};
export type TokenSupplyAction = {
  id: string;
  wallet: string;
  walletRevision: number;
  kind: SupplyActionKind;
  mint: string;
  state: TokenSupplyState;
  signature: string | null;
  document: TokenSupplyReview;
  receipt: TokenSupplyReceipt | null;
  createdAt: string;
  updatedAt: string;
};

const U64_MAX = (1n << 64n) - 1n;
export const supplyUint = (value: unknown) => {
  if (
    typeof value !== 'string' ||
    !/^(0|[1-9]\d{0,19})$/.test(value) ||
    BigInt(value) > U64_MAX
  )
    throw new Error('Invalid supply action integer.');
  return BigInt(value);
};
export const encodeBase64 = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes));
export const decodeBase64 = (value: string) => {
  if (
    typeof value !== 'string' ||
    value.length > 1644 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    )
  )
    throw new Error('Invalid supply action packet.');
  const bytes = Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
  if (encodeBase64(bytes) !== value)
    throw new Error('Invalid supply action packet.');
  return bytes;
};
export const sha256Hex = async (bytes: Uint8Array) =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes).buffer),
    ),
    (b) => b.toString(16).padStart(2, '0'),
  ).join('');

/** Validates the user's request; amount is a share of the mint's total supply, computed server-side from the observed supply. */
export function supplyActionInput(body: {
  kind: unknown;
  wallet: unknown;
  walletRevision: unknown;
  mint: unknown;
  percent: unknown;
  durationSeconds?: unknown;
  lockMetadata?: unknown;
  acknowledgeIrreversible: unknown;
}) {
  if (body.kind !== 'burn' && body.kind !== 'lock')
    throw new Error('Choose burn or lock.');
  const wallet = walletAddress(body.wallet, 'Solana'),
    mint = walletAddress(body.mint, 'Solana');
  if ([SYSTEM, WSOL, wallet].includes(mint))
    throw new Error('Choose an ordinary SPL token mint.');
  if (
    !Number.isSafeInteger(body.walletRevision) ||
    Number(body.walletRevision) < 1
  )
    throw new Error('Choose the current wallet revision.');
  if (body.acknowledgeIrreversible !== true)
    throw new Error('Acknowledge that this action cannot be undone.');
  const percentPpm = sendPercent(body.percent);
  let durationSeconds: number | undefined, lockMetadata: string | undefined;
  if (body.kind === 'lock') {
    lockMetadata = walletAddress(body.lockMetadata, 'Solana');
    if ([wallet, mint, SYSTEM].includes(lockMetadata))
      throw new Error('Generate a fresh Streamflow metadata key.');
    durationSeconds = Number(body.durationSeconds);
    if (
      !Number.isSafeInteger(durationSeconds) ||
      durationSeconds < MIN_LOCK_SECONDS ||
      durationSeconds > MAX_LOCK_SECONDS
    )
      throw new Error('Choose a lock duration between one hour and ten years.');
  } else if (
    body.durationSeconds !== undefined ||
    body.lockMetadata !== undefined
  )
    throw new Error('Burns have no duration.');
  return {
    kind: body.kind as SupplyActionKind,
    wallet,
    walletRevision: Number(body.walletRevision),
    mint,
    percentPpm,
    durationSeconds,
    lockMetadata,
  };
}

export function supplyShare(supplyRaw: bigint, ppm: bigint) {
  const raw = (supplyRaw * ppm) / SEND_PERCENT_SCALE;
  if (raw < 1n)
    throw new Error('That share of supply is below one token unit.');
  return raw;
}

export function streamflowLockName(mint: string) {
  return `Bundle lock ${mint.slice(0, 8)}`;
}

export async function streamflowLockAccounts(input: {
  mint: string;
  program: string;
  metadata: string;
}) {
  const [escrow] = await getProgramDerivedAddress({
    programAddress: address(STREAMFLOW_PROGRAM),
    seeds: [
      new TextEncoder().encode('strm'),
      getAddressEncoder().encode(address(input.metadata)),
    ],
  });
  const [treasuryTokens] = await findAssociatedTokenPda({
    owner: address(STREAMFLOW_TREASURY),
    mint: address(input.mint),
    tokenProgram: address(input.program),
  });
  return { escrow, treasuryTokens };
}

/** Streamflow create data for a Token Lock: everything unlocks at the cliff, nothing is cancelable, transferable, pausable or top-up-able. */
export function streamflowLockData(input: {
  unlockAt: number;
  amountRaw: bigint;
  name: string;
}) {
  const name = new TextEncoder().encode(input.name);
  if (name.length > 64) throw new Error('Lock name is too long.');
  const data = new Uint8Array(8 + 130 + 10),
    view = new DataView(data.buffer);
  data.set(STREAMFLOW_CREATE, 0);
  let o = 8;
  const u64 = (v: bigint) => {
    view.setBigUint64(o, v, true);
    o += 8;
  };
  u64(BigInt(input.unlockAt)); // start_time
  u64(input.amountRaw); // net_amount_deposited
  u64(1n); // period
  u64(1n); // amount_per_period
  u64(BigInt(input.unlockAt)); // cliff
  u64(input.amountRaw); // cliff_amount
  o += 6; // cancelable x2, automatic_withdrawal, transferable x2, can_topup = false
  data.set(name, o);
  o += 64;
  u64(1n); // withdraw_frequency = period when automatic withdrawal is off
  data[o] = 1; // Some(pausable = false)
  data[o + 2] = 1; // Some(can_update_rate = false)
  return data;
}

export async function supplyActionInstructions(
  review: Pick<
    TokenSupplyReview,
    'kind' | 'wallet' | 'mint' | 'program' | 'decimals' | 'amountRaw' | 'lock'
  >,
) {
  const wallet = createNoopSigner(address(review.wallet)),
    mint = address(review.mint),
    program = address(review.program);
  if (![TOKEN_PROGRAM_ADDRESS, TOKEN_2022].includes(program))
    throw new Error('Unsupported token program.');
  const [source] = await findAssociatedTokenPda({
    owner: wallet.address,
    mint,
    tokenProgram: program,
  });
  const amount = supplyUint(review.amountRaw);
  if (review.kind === 'burn') {
    if (review.lock) throw new Error('Burns carry no lock terms.');
    return {
      source,
      instructions: [
        getBurnCheckedInstruction(
          {
            account: source,
            mint,
            authority: wallet,
            amount,
            decimals: review.decimals,
          },
          { programAddress: program },
        ) as Instruction,
      ],
    };
  }
  const lock = review.lock;
  if (!lock) throw new Error('Lock terms required.');
  const derived = await streamflowLockAccounts({
    mint: review.mint,
    program: review.program,
    metadata: lock.metadata,
  });
  if (
    derived.escrow !== lock.escrow ||
    derived.treasuryTokens !== lock.treasuryTokens
  )
    throw new Error('Streamflow lock accounts differ.');
  const w = (a: string) => ({
    address: address(a),
    role: AccountRole.WRITABLE,
  });
  const r = (a: string) => ({
    address: address(a),
    role: AccountRole.READONLY,
  });
  const lockInstruction: Instruction = {
    programAddress: address(STREAMFLOW_PROGRAM) as Address,
    accounts: [
      { address: wallet.address, role: AccountRole.WRITABLE_SIGNER },
      w(source), // sender tokens
      w(review.wallet), // recipient: the lock unlocks back to the same wallet
      { address: address(lock.metadata), role: AccountRole.WRITABLE_SIGNER },
      w(lock.escrow),
      w(source), // recipient tokens
      w(STREAMFLOW_TREASURY),
      w(lock.treasuryTokens),
      w(STREAMFLOW_WITHDRAWOR),
      w(review.wallet), // partner: none, so the sender
      w(source), // partner tokens
      r(review.mint),
      r(STREAMFLOW_FEE_ORACLE),
      r(RENT_SYSVAR),
      r(STREAMFLOW_PROGRAM),
      r(review.program),
      r(ASSOCIATED_TOKEN_PROGRAM_ADDRESS),
      r(SYSTEM),
    ],
    data: streamflowLockData({
      unlockAt: lock.unlockAt,
      amountRaw: amount,
      name: lock.name,
    }),
  };
  return { source, instructions: [lockInstruction] };
}

export async function supplyActionMessage(
  review: Pick<
    TokenSupplyReview,
    | 'kind'
    | 'wallet'
    | 'mint'
    | 'program'
    | 'decimals'
    | 'amountRaw'
    | 'lock'
    | 'blockhash'
    | 'lastValidBlockHeight'
  >,
) {
  const { source, instructions } = await supplyActionInstructions(review);
  const compiled = compileTransactionMessage(
    pipe(
      createTransactionMessage({ version: 'legacy' }),
      (m) => setTransactionMessageFeePayer(address(review.wallet), m),
      (m) =>
        setTransactionMessageLifetimeUsingBlockhash(
          {
            blockhash: parseBlockhash(review.blockhash),
            lastValidBlockHeight: supplyUint(review.lastValidBlockHeight),
          },
          m,
        ),
      (m) => appendTransactionMessageInstructions(instructions, m),
    ),
  );
  const signers = review.kind === 'lock' ? 2 : 1;
  if (
    compiled.header.numSignerAccounts !== signers ||
    compiled.staticAccounts[0] !== review.wallet ||
    (review.lock && compiled.staticAccounts[1] !== review.lock.metadata)
  )
    throw new Error('Unexpected supply action signers.');
  return {
    source,
    signers,
    message: Uint8Array.from(
      getCompiledTransactionMessageEncoder().encode(compiled),
    ),
  };
}
const unsignedPacket = (signers: number, message: Uint8Array) =>
  Uint8Array.from([signers, ...new Uint8Array(64 * signers), ...message]);
export { unsignedPacket as unsignedSupplyPacket };

/** Rebuilds the packet from the review terms and checks every byte, the hash and (when signed) the wallet signature. */
export async function inspectSupplyAction(
  review: TokenSupplyReview,
  transaction: string,
  signed: boolean,
) {
  if (
    !review ||
    !UUID.test(review.id) ||
    review.network !== 'mainnet' ||
    (review.kind !== 'burn' && review.kind !== 'lock') ||
    !Number.isSafeInteger(review.walletRevision) ||
    review.walletRevision < 1 ||
    !Number.isSafeInteger(review.slot) ||
    review.slot < 0 ||
    !Number.isInteger(review.decimals) ||
    review.decimals < 0 ||
    review.decimals > 255 ||
    ![TOKEN_PROGRAM_ADDRESS, TOKEN_2022].includes(review.program) ||
    !Number.isFinite(Date.parse(review.preparedAt)) ||
    !Number.isFinite(Date.parse(review.expiresAt)) ||
    Date.parse(review.expiresAt) <= Date.parse(review.preparedAt) ||
    Date.parse(review.expiresAt) - Date.parse(review.preparedAt) >
      LIFETIME_MS ||
    !/^[a-f0-9]{64}$/.test(review.sha256)
  )
    throw new Error('Supply action review differs.');
  walletAddress(review.wallet, 'Solana');
  walletAddress(review.mint, 'Solana');
  const supply = supplyUint(review.supplyRaw),
    ppm = supplyUint(review.percentPpm);
  if (
    ppm < 1n ||
    ppm > SEND_PERCENT_SCALE ||
    supplyShare(supply, ppm) !== supplyUint(review.amountRaw) ||
    formatNativeBalance(review.amountRaw, review.decimals) !== review.amount
  )
    throw new Error('Supply action amount differs from its share.');
  const tokenDebit = supplyUint(review.tokenDebitRaw),
    amount = supplyUint(review.amountRaw);
  if (review.kind === 'burn' ? tokenDebit !== amount : tokenDebit < amount)
    throw new Error('Simulated token debit differs from the action.');
  supplyUint(review.feeLamports);
  supplyUint(review.solDebitLamports);
  supplyUint(review.reserveLamports);
  if (review.kind === 'lock') {
    const lock = review.lock;
    if (
      !lock ||
      !Number.isSafeInteger(lock.unlockAt) ||
      !Number.isSafeInteger(lock.durationSeconds) ||
      lock.durationSeconds < MIN_LOCK_SECONDS ||
      lock.durationSeconds > MAX_LOCK_SECONDS ||
      lock.unlockAt !==
        Math.floor(Date.parse(review.preparedAt) / 1000) +
          lock.durationSeconds ||
      lock.name !== streamflowLockName(review.mint)
    )
      throw new Error('Lock terms differ.');
  } else if (review.lock !== undefined) throw new Error('Burns carry no lock.');
  const { source, signers, message } = await supplyActionMessage(review);
  if (source !== review.sourceAccount)
    throw new Error('Supply action token account differs.');
  const bytes = decodeBase64(transaction),
    unsigned = unsignedPacket(signers, message),
    body = 1 + 64 * signers;
  if (
    bytes.length !== unsigned.length ||
    bytes[0] !== signers ||
    bytes.slice(body).some((byte, i) => byte !== message[i]) ||
    (await sha256Hex(unsigned)) !== review.sha256 ||
    encodeBase64(unsigned) !== review.transaction
  )
    throw new Error('Supply action packet differs from its exact review.');
  const keys = [review.wallet, ...(review.lock ? [review.lock.metadata] : [])];
  keys.forEach((key, i) => {
    const signature = bytes.slice(1 + 64 * i, 65 + 64 * i);
    if (
      signed
        ? !verifySolanaSignature(message, signature, bs58.decode(key))
        : signature.some((byte) => byte !== 0)
    )
      throw new Error(
        i === 0
          ? 'Invalid supply action wallet signature.'
          : 'Invalid Streamflow metadata signature.',
      );
  });
  return {
    bytes,
    message,
    signature: signed ? bs58.encode(bytes.slice(1, 65)) : null,
  };
}

/** Browser-only: a throwaway keypair for the Streamflow metadata account. It holds no funds or authority once the lock exists. */
export function generateLockMetadataKey() {
  const pair = nacl.sign.keyPair();
  return { address: bs58.encode(pair.publicKey), secretKey: pair.secretKey };
}

/** Browser-only: signs the exact reviewed packet with the vault key, then wipes the key bytes. */
export async function signSupplyAction(
  session: VaultSession,
  review: TokenSupplyReview,
  assertCurrent: () => void,
  lockMetadataSecret?: Uint8Array,
) {
  const { message } = await inspectSupplyAction(
    review,
    review.transaction,
    false,
  );
  assertCurrent();
  const wallet = session.payload.wallets.find(
    (w) => w.family === 'solana' && w.address === review.wallet,
  );
  if (!wallet || !/^[a-f0-9]{64}$/.test(wallet.seed))
    throw new Error('Reviewed wallet is not in this vault.');
  const seed = Uint8Array.from(wallet.seed.match(/../g)!, (s) =>
      parseInt(s, 16),
    ),
    pair = nacl.sign.keyPair.fromSeed(seed);
  try {
    assertCurrent();
    if (
      Date.parse(review.expiresAt) <= Date.now() ||
      bs58.encode(pair.publicKey) !== review.wallet
    )
      throw new Error('Supply action approval expired or changed.');
    const signatures = [nacl.sign.detached(message, pair.secretKey)];
    if (review.lock) {
      if (
        !lockMetadataSecret ||
        lockMetadataSecret.length !== 64 ||
        bs58.encode(lockMetadataSecret.slice(32)) !== review.lock.metadata
      )
        throw new Error(
          'The Streamflow metadata key for this lock is no longer in this tab. Cancel and prepare again.',
        );
      signatures.push(nacl.sign.detached(message, lockMetadataSecret));
    }
    assertCurrent();
    return {
      signature: bs58.encode(signatures[0]),
      transaction: encodeBase64(
        Uint8Array.from([
          signatures.length,
          ...signatures.flatMap((s) => [...s]),
          ...message,
        ]),
      ),
    };
  } finally {
    seed.fill(0);
    pair.secretKey.fill(0);
  }
}

export async function validatedSupplyAction(
  value: unknown,
): Promise<TokenSupplyAction> {
  const row = value as TokenSupplyAction,
    review = row?.document;
  if (
    !row ||
    !review ||
    row.id !== review.id ||
    row.wallet !== review.wallet ||
    row.walletRevision !== review.walletRevision ||
    row.kind !== review.kind ||
    row.mint !== review.mint ||
    ![
      'awaiting_signature',
      'signing',
      'signed',
      'submitted',
      'finalized',
      'failed',
      'cancelled',
    ].includes(row.state) ||
    !Number.isFinite(Date.parse(row.createdAt)) ||
    !Number.isFinite(Date.parse(row.updatedAt))
  )
    throw new Error('Supply action history differs.');
  await inspectSupplyAction(review, review.transaction, false);
  if (
    ['awaiting_signature', 'signing', 'cancelled'].includes(row.state)
      ? row.signature !== null
      : typeof row.signature !== 'string' ||
        row.signature.length > 90 ||
        bs58.decode(row.signature).length !== 64
  )
    throw new Error('Supply action signature history differs.');
  const r = row.receipt;
  if (row.state === 'finalized' || (row.state === 'failed' && r)) {
    if (
      !r ||
      r.network !== 'mainnet' ||
      r.commitment !== 'finalized' ||
      r.signature !== row.signature ||
      r.failed !== (row.state === 'failed') ||
      !Number.isSafeInteger(r.slot) ||
      r.slot < review.slot
    )
      throw new Error('Supply action receipt differs.');
    const fee = supplyUint(r.networkFeeLamports);
    if (fee > supplyUint(review.feeLamports))
      throw new Error('Supply action receipt fee exceeds approval.');
    if (!r.failed) {
      const tokenChange = BigInt(r.tokenChangeRaw);
      if (
        -tokenChange > supplyUint(review.tokenDebitRaw) ||
        (review.kind === 'burn' &&
          (tokenChange !== -supplyUint(review.amountRaw) ||
            r.supplyChangeRaw !== tokenChange.toString()))
      )
        throw new Error('Supply action receipt units differ.');
    }
  } else if (r !== null) throw new Error('Unexpected supply action receipt.');
  return row;
}
