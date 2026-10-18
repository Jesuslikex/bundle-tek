import { expect, it } from 'vitest';
import {
  getTransactionDecoder,
  getCompiledTransactionMessageDecoder,
} from '@solana/kit';
import { volumeConstructionInput, key } from '../test/volume-bundle-fixture';
import {
  constructVolumeBundle,
  requireVolumeBundleConstruction,
  VOLUME_SYSTEM,
} from './volume-bundle-construction';
it('constructs a single canonical unsigned v0 buy/sell/tip packet and binds the full context', async () => {
  const input = volumeConstructionInput(),
    original = structuredClone(input),
    p = await constructVolumeBundle(input);
  expect(input).toEqual(original);
  expect(await constructVolumeBundle(input)).toEqual(p);
  const tx = getTransactionDecoder().decode(
    Uint8Array.from(atob(p.transaction), (c) => c.charCodeAt(0)),
  );
  const message = getCompiledTransactionMessageDecoder().decode(
    tx.messageBytes,
  );
  expect(Object.values(tx.signatures)).toEqual([null]);
  expect(message.version).toBe(0);
  if (message.version !== 0) throw new Error('Expected v0 packet.');
  expect(message.instructions).toHaveLength(3);
  expect(
    String(message.staticAccounts[message.instructions[2].programAddressIndex]),
  ).toBe(VOLUME_SYSTEM);
  expect(p.executionAllowed).toBe(false);
  expect(p.signingAllowed).toBe(false);
  expect(p.instructionsVerified).toBe(false);
  expect(await requireVolumeBundleConstruction(p)).toEqual(p);
  const changed = structuredClone(p);
  changed.input.projectRevision++;
  await expect(requireVolumeBundleConstruction(changed)).rejects.toThrow();
});
it.each([
  'tip',
  'signer',
  'tip-touch',
  'program',
  'oversized',
  'unsigned-limit',
  'unknown',
  'loss',
  'round',
])('refuses %s without splitting or signing', async (kind) => {
  const input = volumeConstructionInput();
  if (kind === 'tip') input.tipLamports = '100001';
  if (kind === 'signer')
    input.buy[0].accounts.push({ address: key(12), role: 3 });
  if (kind === 'tip-touch')
    input.sell[0].accounts.push({ address: input.tipRecipient, role: 0 });
  if (kind === 'program') input.buy[0].programAddress = VOLUME_SYSTEM;
  if (kind === 'oversized') {
    input.buy = Array.from({ length: 6 }, () => ({
      ...input.buy[0],
      dataBase64: btoa('x'.repeat(700)),
    }));
  }
  if (kind === 'unsigned-limit')
    input.networkFeeCapLamports = '18446744073709551616';
  if (kind === 'unknown') Object.assign(input, { executionAllowed: true });
  if (kind === 'loss') input.maximumLossLamports = '99999999';
  if (kind === 'round') input.round = 250;
  await expect(constructVolumeBundle(input)).rejects.toThrow();
});
it('binds the round, lifetime, ordered route bytes and minimum proceeds', async () => {
  const input = volumeConstructionInput(),
    p = await constructVolumeBundle(input);
  for (const change of [
    { round: 1 },
    { blockhash: key(9) },
    { lastValidBlockHeight: '501' },
    { minimumSellLamports: '49000001' },
  ]) {
    expect(
      (await constructVolumeBundle({ ...input, ...change })).sha256,
    ).not.toBe(p.sha256);
  }
  const altered = structuredClone(input);
  altered.sell[0].dataBase64 = 'Aw==';
  expect((await constructVolumeBundle(altered)).packetSha256).not.toBe(
    p.packetSha256,
  );
});
