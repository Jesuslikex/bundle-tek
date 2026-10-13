import { expect, it, vi } from 'vitest';
import { jitoBundleFixture } from '../test/jito-bundle-fixture';
import {
  createJitoPacketRecovery,
  readJitoPacketRecovery,
} from './jito-packet-recovery';

it('round trips signed swaps and tips for recovery after approval expiry', async () => {
  const f = await jitoBundleFixture();
  for (const [packet, signed] of [
    [0, f.swap.signed],
    [1, f.tip.signed],
  ] as const) {
    const record = await createJitoPacketRecovery(
      f.manifest,
      packet,
      signed.transaction,
    );
    expect(record.signature).toBe(signed.signature);
    const clock = vi
      .spyOn(Date, 'now')
      .mockReturnValue(Date.parse(f.manifest.expiresAt) + 1);
    try {
      const recovered = await readJitoPacketRecovery(
        JSON.stringify(record),
        f.manifest,
        packet,
      );
      expect(recovered).toEqual(record);
    } finally {
      clock.mockRestore();
    }
    expect(JSON.stringify(record)).not.toContain('seed');
    expect(JSON.stringify(record)).not.toContain('password');
  }
});

it.each([
  'projectId',
  'sessionId',
  'bundleId',
  'sha256',
  'packet',
  'signature',
  'format',
] as const)('rejects another recovery %s', async (field) => {
  const f = await jitoBundleFixture();
  const record = await createJitoPacketRecovery(
    f.manifest,
    0,
    f.swap.signed.transaction,
  );
  const changed = { ...record, [field]: field === 'packet' ? 1 : 'different' };
  await expect(
    readJitoPacketRecovery(JSON.stringify(changed), f.manifest, 0),
  ).rejects.toThrow();
});
it('rejects unsigned, altered and oversized packets and extra fields', async () => {
  const f = await jitoBundleFixture();
  await expect(
    createJitoPacketRecovery(f.manifest, 0, f.manifest.swaps[0].transaction),
  ).rejects.toThrow();
  const record = await createJitoPacketRecovery(
    f.manifest,
    0,
    f.swap.signed.transaction,
  );
  const changed = Uint8Array.from(atob(record.transaction), (c) =>
    c.charCodeAt(0),
  );
  changed[1] ^= 1;
  await expect(
    readJitoPacketRecovery(
      JSON.stringify({
        ...record,
        transaction: btoa(String.fromCharCode(...changed)),
      }),
      f.manifest,
      0,
    ),
  ).rejects.toThrow();
  await expect(
    readJitoPacketRecovery(' '.repeat(4097), f.manifest, 0),
  ).rejects.toThrow('limit');
  await expect(
    readJitoPacketRecovery(
      JSON.stringify({ ...record, extra: true }),
      f.manifest,
      0,
    ),
  ).rejects.toThrow('fields');
  await expect(
    createJitoPacketRecovery(f.manifest, -1, record.transaction),
  ).rejects.toThrow('position');
});
