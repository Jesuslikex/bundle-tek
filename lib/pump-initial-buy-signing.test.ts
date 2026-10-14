import { beforeAll, expect, it } from 'vitest';
import {
  getTransactionDecoder,
  getTransactionEncoder,
  getBase64Decoder,
  address,
} from '@solana/kit-v1';
import bs58 from 'bs58';
import {
  createVault,
  generateVaultWallets,
  type VaultSession,
} from './browser-wallet-vault';
import { pumpCreateFixture } from '../test/pump-launch-fixtures';
import { buildPumpCreateAndBuyMessage } from './pump-initial-buy-message';
import { encodePumpSigningInput } from './pump-launch-signing';
import {
  requirePumpInitialBuySigningReview,
  requirePumpInitialBuyReviewForRecovery,
  signPumpInitialBuy,
  verifyPumpInitialBuySignedPacket,
  type PumpInitialBuySigningReview,
} from './pump-initial-buy-signing';
let payer: VaultSession, mint: VaultSession;
const reviews: PumpInitialBuySigningReview[] = [];
beforeAll(async () => {
  payer = generateVaultWallets(
    await createVault('synthetic initial-buy payer password'),
    'solana',
    1,
  );
  mint = generateVaultWallets(
    await createVault('synthetic initial-buy mint password'),
    'solana',
    1,
  );
  for (const stock of [false, true]) {
    const create = {
      ...(await pumpCreateFixture(stock)),
      payer: payer.payload.wallets[0].address,
      mint: mint.payload.wallets[0].address,
    };
    const input = {
      create,
      tokenAmountRaw: '1000000000000',
      maximumQuoteCostRaw: '100000000',
      transactionVersion: 1 as const,
    };
    const built = await buildPumpCreateAndBuyMessage(input);
    reviews.push({
      id: crypto.randomUUID(),
      projectId: 'synthetic',
      projectUpdatedAt: new Date().toISOString(),
      releaseId: 'a'.repeat(64),
      expiresAt: new Date(Date.now() + 300000).toISOString(),
      transaction: built.transaction,
      sha256: built.packetSha256,
      input: { ...input, create: encodePumpSigningInput(create) },
      developerSupplyPercent: 0.1,
      feeAndRentLimitRaw: '10000000',
    });
  }
});
const consent = (r: PumpInitialBuySigningReview) => ({
  approved: true as const,
  reviewId: r.id,
  sha256: r.sha256,
});
for (const index of [0, 1])
  it(`signs and independently verifies the exact native/stock atomic packet (${index})`, async () => {
    const r = reviews[index];
    const signed = await signPumpInitialBuy(
      payer,
      mint,
      r,
      consent(r),
      () => {},
    );
    expect(await verifyPumpInitialBuySignedPacket(r, signed.transaction)).toBe(
      signed.signature,
    );
    await expect(
      verifyPumpInitialBuySignedPacket(r, r.transaction),
    ).rejects.toThrow('Both exact');
  });
it('requires explicit consent for the exact review and packet', async () => {
  const r = reviews[0];
  for (const approval of [
    undefined,
    { approved: false, reviewId: r.id, sha256: r.sha256 },
    { ...consent(r), reviewId: 'other' },
    { ...consent(r), sha256: '0'.repeat(64) },
  ])
    await expect(
      signPumpInitialBuy(
        payer,
        mint,
        r,
        approval as Parameters<typeof signPumpInitialBuy>[3],
        () => {},
      ),
    ).rejects.toThrow('Explicit approval');
});
it('rejects changed cap, target, percentage, metadata, expiry, allowance and version', async () => {
  const r = reviews[0];
  for (const changed of [
    { ...r, input: { ...r.input, maximumQuoteCostRaw: '100000001' } },
    { ...r, input: { ...r.input, tokenAmountRaw: '1000000000001' } },
    { ...r, developerSupplyPercent: 0.2 },
    {
      ...r,
      input: { ...r.input, create: { ...r.input.create, name: 'Changed' } },
    },
    {
      ...r,
      input: {
        ...r.input,
        create: {
          ...r.input.create,
          uri: 'https://different.example/metadata',
        },
      },
    },
    { ...r, expiresAt: '2000-01-01' },
    { ...r, feeAndRentLimitRaw: '1000000001' },
    { ...r, input: { ...r.input, transactionVersion: 0 } },
  ])
    await expect(
      requirePumpInitialBuySigningReview(
        changed as PumpInitialBuySigningReview,
      ),
    ).rejects.toThrow();
});
it('rejects wrong keys and context changes after reconstruction or during signing', async () => {
  const r = reviews[0];
  await expect(
    signPumpInitialBuy(mint, payer, r, consent(r), () => {}),
  ).rejects.toThrow('exact reviewed');
  for (const threshold of [2, 4]) {
    let checks = 0;
    await expect(
      signPumpInitialBuy(payer, mint, r, consent(r), () => {
        if (++checks === threshold) throw new Error('context changed');
      }),
    ).rejects.toThrow('context changed');
  }
});
it('rejects a missing signature, noncanonical scalar, message mutation and trailing bytes', async () => {
  const r = reviews[0],
    signed = await signPumpInitialBuy(payer, mint, r, consent(r), () => {});
  const decode = () =>
    getTransactionDecoder().decode(
      Uint8Array.from(atob(signed.transaction), (c) => c.charCodeAt(0)),
    );
  const encode = (tx: ReturnType<typeof decode>) =>
    getBase64Decoder().decode(getTransactionEncoder().encode(tx));
  const missing = decode();
  await expect(
    verifyPumpInitialBuySignedPacket(
      r,
      encode({
        ...missing,
        signatures: {
          ...missing.signatures,
          [address(r.input.create.mint)]: null,
        },
      }),
    ),
  ).rejects.toThrow('Both exact');
  const malleable = decode(),
    key = address(r.input.create.payer),
    sig = Uint8Array.from(malleable.signatures[key]!);
  const L = (1n << 252n) + 27742317777372353535851937790883648493n;
  let scalar = 0n;
  for (let i = 63; i >= 32; i--) scalar = (scalar << 8n) + BigInt(sig[i]);
  scalar += L;
  for (let i = 32; i < 64; i++) {
    sig[i] = Number(scalar & 255n);
    scalar >>= 8n;
  }
  await expect(
    verifyPumpInitialBuySignedPacket(
      r,
      encode({
        ...malleable,
        signatures: {
          ...malleable.signatures,
          [key]: sig as NonNullable<(typeof malleable.signatures)[typeof key]>,
        },
      }),
    ),
  ).rejects.toThrow('Both exact');
  const altered = decode(),
    message = Uint8Array.from(altered.messageBytes);
  message[message.length - 1] ^= 1;
  await expect(
    verifyPumpInitialBuySignedPacket(
      r,
      encode({
        ...altered,
        messageBytes: message as unknown as typeof altered.messageBytes,
      }),
    ),
  ).rejects.toThrow('message changed');
  const appended = btoa(atob(signed.transaction) + '\0');
  await expect(verifyPumpInitialBuySignedPacket(r, appended)).rejects.toThrow();
  await expect(
    verifyPumpInitialBuySignedPacket(r, 'A'.repeat(5468)),
  ).rejects.toThrow('Invalid atomic');
  expect(bs58.decode(signed.signature)).toHaveLength(64);
});

it('rejects unexpected atomic options and degenerate signing identities', async () => {
  const r = reviews[0];
  await expect(
    requirePumpInitialBuySigningReview({
      ...r,
      input: { ...r.input, buybackRecipientIndex: 1 },
    } as PumpInitialBuySigningReview),
  ).rejects.toThrow('version differs');
  await expect(
    requirePumpInitialBuySigningReview({
      ...r,
      input: {
        ...r.input,
        create: {
          ...r.input.create,
          payer: '11111111111111111111111111111111',
        },
      },
    }),
  ).rejects.toThrow('signing identity');
});

it('verifies a previously signed packet for expired receipt recovery while refusing new expired signing', async () => {
  const r = reviews[0],
    signed = await signPumpInitialBuy(payer, mint, r, consent(r), () => {});
  const expired = { ...r, expiresAt: '2000-01-01' };
  await expect(
    signPumpInitialBuy(payer, mint, expired, consent(expired), () => {}),
  ).rejects.toThrow('expired');
  expect(
    await verifyPumpInitialBuySignedPacket(expired, signed.transaction),
  ).toBe(signed.signature);
});

it('validates expired unsigned reviews for recovery without granting new signing permission', async () => {
  const expired = { ...reviews[0], expiresAt: '2000-01-01' };
  const tx = await requirePumpInitialBuyReviewForRecovery(expired);
  expect(Object.values(tx.signatures).every((s) => s === null)).toBe(true);
  await expect(requirePumpInitialBuySigningReview(expired)).rejects.toThrow(
    'expired',
  );
  await expect(
    requirePumpInitialBuyReviewForRecovery({
      ...expired,
      sha256: '0'.repeat(64),
    }),
  ).rejects.toThrow('differs');
});
