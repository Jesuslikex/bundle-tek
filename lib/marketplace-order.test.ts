import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { describe, expect, it } from 'vitest';
import type { VaultSession } from './browser-wallet-vault';
import {
  ORDER_ACK,
  inspectOrderPacket,
  openOrderDelivery,
  orderDeliveryKeys,
  sealOrderDelivery,
  signOrderPayment,
  unsignedOrderPacket,
  type OrderDocument,
} from './marketplace-order';

const hex = (b: Uint8Array) =>
  Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const wallet = (n: number) => {
  const seed = new Uint8Array(32).fill(n);
  return {
    seed,
    address: bs58.encode(nacl.sign.keyPair.fromSeed(seed).publicKey),
  };
};
const vault = (...items: ReturnType<typeof wallet>[]) =>
  ({
    payload: {
      version: 1,
      wallets: items.map((w) => ({
        id: crypto.randomUUID(),
        family: 'solana',
        address: w.address,
        seed: hex(w.seed),
        createdAt: new Date().toISOString(),
      })),
    },
  }) as unknown as VaultSession;
const buyer = wallet(3),
  sold = wallet(4),
  payout = wallet(5).address;

async function document(): Promise<OrderDocument> {
  const base = {
    buyerWallet: buyer.address,
    payoutAddress: payout,
    blockhash: bs58.encode(new Uint8Array(32).fill(9)),
    amountLamports: '123456',
  };
  const id = crypto.randomUUID();
  return {
    format: 'bundle-order-v1',
    id,
    reservationId: crypto.randomUUID(),
    reservationSha256: 'a'.repeat(64),
    ...base,
    addresses: [sold.address],
    deliveryPublicKey: orderDeliveryKeys(vault(buyer), buyer.address, id)
      .publicKey,
    lastValidBlockHeight: '100',
    slot: 1,
    ...(await unsignedOrderPacket(base)),
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    acknowledgement: ORDER_ACK,
  };
}

describe('marketplace order', () => {
  it('signs exactly the reviewed transfer and rejects any other packet', async () => {
    const doc = await document();
    const signed = await signOrderPayment(vault(buyer), doc, () => {});
    expect(await inspectOrderPacket(doc, signed.transaction, true)).toBe(
      signed.signature,
    );
    await expect(
      inspectOrderPacket(
        { ...doc, amountLamports: '1' },
        signed.transaction,
        true,
      ),
    ).rejects.toThrow(/differs/);
    await expect(
      signOrderPayment(vault(wallet(6)), doc, () => {}),
    ).rejects.toThrow(/not in this vault/);
  });
  it('delivers a key only the paying wallet can open, and proves it controls the sold address', async () => {
    const doc = await document();
    const delivery = sealOrderDelivery(
      vault(sold),
      sold.address,
      doc.deliveryPublicKey,
    );
    const keys = orderDeliveryKeys(vault(buyer), buyer.address, doc.id);
    expect(keys.publicKey).toBe(doc.deliveryPublicKey);
    const secret = bs58.decode(openOrderDelivery(delivery, keys.secretKey));
    expect(bs58.encode(secret.slice(32))).toBe(sold.address);
    const other = orderDeliveryKeys(
      vault(buyer),
      buyer.address,
      crypto.randomUUID(),
    );
    expect(() => openOrderDelivery(delivery, other.secretKey)).toThrow(
      /could not be opened/,
    );
    expect(() =>
      openOrderDelivery({ ...delivery, address: payout }, keys.secretKey),
    ).toThrow(/does not control/);
  });
});
