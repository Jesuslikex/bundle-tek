import {
  validatedWithdrawalFailure,
  type NativeWithdrawalFailureReceipt,
} from './withdrawal-failure';
import bs58 from 'bs58';
import { validatedFundingCapture } from './mainnet-funding';
import { solanaTransferMessage } from './solana-transfer-message';
import nacl from 'tweetnacl';
import { verifySolanaSignature } from '@/lib/solana-signature';
import { walletAddress } from './wallet-workspace';
import { solanaTokenAtoms } from './solana-token-amount';
import { formatNativeBalance } from './wallet-balance-format';
import { UUID } from './wallet-operation';
import type { VaultSession } from './browser-wallet-vault';
import {
  TOKEN_2022,
  withdrawalTransferFee,
  type WithdrawalTransferFee,
} from './token-withdrawal-fee';
const SYSTEM = '11111111111111111111111111111111';
const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const decode = (value: string) => {
  if (
    typeof value !== 'string' ||
    value.length > 1644 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    )
  )
    throw new Error('Invalid withdrawal packet.');
  const bytes = Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
  if (encode(bytes) !== value) throw new Error();
  return bytes;
};
const uint = (value: unknown) => {
  if (
    typeof value !== 'string' ||
    !/^(0|[1-9]\d{0,19})$/.test(value) ||
    BigInt(value) > (1n << 64n) - 1n
  )
    throw new Error('Invalid withdrawal integer.');
  return BigInt(value);
};
const sha = async (bytes: Uint8Array) =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes).buffer),
    ),
    (b) => b.toString(16).padStart(2, '0'),
  ).join('');
export type NativeWithdrawalReview = {
  funding?: import('./mainnet-funding').FundingCapture;
  id: string;
  network: 'mainnet';
  wallet: string;
  walletRevision: number;
  recipient: string;
  amountRaw: string;
  amount: string;
  feeLamports: string;
  reserveLamports: string;
  maximumDebitRaw: string;
  blockhash: string;
  lastValidBlockHeight: string;
  slot: number;
  transaction: string;
  sha256: string;
  preparedAt: string;
  expiresAt: string;
  source: string;
  token?: {
    mint: string;
    decimals: number;
    program: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' | typeof TOKEN_2022;
    mintExtensions?: string[];
    transferFee?: WithdrawalTransferFee;
    sourceAccount: string;
    destinationAccount: string;
    createAccount: boolean;
    accountRentLamports: string;
  };
};
export type NativeWithdrawal = {
  id: string;
  wallet: string;
  walletRevision: number;
  state:
    | 'awaiting_signature'
    | 'signing'
    | 'signed'
    | 'submitted'
    | 'finalized'
    | 'failed'
    | 'cancelled';
  signature: string | null;
  document: NativeWithdrawalReview;
  receipt: NativeWithdrawalReceipt | null;
  failureReceipt?: NativeWithdrawalFailureReceipt | null;
  createdAt: string;
  updatedAt: string;
};
export type NativeWithdrawalReceipt = {
  network: 'mainnet';
  commitment: 'finalized';
  signatureVerified: true;
  signature: string;
  wallet: string;
  recipient: string;
  amountRaw: string;
  networkFeeLamports: string;
  walletChangeRaw: string;
  recipientChangeRaw: string;
  slot: number;
  blockTime: number | null;
  sha256: string;
  observedAt: string;
  source: string;
  token?: {
    mint: string;
    decimals: number;
    sourceAccount: string;
    destinationAccount: string;
    sourceChangeRaw: string;
    destinationChangeRaw: string;
    accountRentLamports: string;
    transferFeeRaw?: string;
  };
};
export function tokenWithdrawalInput(
  wallet: unknown,
  recipient: unknown,
  amount: unknown,
  revision: unknown,
  mint: unknown,
  decimals: unknown,
) {
  const base = withdrawalInput(wallet, recipient, '0.000000001', revision);
  if (
    !Number.isInteger(decimals) ||
    Number(decimals) < 0 ||
    Number(decimals) > 255
  )
    throw new Error('Valid token precision required.');
  const tokenMint = walletAddress(mint, 'Solana');
  if (
    [
      base.wallet,
      base.recipient,
      SYSTEM,
      'So11111111111111111111111111111111111111112',
    ].includes(tokenMint)
  )
    throw new Error(
      'Choose an ordinary SPL mint. Use SOL withdrawal for native SOL.',
    );
  const raw = solanaTokenAtoms(amount, Number(decimals)).toString();
  return {
    ...base,
    amountRaw: raw,
    amount: formatNativeBalance(raw, Number(decimals)),
    mint: tokenMint,
    decimals: Number(decimals),
  };
}
export function withdrawalInput(
  wallet: unknown,
  recipient: unknown,
  amount: unknown,
  revision: unknown,
) {
  const from = walletAddress(wallet, 'Solana'),
    to = walletAddress(recipient, 'Solana');
  if (
    from === to ||
    from === SYSTEM ||
    to === SYSTEM ||
    !Number.isSafeInteger(revision) ||
    Number(revision) < 1
  )
    throw new Error(
      'Choose different ordinary wallets and the current wallet revision.',
    );
  const amountRaw = solanaTokenAtoms(amount, 9).toString();
  return {
    wallet: from,
    recipient: to,
    amountRaw,
    amount: formatNativeBalance(amountRaw, 9),
    walletRevision: Number(revision),
  };
}
export async function inspectNativeWithdrawal(
  review: NativeWithdrawalReview,
  transaction: string,
  signed: boolean,
) {
  if (
    !review ||
    !UUID.test(review.id) ||
    review.network !== 'mainnet' ||
    !Number.isSafeInteger(review.walletRevision) ||
    review.walletRevision < 1 ||
    !Number.isSafeInteger(review.slot) ||
    review.slot < 0 ||
    !Number.isFinite(Date.parse(review.preparedAt)) ||
    !Number.isFinite(Date.parse(review.expiresAt)) ||
    Date.parse(review.expiresAt) - Date.parse(review.preparedAt) > 60000 ||
    Date.parse(review.expiresAt) <= Date.parse(review.preparedAt) ||
    !/^(?:[a-f0-9]{64})$/.test(review.sha256)
  )
    throw new Error('Withdrawal review differs.');
  if (review.funding) {
    validatedFundingCapture(review.funding);
  }
  const input = review.token
    ? tokenWithdrawalInput(
        review.wallet,
        review.recipient,
        review.amount,
        review.walletRevision,
        review.token.mint,
        review.token.decimals,
      )
    : withdrawalInput(
        review.wallet,
        review.recipient,
        review.amount,
        review.walletRevision,
      );
  if (
    input.amountRaw !== review.amountRaw ||
    (review.token
      ? uint(review.token.accountRentLamports)
      : uint(review.amountRaw)) +
      uint(review.feeLamports) !==
      uint(review.maximumDebitRaw)
  )
    throw new Error('Withdrawal amount or debit differs.');
  uint(review.reserveLamports);
  uint(review.lastValidBlockHeight);
  let message: Uint8Array;
  if (review.token) {
    const token = review.token;
    if (
      !['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', TOKEN_2022].includes(
        token.program,
      ) ||
      typeof token.createAccount !== 'boolean' ||
      (!token.createAccount && token.accountRentLamports !== '0')
    )
      throw new Error('Token withdrawal program or account creation differs.');
    if (token.program === TOKEN_2022) {
      const names = token.mintExtensions;
      if (
        !Array.isArray(names) ||
        new Set(names).size !== names.length ||
        names.some(
          (n) =>
            !['MetadataPointer', 'TokenMetadata', 'TransferFeeConfig'].includes(
              n,
            ),
        ) ||
        names.includes('TransferFeeConfig') !== Boolean(token.transferFee)
      )
        throw new Error('Token-2022 extension review differs.');
    } else if (token.transferFee || token.mintExtensions !== undefined)
      throw new Error('Unexpected standard SPL extension review.');
    if (token.transferFee) {
      const f = token.transferFee;
      uint(f.epoch);
      if (
        !/^[a-f0-9]{64}$/.test(f.configSha256) ||
        withdrawalTransferFee(
          uint(review.amountRaw),
          f.basisPoints,
          uint(f.maximumFeeRaw),
        ) !== uint(f.feeRaw) ||
        uint(f.netAmountRaw) !== uint(review.amountRaw) - uint(f.feeRaw) ||
        uint(f.netAmountRaw) === 0n
      )
        throw new Error('Token transfer fee or net amount differs.');
    }
    const { solanaTokenTransferMessage } =
      await import('./solana-token-transfer-message');
    const packet = await solanaTokenTransferMessage({
      funder: review.wallet,
      recipient: review.recipient,
      mint: token.mint,
      decimals: token.decimals,
      raw: uint(review.amountRaw),
      blockhash: review.blockhash,
      lastValidBlockHeight: uint(review.lastValidBlockHeight),
      createAccount: token.createAccount,
      tokenProgram: token.program,
      transferFee: token.transferFee
        ? uint(token.transferFee.feeRaw)
        : undefined,
    });
    if (
      packet.source !== token.sourceAccount ||
      packet.destination !== token.destinationAccount
    )
      throw new Error('Token withdrawal associated accounts differ.');
    message = packet.message;
  } else
    message = solanaTransferMessage(
      review.wallet,
      review.recipient,
      review.blockhash,
      uint(review.amountRaw),
    );
  const bytes = decode(transaction),
    unsigned = Uint8Array.from([1, ...new Uint8Array(64), ...message]);
  if (
    bytes.length !== unsigned.length ||
    bytes[0] !== 1 ||
    bytes.slice(65).some((byte, i) => byte !== message[i]) ||
    (await sha(unsigned)) !== review.sha256 ||
    encode(unsigned) !== review.transaction
  )
    throw new Error('Withdrawal packet differs from its exact review.');
  const signature = bytes.slice(1, 65);
  if (
    signed
      ? !verifySolanaSignature(message, signature, bs58.decode(review.wallet))
      : signature.some((byte) => byte !== 0)
  )
    throw new Error('Invalid withdrawal wallet signature.');
  return { bytes, message, signature: signed ? bs58.encode(signature) : null };
}
export async function signNativeWithdrawal(
  session: VaultSession,
  review: NativeWithdrawalReview,
  assertCurrent: () => void,
) {
  const { message } = await inspectNativeWithdrawal(
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
      throw new Error('Withdrawal approval expired or changed.');
    const signature = nacl.sign.detached(message, pair.secretKey);
    const transaction = encode(Uint8Array.from([1, ...signature, ...message]));
    assertCurrent();
    return { signature: bs58.encode(signature), transaction };
  } finally {
    seed.fill(0);
    pair.secretKey.fill(0);
  }
}
export async function validatedNativeWithdrawal(
  value: unknown,
): Promise<NativeWithdrawal> {
  const row = value as NativeWithdrawal,
    review = row?.document;
  if (
    !row ||
    !review ||
    row.id !== review.id ||
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
    throw new Error('Withdrawal history context differs.');
  await inspectNativeWithdrawal(review, review.transaction, false);
  if (
    ['awaiting_signature', 'signing', 'cancelled'].includes(row.state)
      ? row.signature !== null
      : typeof row.signature !== 'string' ||
        row.signature.length > 90 ||
        bs58.decode(row.signature).length !== 64
  )
    throw new Error('Withdrawal signature history differs.');
  const r = row.receipt;
  if (row.state === 'finalized') {
    if (
      !r ||
      r.network !== 'mainnet' ||
      r.commitment !== 'finalized' ||
      r.signatureVerified !== true ||
      r.signature !== row.signature ||
      r.wallet !== row.wallet ||
      r.recipient !== review.recipient ||
      r.amountRaw !== review.amountRaw ||
      r.sha256 !== review.sha256 ||
      uint(r.networkFeeLamports) > uint(review.feeLamports) ||
      r.walletChangeRaw !==
        (-(
          uint(review.token ? r.token?.accountRentLamports : r.amountRaw) +
          uint(r.networkFeeLamports)
        )).toString() ||
      r.recipientChangeRaw !== (review.token ? '0' : r.amountRaw) ||
      !Number.isSafeInteger(r.slot) ||
      r.slot < 0 ||
      !Number.isFinite(Date.parse(r.observedAt))
    )
      throw new Error('Finalized withdrawal receipt differs.');
    if (
      review.token
        ? !r.token ||
          r.token.mint !== review.token.mint ||
          r.token.decimals !== review.token.decimals ||
          r.token.sourceAccount !== review.token.sourceAccount ||
          r.token.destinationAccount !== review.token.destinationAccount ||
          r.token.sourceChangeRaw !== (-uint(review.amountRaw)).toString() ||
          r.token.destinationChangeRaw !==
            (review.token.transferFee?.netAmountRaw ?? review.amountRaw) ||
          r.token.transferFeeRaw !== review.token.transferFee?.feeRaw ||
          uint(r.token.accountRentLamports) >
            uint(review.token.accountRentLamports)
        : r.token !== undefined
    )
      throw new Error('Finalized token withdrawal receipt differs.');
  } else if (r !== null) throw new Error('Unexpected withdrawal receipt.');
  if (row.failureReceipt !== undefined && row.failureReceipt !== null) {
    if (row.state !== 'failed' || !row.signature)
      throw new Error('Unexpected withdrawal failure evidence.');
    validatedWithdrawalFailure(row.failureReceipt, review, row.signature);
  }
  return row;
}
