import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { z } from 'zod';
import { verifySolanaSignature } from './solana-signature';
import { walletAddress } from './wallet-workspace';
import type { VaultSession } from './browser-wallet-vault';
import { cleanupMessage, decode, encode, sha } from './wallet-cleanup';

/**
 * Bundle marketplace checkout. A buyer with a held reservation pays the exact
 * asking price in one native SOL transfer from a verified own wallet to the
 * Bundle payout wallet, signed in the browser and sent once. After the
 * finalized payment, the seller's browser encrypts each sold wallet's key to
 * a delivery key only the buyer's paying wallet can derive, so the server
 * only ever stores ciphertext.
 */
export const ORDER_ACK =
  'Pay the exact asking price once from my selected wallet to Bundle for these reserved wallets. Bundle delivers their private keys encrypted to me; previous key copies may exist and sold wallets are not refundable.';
export const ORDER_PAYMENT_WINDOW_MS = 60_000;
export const DELIVERY_CONTEXT = 'bundle-marketplace-delivery-v1';
const base64 = (n: number) =>
  z
    .string()
    .length(n)
    .regex(/^[A-Za-z0-9+/]+={0,2}$/);
export const deliveryPublicKey = base64(44);
const solana = z.string().refine((v) => {
  try {
    walletAddress(v, 'Solana');
    return true;
  } catch {
    return false;
  }
}, 'Solana address required.');
const lamports = z
  .string()
  .regex(/^[1-9]\d{0,19}$/)
  .refine((v) => BigInt(v) <= (1n << 64n) - 1n);
export const orderDocument = z
  .object({
    format: z.literal('bundle-order-v1'),
    id: z.uuid(),
    reservationId: z.uuid(),
    reservationSha256: z.string().regex(/^[a-f0-9]{64}$/),
    buyerWallet: solana,
    payoutAddress: solana,
    amountLamports: lamports,
    addresses: z.array(solana).min(1).max(200),
    deliveryPublicKey,
    blockhash: solana,
    lastValidBlockHeight: z.string().regex(/^\d{1,20}$/),
    slot: z.number().int().nonnegative(),
    transaction: z.string().max(1700),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    createdAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
    acknowledgement: z.literal(ORDER_ACK),
  })
  .strict();
export type OrderDocument = z.infer<typeof orderDocument>;
export const orderDelivery = z
  .object({
    address: solana,
    senderPublicKey: base64(44),
    nonce: base64(32),
    ciphertext: base64(64),
  })
  .strict();
export type OrderDelivery = z.infer<typeof orderDelivery>;
export type OrderState =
  | 'awaiting_payment'
  | 'signed'
  | 'submitted'
  | 'paid'
  | 'failed'
  | 'cancelled';
export type MarketplaceOrder = {
  document: OrderDocument;
  state: OrderState;
  signature: string | null;
  receipt: Record<string, unknown> | null;
  updatedAt: string;
  deliveries: OrderDelivery[];
};

/** The exact legacy message: one System transfer of the asking price. */
export function orderPaymentMessage(
  document: Pick<
    OrderDocument,
    'buyerWallet' | 'payoutAddress' | 'blockhash' | 'amountLamports'
  >,
) {
  return cleanupMessage({
    wallet: document.buyerWallet,
    destination: document.payoutAddress,
    blockhash: document.blockhash,
    close: [],
    sweepLamports: BigInt(document.amountLamports),
  });
}

export async function unsignedOrderPacket(
  document: Pick<
    OrderDocument,
    'buyerWallet' | 'payoutAddress' | 'blockhash' | 'amountLamports'
  >,
) {
  const message = orderPaymentMessage(document);
  const bytes = Uint8Array.from([1, ...new Uint8Array(64), ...message]);
  return { transaction: encode(bytes), sha256: await sha(bytes) };
}

/** Checks a packet against the exact reviewed payment; returns its signature when signed. */
export async function inspectOrderPacket(
  document: OrderDocument,
  transaction: string,
  signed: boolean,
) {
  const expected = await unsignedOrderPacket(document);
  if (
    expected.transaction !== document.transaction ||
    expected.sha256 !== document.sha256
  )
    throw new Error('Order payment differs from its exact review.');
  const message = orderPaymentMessage(document);
  const bytes = decode(transaction);
  if (
    bytes.length !== message.length + 65 ||
    bytes[0] !== 1 ||
    bytes.slice(65).some((b, i) => b !== message[i])
  )
    throw new Error('Order payment differs from its exact review.');
  const signature = bytes.slice(1, 65);
  if (
    signed
      ? !verifySolanaSignature(
          message,
          signature,
          bs58.decode(document.buyerWallet),
        )
      : signature.some((b) => b !== 0)
  )
    throw new Error('Invalid order payment signature.');
  return signed ? bs58.encode(signature) : null;
}

function walletSeed(session: VaultSession, address: string) {
  const wallet = session.payload.wallets.find(
    (w) => w.family === 'solana' && w.address === address,
  );
  if (!wallet || !/^[a-f0-9]{64}$/.test(wallet.seed))
    throw new Error(`Wallet ${address} is not in this vault.`);
  return Uint8Array.from(wallet.seed.match(/../g)!, (s) => parseInt(s, 16));
}

/**
 * The buyer's delivery key for one order: derived from the paying wallet's
 * seed and the order ID, so it can be re-derived after any reload and never
 * leaves the browser.
 */
export function orderDeliveryKeys(
  session: VaultSession,
  buyerWallet: string,
  orderId: string,
) {
  const seed = walletSeed(session, buyerWallet);
  const context = new TextEncoder().encode(`${DELIVERY_CONTEXT}:${orderId}`);
  const material = new Uint8Array(seed.length + context.length);
  material.set(seed);
  material.set(context, seed.length);
  const digest = nacl.hash(material);
  seed.fill(0);
  material.fill(0);
  const pair = nacl.box.keyPair.fromSecretKey(digest.slice(0, 32));
  digest.fill(0);
  return { publicKey: encode(pair.publicKey), secretKey: pair.secretKey };
}

export async function signOrderPayment(
  session: VaultSession,
  document: OrderDocument,
  assertCurrent: () => void,
) {
  await inspectOrderPacket(document, document.transaction, false);
  const message = orderPaymentMessage(document);
  const seed = walletSeed(session, document.buyerWallet),
    pair = nacl.sign.keyPair.fromSeed(seed);
  try {
    assertCurrent();
    if (
      bs58.encode(pair.publicKey) !== document.buyerWallet ||
      Date.parse(document.expiresAt) <= Date.now()
    )
      throw new Error('Order payment expired or changed.');
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

/** Seller side: encrypts one sold wallet's seed to the buyer's delivery key. */
export function sealOrderDelivery(
  session: VaultSession,
  address: string,
  buyerPublicKey: string,
): OrderDelivery {
  const recipient = decode(deliveryPublicKey.parse(buyerPublicKey));
  if (recipient.length !== 32) throw new Error('Delivery key differs.');
  const seed = walletSeed(session, address);
  const sender = nacl.box.keyPair();
  const nonce = nacl.randomBytes(nacl.box.nonceLength);
  try {
    const sealed = nacl.box(seed, nonce, recipient, sender.secretKey);
    return orderDelivery.parse({
      address,
      senderPublicKey: encode(sender.publicKey),
      nonce: encode(nonce),
      ciphertext: encode(sealed),
    });
  } finally {
    seed.fill(0);
    sender.secretKey.fill(0);
  }
}

/** Buyer side: opens a delivery and proves the key controls the sold address. */
export function openOrderDelivery(
  delivery: OrderDelivery,
  secretKey: Uint8Array,
) {
  const value = orderDelivery.parse(delivery);
  const opened = nacl.box.open(
    decode(value.ciphertext),
    decode(value.nonce),
    decode(value.senderPublicKey),
    secretKey,
  );
  if (!opened || opened.length !== 32)
    throw new Error(`Delivery for ${value.address} could not be opened.`);
  const pair = nacl.sign.keyPair.fromSeed(opened);
  try {
    if (bs58.encode(pair.publicKey) !== value.address)
      throw new Error(
        `Delivered key does not control ${value.address}. Report this delivery.`,
      );
    return bs58.encode(pair.secretKey);
  } finally {
    opened.fill(0);
    pair.secretKey.fill(0);
  }
}
