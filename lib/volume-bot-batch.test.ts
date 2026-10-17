import { beforeAll, expect, it } from 'vitest';
import {
  createVault,
  generateVaultWallets,
  type VaultSession,
} from './browser-wallet-vault';
import { solanaTransferMessage } from './solana-funding';
import {
  createVolumeBatchReview,
  requireVolumeBatchReview,
  signVolumeBatch,
  verifyVolumeBatchSigned,
  volumeBatchConsent,
  type VolumeBatchTrade,
} from './volume-bot-batch';

const OTHER = '8phnoC6V8nwYnNUwobNBoWzWAmyP1nj9GyYZaMbU8z4';
let vault: VaultSession, wallets: string[];
beforeAll(async () => {
  vault = generateVaultWallets(
    await createVault('synthetic volume batch vault'),
    'solana',
    2,
  );
  wallets = vault.payload.wallets.map((w) => w.address);
});
const sha = async (bytes: Uint8Array) =>
  Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.slice().buffer)),
    (b) => b.toString(16).padStart(2, '0'),
  ).join('');
async function trade(
  wallet: string,
  index: number,
  offset: number,
): Promise<VolumeBatchTrade> {
  const bytes = Uint8Array.from([
    1,
    ...new Uint8Array(64),
    128,
    ...solanaTransferMessage(
      wallet,
      OTHER,
      '11111111111111111111111111111111',
      BigInt(index + 1),
    ),
    0,
  ]);
  return {
    index,
    round: index,
    side: 'Buy',
    wallet,
    batchOffsetMs: offset,
    inAmountRaw: '100000000',
    minimumOutRaw: '995',
    estimatedFeesLamports: '5000',
    transaction: btoa(String.fromCharCode(...bytes)),
    packetSha256: await sha(bytes),
    lastValidBlockHeight: '1000',
  };
}
const review = async (trades: VolumeBatchTrade[], expires = 60_000) =>
  createVolumeBatchReview({
    id: crypto.randomUUID(),
    sessionId: 's1',
    batch: 0,
    mint: OTHER,
    decimals: 6,
    trades,
    skipped: [],
    expiresAt: new Date(Date.now() + expires).toISOString(),
  });

it('signs every trade with its own wallet and verifies the whole batch', async () => {
  const batch = await review([
    await trade(wallets[0], 0, 0),
    await trade(wallets[1], 1, 4_000),
  ]);
  const signed = await signVolumeBatch(
    vault,
    batch,
    volumeBatchConsent(batch),
    () => {},
  );
  expect(signed.signed).toHaveLength(2);
  expect(
    await verifyVolumeBatchSigned(
      batch,
      signed.signed.map((s) => s.transaction),
    ),
  ).toEqual(signed.signed.map((s) => s.signature));
  // Swapped order is a different batch.
  await expect(
    verifyVolumeBatchSigned(
      batch,
      signed.signed.map((s) => s.transaction).reverse(),
    ),
  ).rejects.toThrow(/differs/);
});

it('refuses edited reviews, repeated wallets, unordered offsets and long spans', async () => {
  const batch = await review([await trade(wallets[0], 0, 0)]);
  await expect(
    requireVolumeBatchReview({ ...batch, mint: wallets[1] }),
  ).rejects.toThrow(/changed/);
  await expect(
    review([await trade(wallets[0], 0, 0), await trade(wallets[0], 1, 10)]),
  ).rejects.toThrow(/once per volume batch/);
  await expect(
    review([await trade(wallets[0], 0, 5_000), await trade(wallets[1], 1, 0)]),
  ).rejects.toThrow(/ordered/);
  await expect(
    review([await trade(wallets[0], 0, 31_000)]),
  ).rejects.toThrow(/within 30 seconds/);
});

it('refuses signing without exact consent, with a missing key or after expiry', async () => {
  const batch = await review([await trade(wallets[0], 0, 0)]);
  await expect(
    signVolumeBatch(
      vault,
      batch,
      { ...volumeBatchConsent(batch), scope: 'other' as 'volume-bot-batch' },
      () => {},
    ),
  ).rejects.toThrow(/Explicit approval/);
  const other = generateVaultWallets(
    await createVault('another synthetic vault'),
    'solana',
    1,
  );
  await expect(
    signVolumeBatch(other, batch, volumeBatchConsent(batch), () => {}),
  ).rejects.toThrow(/Unlock every exact wallet/);
  const expired = await review([await trade(wallets[0], 0, 0)], 5);
  await new Promise((r) => setTimeout(r, 10));
  await expect(
    signVolumeBatch(vault, expired, volumeBatchConsent(expired), () => {}),
  ).rejects.toThrow(/expired/);
});
