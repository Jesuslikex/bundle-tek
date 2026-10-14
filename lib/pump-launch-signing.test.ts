import { beforeAll, expect, it } from 'vitest';
import { pumpLaunchFixture } from '../test/pump-launch-fixture';
import {
  createVault,
  generateVaultWallets,
  type VaultSession,
} from './browser-wallet-vault';
import { buildPumpCreateMessage } from './pump-launch-message';
import {
  encodePumpSigningInput,
  requirePumpSigningReview,
  signPumpLaunch,
  verifyPumpSignedPacket,
  type PumpSigningReview,
} from './pump-launch-signing';
let payer: VaultSession, mint: VaultSession, review: PumpSigningReview;
beforeAll(async () => {
  payer = generateVaultWallets(
    await createVault('synthetic payer password'),
    'solana',
    1,
  );
  mint = generateVaultWallets(
    await createVault('synthetic mint password'),
    'solana',
    1,
  );
  const f = await pumpLaunchFixture(),
    input = {
      ...f.input(),
      payer: payer.payload.wallets[0].address,
      mint: mint.payload.wallets[0].address,
    };
  const packet = await buildPumpCreateMessage(input);
  review = {
    id: crypto.randomUUID(),
    projectId: 'test',
    projectUpdatedAt: '2026-10-14T00:00:00Z',
    releaseId: 'a'.repeat(64),
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    transaction: packet.transaction,
    sha256: packet.packetSha256,
    input: encodePumpSigningInput(input),
    feeAndRentLimitRaw: '50000000',
  };
});
it('signs the exact reconstructed packet with two independently verified signatures', async () => {
  const signed = await signPumpLaunch(payer, mint, review, () => {});
  expect(verifyPumpSignedPacket(review, signed.transaction)).toBe(
    signed.signature,
  );
  expect(() => verifyPumpSignedPacket(review, review.transaction)).toThrow();
  const altered = { ...review, input: { ...review.input, name: 'Different' } };
  await expect(requirePumpSigningReview(altered)).rejects.toThrow('differs');
});
it('rejects changed metadata, quote, allowance, fingerprint, expired review and wrong keys', async () => {
  for (const change of [
    { sha256: '0'.repeat(64) },
    { input: { ...review.input, uri: 'https://other.test' } },
    { input: { ...review.input, quoteMint: mint.payload.wallets[0].address } },
    { expiresAt: '2000-01-01' },
    { feeAndRentLimitRaw: '1000000001' },
  ])
    await expect(
      signPumpLaunch(payer, mint, { ...review, ...change }, () => {}),
    ).rejects.toThrow();
  await expect(signPumpLaunch(mint, payer, review, () => {})).rejects.toThrow(
    'exact reviewed',
  );
});
it('checks current context again after async packet reconstruction', async () => {
  let checks = 0;
  await expect(
    signPumpLaunch(payer, mint, review, () => {
      if (++checks > 1) throw new Error('context changed');
    }),
  ).rejects.toThrow('context changed');
});
