import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { verifySolanaSignature } from '@/lib/solana-signature';
import { walletAddress } from './wallet-workspace';
import { UUID } from './wallet-operation';
import type { VaultSession } from './browser-wallet-vault';
import {
  getBase64Decoder,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getCompiledTransactionMessageEncoder,
  getTransactionDecoder,
  getTransactionEncoder,
  type Address,
} from '@solana/kit';
import { reviewUnsignedSwapEnvelope } from './unsigned-swap-order';
import { cleanupPayload, cleanupRounds } from './wallet-cleanup-plan';

// Wallet cleanup: per wallet, one legacy transaction that closes every empty
// (or wrapped-SOL) token account with rent sent to the destination, then
// transfers the remaining SOL minus the network fee. Each packet is rebuilt
// from its review before signing, registration and receipt checks.
export const SYSTEM_PROGRAM = '11111111111111111111111111111111';
export const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
export const WRAPPED_SOL_MINT = 'So11111111111111111111111111111111111111112';
export const CLEANUP_MAX_CLOSE = 20;
export const CLEANUP_MAX_SKIPPED = 30;
export const CLEANUP_MAX_WALLETS = 10;
export const CLEANUP_LIFETIME_MS = 150_000;
export const CLEANUP_MAX_SELLS_PER_WALLET = 3;
export const CLEANUP_MAX_ROWS = 20;
// Ordinary system wallet: 0-byte account rent exemption at the current rent.
export const SYSTEM_RENT_EXEMPT_LAMPORTS = 890_880n;
export const CLEANUP_SIGNATURE_FEE_LAMPORTS = 5_000n;
const U64 = (1n << 64n) - 1n;

export type CleanupTokenProgram =
  | typeof TOKEN_PROGRAM
  | typeof TOKEN_2022_PROGRAM;
export type CleanupClose = {
  address: string;
  program: CleanupTokenProgram;
  mint: string;
  lamports: string;
  kind: 'empty' | 'wrapped-sol';
};
export type CleanupSkipReason =
  | 'holds-tokens'
  | 'frozen'
  | 'foreign-close-authority'
  | 'withheld-fees'
  | 'unsupported-extension'
  | 'over-limit';
export type CleanupSkipped = {
  address: string;
  program: CleanupTokenProgram;
  mint: string;
  amountRaw: string;
  reason: CleanupSkipReason;
};
export type WalletCleanupReview = {
  format: 'wallet-cleanup-v1';
  id: string;
  batchId: string;
  network: 'mainnet';
  wallet: string;
  walletRevision: number;
  destination: string;
  walletLamports: string;
  destinationLamports: string;
  keepLamports: string;
  sweepLamports: string;
  feeLamports: string;
  reclaimLamports: string;
  close: CleanupClose[];
  skipped: CleanupSkipped[];
  skippedCount: number;
  blockhash: string;
  lastValidBlockHeight: string;
  slot: number;
  transaction: string;
  sha256: string;
  preparedAt: string;
  expiresAt: string;
  source: string;
};
/** Jupiter sell of one whole token balance to native SOL, before close + sweep. */
export type WalletCleanupSellReview = {
  format: 'wallet-cleanup-sell-v1';
  id: string;
  batchId: string;
  network: 'mainnet';
  wallet: string;
  walletRevision: number;
  destination: string;
  mint: string;
  decimals: number;
  sourceAccount: string;
  amountRaw: string;
  expectedOutLamports: string;
  minimumOutLamports: string;
  transferLamports: string;
  router: string;
  priceImpactPct: string | null;
  networkFeeLamports: string;
  simulatedNativeChangeLamports: string;
  lastValidBlockHeight: string;
  slot: number;
  transaction: string;
  sha256: string;
  preparedAt: string;
  expiresAt: string;
  source: string;
};
export type WalletCleanupBuyReview = {
  format: 'wallet-cleanup-buy-v1';
  id: string;
  batchId: string;
  network: 'mainnet';
  wallet: string;
  walletRevision: number;
  /** The mint bought back; the seller the SOL came from is not re-checked here. */
  destination: string;
  mint: string;
  decimals: number;
  amountInLamports: string;
  expectedOutRaw: string;
  minimumOutRaw: string;
  router: string;
  priceImpactPct: string | null;
  networkFeeLamports: string;
  simulatedNativeChangeLamports: string;
  lastValidBlockHeight: string;
  slot: number;
  transaction: string;
  sha256: string;
  preparedAt: string;
  expiresAt: string;
  source: string;
};
export type WalletCleanupDocument =
  | WalletCleanupReview
  | WalletCleanupSellReview
  | WalletCleanupBuyReview;
export const isCleanupSell = (
  document: WalletCleanupDocument,
): document is WalletCleanupSellReview =>
  document.format === 'wallet-cleanup-sell-v1';
export const isCleanupBuy = (
  document: WalletCleanupDocument,
): document is WalletCleanupBuyReview =>
  document.format === 'wallet-cleanup-buy-v1';
export type WalletCleanupSellReceipt = {
  kind: 'sell';
  network: 'mainnet';
  commitment: 'finalized';
  signatureVerified: true;
  signature: string;
  wallet: string;
  mint: string;
  soldRaw: string;
  deliveredLamports: string;
  nativeChangeLamports: string;
  networkFeeLamports: string;
  slot: number;
  blockTime: number | null;
  sha256: string;
  observedAt: string;
  source: string;
};
export type WalletCleanupBuyReceipt = {
  kind: 'buy';
  network: 'mainnet';
  commitment: 'finalized';
  signatureVerified: true;
  signature: string;
  wallet: string;
  mint: string;
  boughtRaw: string;
  nativeChangeLamports: string;
  networkFeeLamports: string;
  slot: number;
  blockTime: number | null;
  sha256: string;
  observedAt: string;
  source: string;
};
export type WalletCleanupReceipt = {
  network: 'mainnet';
  commitment: 'finalized';
  signatureVerified: true;
  signature: string;
  wallet: string;
  destination: string;
  networkFeeLamports: string;
  walletChangeLamports: string;
  destinationChangeLamports: string;
  closedAccounts: number;
  slot: number;
  blockTime: number | null;
  sha256: string;
  observedAt: string;
  source: string;
};
export type WalletCleanupFailure = {
  failed: true;
  signature: string;
  error: string;
  networkFeeLamports: string;
  slot: number;
  observedAt: string;
};
export type WalletCleanupState =
  | 'awaiting_signature'
  | 'signing'
  | 'signed'
  | 'submitted'
  | 'finalized'
  | 'failed'
  | 'cancelled';
export type WalletCleanup = {
  id: string;
  batchId: string;
  wallet: string;
  walletRevision: number;
  state: WalletCleanupState;
  signature: string | null;
  document: WalletCleanupDocument;
  receipt: WalletCleanupReceipt | WalletCleanupSellReceipt | WalletCleanupBuyReceipt | null;
  failure: WalletCleanupFailure | null;
  createdAt: string;
  updatedAt: string;
};

export const uint = (value: unknown) => {
  if (
    typeof value !== 'string' ||
    !/^(0|[1-9]\d{0,19})$/.test(value) ||
    BigInt(value) > U64
  )
    throw new Error('Invalid cleanup integer.');
  return BigInt(value);
};
export const encode = (bytes: Uint8Array) => {
  let text = '';
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text);
};
export const decode = (value: unknown) => {
  if (
    typeof value !== 'string' ||
    value.length > 1644 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    )
  )
    throw new Error('Invalid cleanup packet.');
  const bytes = Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
  if (encode(bytes) !== value) throw new Error('Invalid cleanup packet.');
  return bytes;
};
export const sha = async (bytes: Uint8Array) =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes).buffer),
    ),
    (b) => b.toString(16).padStart(2, '0'),
  ).join('');
const key = (value: string) => {
  const bytes = bs58.decode(value);
  if (bytes.length !== 32) throw new Error('Invalid cleanup public key.');
  return bytes;
};

export function cleanupInput(body: Record<string, unknown>) {
  const destination = walletAddress(body.destination, 'Solana');
  if (
    !Array.isArray(body.wallets) ||
    !body.wallets.length ||
    body.wallets.length > CLEANUP_MAX_WALLETS
  )
    throw new Error(`Choose between 1 and ${CLEANUP_MAX_WALLETS} wallets.`);
  const wallets = body.wallets.map((entry) => {
    const value = entry as { address?: unknown; revision?: unknown };
    const address = walletAddress(value?.address, 'Solana');
    if (!Number.isSafeInteger(value?.revision) || Number(value.revision) < 1)
      throw new Error('Current wallet revision required.');
    if (address === destination || address === SYSTEM_PROGRAM)
      throw new Error('Cleanup wallets must differ from the destination.');
    return { address, revision: Number(value.revision) };
  });
  if (new Set(wallets.map((w) => w.address)).size !== wallets.length)
    throw new Error('Remove duplicate cleanup wallets.');
  const keepLamports = uint(body.keepLamports ?? '0');
  if (keepLamports !== 0n && keepLamports < SYSTEM_RENT_EXEMPT_LAMPORTS)
    throw new Error(
      'Keep either 0 SOL or at least the 0.00089088 SOL rent minimum.',
    );
  if (destination === SYSTEM_PROGRAM) throw new Error('Invalid destination.');
  return { destination, wallets, keepLamports };
}

/**
 * Proxima's cleanup payload. Sellers are the input wallets, buyers are the
 * output wallets, and each seller sweeps into its paired buyer.
 */
export function cleanupRunInput(body: Record<string, unknown>) {
  const list = (value: unknown, side: string) => {
    if (!Array.isArray(value))
      throw new Error(`Please select at least one ${side} wallet (${side === 'input' ? 'seller' : 'buyer'})`);
    const addresses = value.map((entry) => walletAddress(entry, 'Solana'));
    if (new Set(addresses).size !== addresses.length)
      throw new Error(`Remove duplicate ${side} wallets.`);
    if (addresses.length > CLEANUP_MAX_WALLETS)
      throw new Error(`Choose at most ${CLEANUP_MAX_WALLETS} ${side} wallets.`);
    return addresses;
  };
  const payload = cleanupPayload({
    inputWalletPubkeys: list(body.input_wallet_pubkeys, 'input'),
    outputWalletPubkeys: list(body.output_wallet_pubkeys, 'output'),
    minDelayMs: Number(body.min_delay_ms),
    maxDelayMs: Number(body.max_delay_ms),
    doubleBuyPct: Number(body.double_buy_pct ?? 0),
    fakeTipPct: Number(body.fake_tip_pct ?? 0),
  });
  return {
    payload,
    rounds: cleanupRounds(
      payload.input_wallet_pubkeys,
      payload.output_wallet_pubkeys,
    ),
  };
}

/** Exact legacy message: close instructions first, then the SOL sweep. */
export function cleanupMessage(input: {
  wallet: string;
  destination: string;
  blockhash: string;
  close: { address: string; program: CleanupTokenProgram }[];
  sweepLamports: bigint;
}) {
  const { wallet, destination, close, sweepLamports } = input;
  if (
    wallet === destination ||
    close.length > CLEANUP_MAX_CLOSE ||
    sweepLamports < 0n ||
    sweepLamports > U64 ||
    (!close.length && sweepLamports === 0n)
  )
    throw new Error('Cleanup has nothing valid to do.');
  const programs = [
    ...(sweepLamports > 0n ? [SYSTEM_PROGRAM] : []),
    ...[TOKEN_PROGRAM, TOKEN_2022_PROGRAM].filter((p) =>
      close.some((c) => c.program === p),
    ),
  ];
  const keys = [
    wallet,
    destination,
    ...close.map((c) => c.address),
    ...programs,
  ];
  if (new Set(keys).size !== keys.length)
    throw new Error('Cleanup accounts must be distinct.');
  if (
    close.some((c) => ![TOKEN_PROGRAM, TOKEN_2022_PROGRAM].includes(c.program))
  )
    throw new Error('Unsupported cleanup token program.');
  const index = (k: string) => keys.indexOf(k);
  const out: number[] = [1, 0, programs.length, keys.length];
  for (const k of keys) out.push(...key(k));
  out.push(...key(input.blockhash));
  out.push(close.length + (sweepLamports > 0n ? 1 : 0));
  for (const c of close)
    out.push(index(c.program), 3, index(c.address), 1, 0, 1, 9);
  if (sweepLamports > 0n) {
    const data = new Uint8Array(12);
    const view = new DataView(data.buffer);
    view.setUint32(0, 2, true);
    view.setBigUint64(4, sweepLamports, true);
    out.push(index(SYSTEM_PROGRAM), 2, 0, 1, 12, ...data);
  }
  const message = Uint8Array.from(out);
  if (message.length + 65 > 1232) throw new Error('Cleanup packet too large.');
  return message;
}


function validClose(c: CleanupClose) {
  walletAddress(c?.address, 'Solana');
  walletAddress(c?.mint, 'Solana');
  return (
    [TOKEN_PROGRAM, TOKEN_2022_PROGRAM].includes(c.program) &&
    ['empty', 'wrapped-sol'].includes(c.kind) &&
    (c.kind !== 'wrapped-sol' || c.mint === WRAPPED_SOL_MINT) &&
    uint(c.lamports) > 0n
  );
}

const ISO_LIMIT = (review: { preparedAt: string; expiresAt: string }) =>
  !Number.isFinite(Date.parse(review.preparedAt)) ||
  !Number.isFinite(Date.parse(review.expiresAt)) ||
  Date.parse(review.expiresAt) <= Date.parse(review.preparedAt) ||
  Date.parse(review.expiresAt) - Date.parse(review.preparedAt) >
    CLEANUP_LIFETIME_MS;

/** Compare a (possibly signed) single-signer packet with its reviewed unsigned bytes. */
async function matchPacket(
  unsignedBase64: string,
  sha256: string,
  wallet: string,
  transaction: string,
  signed: boolean,
  message?: Uint8Array,
) {
  const unsigned = decode(unsignedBase64);
  const reviewed = unsigned.slice(65);
  if (
    unsigned[0] !== 1 ||
    unsigned.slice(1, 65).some((b) => b !== 0) ||
    (message &&
      (message.length !== reviewed.length ||
        message.some((b, i) => b !== reviewed[i]))) ||
    (await sha(unsigned)) !== sha256
  )
    throw new Error('Cleanup packet differs from its exact review.');
  const bytes = decode(transaction);
  if (
    bytes.length !== unsigned.length ||
    bytes[0] !== 1 ||
    bytes.slice(65).some((byte, i) => byte !== reviewed[i])
  )
    throw new Error('Cleanup packet differs from its exact review.');
  const signature = bytes.slice(1, 65);
  if (
    signed
      ? !verifySolanaSignature(reviewed, signature, bs58.decode(wallet))
      : signature.some((byte) => byte !== 0)
  )
    throw new Error('Invalid cleanup wallet signature.');
  return {
    bytes,
    message: reviewed,
    signature: signed ? bs58.encode(signature) : null,
  };
}

async function inspectSell(
  review: WalletCleanupSellReview,
  transaction: string,
  signed: boolean,
) {
  const wallet = walletAddress(review.wallet, 'Solana');
  walletAddress(review.destination, 'Solana');
  walletAddress(review.sourceAccount, 'Solana');
  const mint = walletAddress(review.mint, 'Solana');
  if (
    !UUID.test(review.id) ||
    !UUID.test(review.batchId) ||
    review.network !== 'mainnet' ||
    !Number.isSafeInteger(review.walletRevision) ||
    review.walletRevision < 1 ||
    !Number.isSafeInteger(review.slot) ||
    review.slot < 0 ||
    !Number.isInteger(review.decimals) ||
    review.decimals < 0 ||
    review.decimals > 255 ||
    mint === WRAPPED_SOL_MINT ||
    review.wallet === review.destination ||
    typeof review.router !== 'string' ||
    (review.priceImpactPct !== null &&
      typeof review.priceImpactPct !== 'string') ||
    ISO_LIMIT(review) ||
    !/^[a-f0-9]{64}$/.test(review.sha256) ||
    typeof review.source !== 'string'
  )
    throw new Error('Cleanup sell review differs.');
  const minimum = uint(review.minimumOutLamports);
  if (
    uint(review.amountRaw) === 0n ||
    minimum === 0n ||
    minimum > uint(review.expectedOutLamports) ||
    uint(review.transferLamports) !== minimum ||
    uint(review.networkFeeLamports) < CLEANUP_SIGNATURE_FEE_LAMPORTS
  )
    throw new Error('Cleanup sell amounts differ from the review.');
  uint(review.lastValidBlockHeight);
  if (!/^-?(0|[1-9]\d{0,19})$/.test(review.simulatedNativeChangeLamports))
    throw new Error('Cleanup sell simulation differs.');
  const envelope = await reviewUnsignedSwapEnvelope(review.transaction, wallet);
  if (envelope.sha256 !== review.sha256)
    throw new Error('Cleanup packet differs from its exact review.');
  return matchPacket(
    review.transaction,
    review.sha256,
    wallet,
    transaction,
    signed,
  );
}

async function inspectBuy(
  review: WalletCleanupBuyReview,
  transaction: string,
  signed: boolean,
) {
  const wallet = walletAddress(review.wallet, 'Solana');
  const mint = walletAddress(review.mint, 'Solana');
  if (
    !UUID.test(review.id) ||
    !UUID.test(review.batchId) ||
    review.network !== 'mainnet' ||
    !Number.isSafeInteger(review.walletRevision) ||
    review.walletRevision < 1 ||
    !Number.isSafeInteger(review.slot) ||
    review.slot < 0 ||
    !Number.isInteger(review.decimals) ||
    review.decimals < 0 ||
    review.decimals > 255 ||
    mint === WRAPPED_SOL_MINT ||
    review.destination !== mint ||
    typeof review.router !== 'string' ||
    (review.priceImpactPct !== null &&
      typeof review.priceImpactPct !== 'string') ||
    ISO_LIMIT(review) ||
    !/^[a-f0-9]{64}$/.test(review.sha256) ||
    typeof review.source !== 'string'
  )
    throw new Error('Cleanup buy review differs.');
  if (
    uint(review.amountInLamports) === 0n ||
    uint(review.minimumOutRaw) === 0n ||
    uint(review.minimumOutRaw) > uint(review.expectedOutRaw) ||
    uint(review.networkFeeLamports) < CLEANUP_SIGNATURE_FEE_LAMPORTS
  )
    throw new Error('Cleanup buy amounts differ from the review.');
  uint(review.lastValidBlockHeight);
  if (!/^-?(0|[1-9]\d{0,19})$/.test(review.simulatedNativeChangeLamports))
    throw new Error('Cleanup buy simulation differs.');
  const envelope = await reviewUnsignedSwapEnvelope(review.transaction, wallet);
  if (envelope.sha256 !== review.sha256)
    throw new Error('Cleanup packet differs from its exact review.');
  return matchPacket(
    review.transaction,
    review.sha256,
    wallet,
    transaction,
    signed,
  );
}

export async function inspectWalletCleanup(
  review: WalletCleanupDocument,
  transaction: string,
  signed: boolean,
) {
  if (review && isCleanupBuy(review))
    return inspectBuy(review, transaction, signed);
  if (review && isCleanupSell(review))
    return inspectSell(review, transaction, signed);
  return inspectClose(review as WalletCleanupReview, transaction, signed);
}

async function inspectClose(
  review: WalletCleanupReview,
  transaction: string,
  signed: boolean,
) {
  if (
    !review ||
    review.format !== 'wallet-cleanup-v1' ||
    !UUID.test(review.id) ||
    !UUID.test(review.batchId) ||
    review.network !== 'mainnet' ||
    !Number.isSafeInteger(review.walletRevision) ||
    review.walletRevision < 1 ||
    !Number.isSafeInteger(review.slot) ||
    review.slot < 0 ||
    !Array.isArray(review.close) ||
    !Array.isArray(review.skipped) ||
    review.close.length > CLEANUP_MAX_CLOSE ||
    review.skipped.length > CLEANUP_MAX_SKIPPED ||
    !Number.isSafeInteger(review.skippedCount) ||
    review.skippedCount < review.skipped.length ||
    !review.close.every(validClose) ||
    new Set(review.close.map((c) => c.address)).size !== review.close.length ||
    !Number.isFinite(Date.parse(review.preparedAt)) ||
    !Number.isFinite(Date.parse(review.expiresAt)) ||
    Date.parse(review.expiresAt) <= Date.parse(review.preparedAt) ||
    Date.parse(review.expiresAt) - Date.parse(review.preparedAt) >
      CLEANUP_LIFETIME_MS ||
    !/^[a-f0-9]{64}$/.test(review.sha256) ||
    typeof review.source !== 'string'
  )
    throw new Error('Cleanup review differs.');
  const wallet = walletAddress(review.wallet, 'Solana'),
    destination = walletAddress(review.destination, 'Solana');
  const balance = uint(review.walletLamports),
    keep = uint(review.keepLamports),
    sweep = uint(review.sweepLamports),
    fee = uint(review.feeLamports),
    reclaim = uint(review.reclaimLamports);
  uint(review.destinationLamports);
  uint(review.lastValidBlockHeight);
  if (
    balance !== keep + sweep + fee ||
    (keep !== 0n && keep < SYSTEM_RENT_EXEMPT_LAMPORTS) ||
    fee < CLEANUP_SIGNATURE_FEE_LAMPORTS ||
    review.close.reduce((sum, c) => sum + uint(c.lamports), 0n) !== reclaim
  )
    throw new Error('Cleanup amounts differ from the review.');
  const message = cleanupMessage({
    wallet,
    destination,
    blockhash: review.blockhash,
    close: review.close,
    sweepLamports: sweep,
  });
  return matchPacket(
    review.transaction,
    review.sha256,
    wallet,
    transaction,
    signed,
    message,
  );
}

/** Sign one reviewed cleanup packet with the vault seed, then erase it. */
export async function signWalletCleanup(
  session: VaultSession,
  review: WalletCleanupDocument,
  assertCurrent: () => void,
) {
  const { message } = await inspectWalletCleanup(
    review,
    review.transaction,
    false,
  );
  assertCurrent();
  const wallet = session.payload.wallets.find(
    (w) => w.family === 'solana' && w.address === review.wallet,
  );
  if (!wallet || !/^[a-f0-9]{64}$/.test(wallet.seed))
    throw new Error('Reviewed cleanup wallet is not in this vault.');
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
      throw new Error('Cleanup approval expired or changed.');
    const signature = nacl.sign.detached(message, pair.secretKey);
    return {
      signature: bs58.encode(signature),
      transaction: encode(Uint8Array.from([1, ...signature, ...message])),
    };
  } finally {
    seed.fill(0);
    pair.secretKey.fill(0);
  }
}

/** All-or-nothing: every vault identity is checked before any signature. */
export async function signWalletCleanupBatch(
  session: VaultSession,
  reviews: WalletCleanupDocument[],
  assertCurrent: () => void,
) {
  if (!reviews.length || new Set(reviews.map((r) => r.batchId)).size !== 1)
    throw new Error('Sign one reviewed cleanup batch at a time.');
  for (const review of reviews) {
    await inspectWalletCleanup(review, review.transaction, false);
    if (
      !session.payload.wallets.some(
        (w) => w.family === 'solana' && w.address === review.wallet,
      )
    )
      throw new Error(
        `Wallet ${review.wallet} is not in this vault. Nothing was signed.`,
      );
  }
  const signed: { id: string; signature: string; transaction: string }[] = [];
  for (const review of reviews)
    signed.push({
      id: review.id,
      ...(await signWalletCleanup(session, review, assertCurrent)),
    });
  return signed;
}

export async function validatedWalletCleanup(
  value: unknown,
): Promise<WalletCleanup> {
  const row = value as WalletCleanup,
    review = row?.document;
  if (
    !row ||
    !review ||
    row.id !== review.id ||
    row.batchId !== review.batchId ||
    row.wallet !== review.wallet ||
    row.walletRevision !== review.walletRevision ||
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
    throw new Error('Cleanup history differs.');
  await inspectWalletCleanup(review, review.transaction, false);
  if (
    ['awaiting_signature', 'signing', 'cancelled'].includes(row.state)
      ? row.signature !== null
      : typeof row.signature !== 'string' ||
        bs58.decode(row.signature).length !== 64
  )
    throw new Error('Cleanup signature history differs.');
  const r = row.receipt;
  if (row.state === 'finalized') {
    if (
      !r ||
      r.signature !== row.signature ||
      r.wallet !== row.wallet ||
      r.sha256 !== review.sha256 ||
      (isCleanupBuy(review)
        ? !('kind' in r) ||
          r.kind !== 'buy' ||
          r.mint !== review.mint ||
          uint(r.networkFeeLamports) > uint(review.networkFeeLamports)
        : isCleanupSell(review)
          ? !('kind' in r) ||
            r.kind !== 'sell' ||
            r.mint !== review.mint ||
            r.soldRaw !== review.amountRaw ||
            uint(r.networkFeeLamports) > uint(review.networkFeeLamports)
          : 'kind' in r ||
            r.destination !== review.destination ||
            r.closedAccounts !== review.close.length ||
            uint(r.networkFeeLamports) > uint(review.feeLamports))
    )
      throw new Error('Finalized cleanup receipt differs.');
  } else if (r !== null) throw new Error('Unexpected cleanup receipt.');
  if (
    row.failure &&
    (row.state !== 'failed' || row.failure.signature !== row.signature)
  )
    throw new Error('Unexpected cleanup failure evidence.');
  return row;
}

export function cleanupTotals(documents: WalletCleanupDocument[]) {
  let reclaim = 0n,
    sweep = 0n,
    fee = 0n,
    closed = 0,
    skipped = 0,
    sells = 0,
    buys = 0,
    minimumSellOut = 0n,
    minimumBuyOut = 0n;
  for (const r of documents) {
    if (isCleanupBuy(r)) {
      buys++;
      minimumBuyOut += uint(r.minimumOutRaw);
      fee += uint(r.networkFeeLamports);
      continue;
    }
    if (isCleanupSell(r)) {
      sells++;
      minimumSellOut += uint(r.minimumOutLamports);
      fee += uint(r.networkFeeLamports);
      continue;
    }
    reclaim += uint(r.reclaimLamports);
    sweep += uint(r.sweepLamports);
    fee += uint(r.feeLamports);
    closed += r.close.length;
    skipped += r.skippedCount;
  }
  return {
    reclaim,
    sweep,
    fee,
    received: reclaim + sweep,
    closed,
    skipped,
    sells,
    buys,
    minimumSellOut,
    minimumBuyOut,
  };
}

/**
 * Append a System transfer of `lamports` from the packet payer to `destination`
 * so a sell actually delivers its proceeds to the paired buyer. The swap's own
 * minimum output funds it, so an underdelivering swap reverts the whole packet.
 *
 * Both the destination and the System program are hoisted into the static
 * account list: the runtime only accepts a program id that is statically
 * listed, and it rejects an account that is both static and lookup-loaded.
 */
export function appendSettlementTransfer(
  transaction: string,
  destination: string,
  lamports: bigint,
  loaded: { writable: string[]; readonly: string[] } = {
    writable: [],
    readonly: [],
  },
) {
  const decoded = getTransactionDecoder().decode(
    getBase64Encoder().encode(transaction),
  );
  const message = getCompiledTransactionMessageDecoder().decode(
    decoded.messageBytes,
  ) as Extract<
    ReturnType<ReturnType<typeof getCompiledTransactionMessageDecoder>['decode']>,
    { version: 0 }
  >;
  const target = destination as Address;
  const program = SYSTEM_PROGRAM as Address;
  const base = message.staticAccounts.length;
  const accounts = [...message.staticAccounts];
  const writableTail = base - message.header.numReadonlyNonSignerAccounts;
  const lookups = (message.addressTableLookups ?? []).map((lookup) => ({
    ...lookup,
    writableIndexes: [...lookup.writableIndexes],
    readonlyIndexes: [...lookup.readonlyIndexes],
  }));
  // Drop an address from whichever lookup list carries it, so it can be listed
  // statically without tripping AccountLoadedTwice.
  const removed: number[] = [];
  // Flat positions are the truth: the RPC's loaded lists are concatenated
  // across tables, and per-table arrays can arrive in a different order.
  const locate = (position: number, kind: 'w' | 'r') => {
    let at = position;
    if (kind === 'w') {
      for (const lookup of lookups) {
        if (at < lookup.writableIndexes.length) return { lookup, index: at, writable: true };
        at -= lookup.writableIndexes.length;
      }
      return undefined;
    }
    at -= loaded.writable.length;
    for (const lookup of lookups) {
      if (at < lookup.readonlyIndexes.length) return { lookup, index: at, writable: false };
      at -= lookup.readonlyIndexes.length;
    }
    return undefined;
  };
  const hoist = (address: string, kind: 'w' | 'r') => {
    const flat = kind === 'w' ? loaded.writable : loaded.readonly;
    const hits = flat.reduce<number[]>((all, entry, at) => {
      if (entry === address) all.push(at);
      return all;
    }, []);
    if (!hits.length) return false;
    const offset = kind === 'w' ? 0 : loaded.writable.length;
    for (const position of [...hits].reverse()) {
      const spot = locate(position + offset, kind);
      if (!spot) continue;
      const list = spot.writable ? spot.lookup.writableIndexes : spot.lookup.readonlyIndexes;
      list.splice(spot.index, 1);
      removed.push(position + offset);
    }
    removed.sort((left, right) => left - right);
    return true;
  };
  const addTarget = !accounts.includes(target);
  const addProgram = !accounts.includes(program);
  if (addTarget) hoist(target, 'w') || hoist(target, 'r');
  if (addProgram) hoist(program, 'w') || hoist(program, 'r');
  if (addTarget) accounts.splice(writableTail, 0, target);
  if (addProgram) accounts.push(program);
  const targetIndex = addTarget ? writableTail : accounts.indexOf(target);
  const programIndex = addProgram ? accounts.length - 1 : accounts.indexOf(program);
  const staticAdds = (addTarget ? 1 : 0) + (addProgram ? 1 : 0);
  // Every static addition shifts the lookup region; the writable insertion also
  // shifts the static accounts that follow it.
  const resolve = (index: number) => {
    if (index < base) return message.staticAccounts[index];
    const position = index - base;
    if (position < loaded.writable.length) return loaded.writable[position];
    return loaded.readonly[position - loaded.writable.length];
  };
  const remap = (index: number) => {
    // A hoisted account keeps one identity: every reference moves to its new
    // static slot instead of the lookup position it used to hold.
    const address = resolve(index);
    if (address === program) return programIndex;
    if (address === target) return targetIndex;
    if (index < base)
      return index < writableTail ? index : index + (addTarget ? 1 : 0);
    const position = index - base;
    return index + staticAdds - removed.filter((p) => p < position).length;
  };
  const data = new Uint8Array(12);
  const view = new DataView(data.buffer);
  view.setUint32(0, 2, true);
  view.setBigUint64(4, lamports, true);
  const next = getCompiledTransactionMessageEncoder().encode({
    ...message,
    header: {
      ...message.header,
      numReadonlyNonSignerAccounts:
        message.header.numReadonlyNonSignerAccounts + (addProgram ? 1 : 0),
    },
    staticAccounts: accounts,
    addressTableLookups: lookups,
    instructions: [
      ...message.instructions.map((ix) => ({
        ...ix,
        programAddressIndex: remap(ix.programAddressIndex),
        accountIndices: (ix.accountIndices ?? []).map(remap),
      })),
      { programAddressIndex: programIndex, accountIndices: [0, targetIndex], data },
    ],
  });
  return getBase64Decoder().decode(
    getTransactionEncoder().encode({
      ...decoded,
      messageBytes: next as unknown as typeof decoded.messageBytes,
    } as typeof decoded),
  );
}
