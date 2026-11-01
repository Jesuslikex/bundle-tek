import bs58 from 'bs58';
import nacl from 'tweetnacl';
import type { VaultSession } from './browser-wallet-vault';

/**
 * One-approval SOL distribution between the user's own vault wallets:
 * "Fund all" (funder -> many wallets) and "Return all" (many wallets ->
 * funder). Messages are plain legacy System transfers that both the browser
 * and the server rebuild byte for byte from the same terms, so neither side
 * has to trust the other's packet.
 */

export const SYSTEM_PROGRAM = '11111111111111111111111111111111';
export const RENT_EXEMPT_LAMPORTS = 890_880n;
export const SIGNATURE_FEE_LAMPORTS = 5_000n;
export const FUND_PER_TRANSACTION = 20;
export const RETURN_PER_TRANSACTION = 8;
export const DISTRIBUTION_MAX_WALLETS = 100;
export const LAMPORTS_PER_SOL = 1_000_000_000n;
const MAX_TRANSACTION_BYTES = 1232;

export type DistributionMode = 'fund' | 'return';
export type DistributionTransfer = { address: string; lamports: string };
export type DistributionBatch = {
  mode: DistributionMode;
  funder: string;
  blockhash: string;
  transfers: DistributionTransfer[];
};

export function isSolanaAddress(value: unknown): value is string {
  if (typeof value !== 'string' || value.length < 32 || value.length > 44)
    return false;
  try {
    return bs58.decode(value).length === 32;
  } catch {
    return false;
  }
}

export function lamportsOf(value: unknown): bigint {
  if (typeof value !== 'string' || !/^[1-9]\d{0,18}$/.test(value))
    throw new Error('Invalid lamport amount.');
  const n = BigInt(value);
  if (n > 18_446_744_073_709_551_615n) throw new Error('Amount too large.');
  return n;
}

/** Exact decimal SOL -> lamports (up to 9 decimals). */
export function parseSol(text: string): bigint {
  const value = text.trim();
  if (!/^\d+(\.\d{1,9})?$/.test(value)) throw new Error('Enter a SOL amount.');
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole) * LAMPORTS_PER_SOL + BigInt(fraction.padEnd(9, '0'));
}

export function formatSol(lamports: bigint): string {
  const whole = lamports / LAMPORTS_PER_SOL;
  const fraction = (lamports % LAMPORTS_PER_SOL)
    .toString()
    .padStart(9, '0')
    .replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

/**
 * Per-wallet amounts. Range picks a uniform random amount per wallet,
 * rounded to 0.0001 SOL, from crypto randomness.
 */
export function planAmounts(
  count: number,
  amount: { fixed: bigint } | { min: bigint; max: bigint },
  random: () => number = () =>
    crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32,
): bigint[] {
  if (!Number.isInteger(count) || count < 1) return [];
  if ('fixed' in amount) {
    if (amount.fixed <= 0n) throw new Error('Amount must be above 0.');
    return Array.from({ length: count }, () => amount.fixed);
  }
  const step = 100_000n;
  if (amount.min <= 0n || amount.max < amount.min)
    throw new Error('Set a minimum above 0 and a maximum at least as large.');
  const low = (amount.min + step - 1n) / step,
    high = amount.max / step;
  if (high < low) throw new Error('Range must span at least 0.0001 SOL.');
  const span = Number(high - low + 1n);
  return Array.from(
    { length: count },
    () =>
      (low + BigInt(Math.min(span - 1, Math.floor(random() * span)))) * step,
  );
}

function compact(n: number): number[] {
  const out: number[] = [];
  let value = n;
  for (;;) {
    const byte = value & 0x7f;
    value >>= 7;
    if (!value) {
      out.push(byte);
      return out;
    }
    out.push(byte | 0x80);
  }
}

function transferData(lamports: bigint) {
  const data = new Uint8Array(12);
  const view = new DataView(data.buffer);
  view.setUint32(0, 2, true);
  view.setBigUint64(4, lamports, true);
  return data;
}

export function validateBatch(batch: DistributionBatch) {
  if (batch.mode !== 'fund' && batch.mode !== 'return')
    throw new Error('Unknown distribution mode.');
  if (!isSolanaAddress(batch.funder) || batch.funder === SYSTEM_PROGRAM)
    throw new Error('Invalid funder.');
  if (!isSolanaAddress(batch.blockhash)) throw new Error('Invalid blockhash.');
  const limit =
    batch.mode === 'fund' ? FUND_PER_TRANSACTION : RETURN_PER_TRANSACTION;
  if (
    !Array.isArray(batch.transfers) ||
    !batch.transfers.length ||
    batch.transfers.length > limit
  )
    throw new Error(`Each transaction carries 1 to ${limit} wallets.`);
  const seen = new Set([batch.funder, SYSTEM_PROGRAM]);
  for (const t of batch.transfers) {
    if (!isSolanaAddress(t?.address) || seen.has(t.address))
      throw new Error('Wallets must be distinct and differ from the funder.');
    seen.add(t.address);
    lamportsOf(t.lamports);
  }
}

/** Legacy message bytes. Fund: funder pays. Return: funder pays all fees. */
export function distributionMessage(batch: DistributionBatch): Uint8Array {
  validateBatch(batch);
  const wallets = batch.transfers.map((t) => t.address);
  const fund = batch.mode === 'fund';
  const keys = [batch.funder, ...wallets, SYSTEM_PROGRAM];
  const header = fund
    ? [1, 0, 1] // funder signs; recipients writable; system readonly
    : [1 + wallets.length, 0, 1]; // funder + every source signs
  const bytes: number[] = [...header, ...compact(keys.length)];
  for (const key of keys) bytes.push(...bs58.decode(key));
  bytes.push(...bs58.decode(batch.blockhash));
  bytes.push(...compact(batch.transfers.length));
  const program = keys.length - 1;
  batch.transfers.forEach((t, i) => {
    const wallet = i + 1;
    const [from, to] = fund ? [0, wallet] : [wallet, 0];
    bytes.push(
      program,
      2,
      from,
      to,
      12,
      ...transferData(lamportsOf(t.lamports)),
    );
  });
  return Uint8Array.from(bytes);
}

export function batchSigners(batch: DistributionBatch) {
  return batch.mode === 'fund'
    ? [batch.funder]
    : [batch.funder, ...batch.transfers.map((t) => t.address)];
}

export function batchFee(batch: DistributionBatch) {
  return SIGNATURE_FEE_LAMPORTS * BigInt(batchSigners(batch).length);
}

export function chunkTransfers(
  mode: DistributionMode,
  transfers: DistributionTransfer[],
) {
  const size = mode === 'fund' ? FUND_PER_TRANSACTION : RETURN_PER_TRANSACTION;
  const out: DistributionTransfer[][] = [];
  for (let i = 0; i < transfers.length; i += size)
    out.push(transfers.slice(i, i + size));
  return out;
}

export const toBase64 = (bytes: Uint8Array) => {
  let text = '';
  for (const b of bytes) text += String.fromCharCode(b);
  return btoa(text);
};
export const fromBase64 = (value: string) =>
  Uint8Array.from(atob(value), (c) => c.charCodeAt(0));

/** Splits a signed wire transaction and checks it is exactly this batch, fully signed. */
export function verifySignedBatch(batch: DistributionBatch, wire: string) {
  const message = distributionMessage(batch);
  const signers = batchSigners(batch);
  const bytes = fromBase64(wire);
  if (bytes.length > MAX_TRANSACTION_BYTES)
    throw new Error('Transaction too large.');
  const prefix = compact(signers.length);
  if (prefix.some((b, i) => bytes[i] !== b))
    throw new Error('Signature count differs.');
  const start = prefix.length + 64 * signers.length;
  const body = bytes.subarray(start);
  if (body.length !== message.length || body.some((b, i) => b !== message[i]))
    throw new Error('Transaction differs from its reviewed transfers.');
  const signatures = signers.map((signer, i) => {
    const signature = bytes.subarray(
      prefix.length + 64 * i,
      prefix.length + 64 * (i + 1),
    );
    if (!nacl.sign.detached.verify(message, signature, bs58.decode(signer)))
      throw new Error('Transaction signature is invalid.');
    return bs58.encode(signature);
  });
  return { signature: signatures[0], signatures };
}

/** Signs one batch with every required vault key. Throws before signing if any key is missing. */
export function signDistributionBatch(
  session: VaultSession,
  batch: DistributionBatch,
): { transaction: string; signature: string } {
  const message = distributionMessage(batch);
  const signers = batchSigners(batch);
  const wallets = signers.map((address) => {
    const wallet = session.payload.wallets.find(
      (w) => w.family === 'solana' && w.address === address,
    );
    if (!wallet || !/^[a-f0-9]{64}$/.test(wallet.seed))
      throw new Error(
        `Wallet ${address} is not in this browser vault. Nothing was signed.`,
      );
    return wallet;
  });
  const signatures: Uint8Array[] = [];
  for (const wallet of wallets) {
    const seed = Uint8Array.from(wallet.seed.match(/../g)!, (s) =>
      parseInt(s, 16),
    );
    const pair = nacl.sign.keyPair.fromSeed(seed);
    try {
      if (bs58.encode(pair.publicKey) !== wallet.address)
        throw new Error('Vault key does not match its address.');
      signatures.push(nacl.sign.detached(message, pair.secretKey));
    } finally {
      seed.fill(0);
      pair.secretKey.fill(0);
    }
  }
  const wire = Uint8Array.from([
    ...compact(signers.length),
    ...signatures.flatMap((s) => [...s]),
    ...message,
  ]);
  if (wire.length > MAX_TRANSACTION_BYTES)
    throw new Error('Transaction too large.');
  return {
    transaction: toBase64(wire),
    signature: bs58.encode(signatures[0]),
  };
}
