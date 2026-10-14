import { afterEach, expect, it, vi } from 'vitest';
import {
  createPumpMint,
  parsePumpMintBackup,
  unlockPumpMint,
  persistPumpMint,
  clearMintSession,
  pumpMintStorageKey,
} from './pump-mint-vault';
afterEach(() => vi.unstubAllGlobals());
it('roundtrips an encrypted project-bound backup and rejects password or mint replacement', async () => {
  const backup = await createPumpMint('project-a', 'synthetic mint password');
  const restored = await unlockPumpMint(
    parsePumpMintBackup(JSON.stringify(backup), 'project-a'),
    'synthetic mint password',
  );
  expect(JSON.stringify(backup)).not.toContain(
    restored.payload.wallets[0].seed,
  );
  expect(JSON.stringify(backup)).not.toContain('synthetic mint password');
  expect(() =>
    parsePumpMintBackup(JSON.stringify(backup), 'project-b'),
  ).toThrow();
  await expect(
    unlockPumpMint(backup, 'wrong synthetic password'),
  ).rejects.toThrow();
  await expect(
    unlockPumpMint({ ...backup, mint: 'different' }, 'synthetic mint password'),
  ).rejects.toThrow('identity differs');
  clearMintSession(restored);
  expect(restored.payload.wallets[0].seed).toBe('');
});
it('never overwrites an existing mint and refuses stale context', async () => {
  const backup = await createPumpMint('project-a', 'synthetic mint password'),
    values = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  });
  vi.stubGlobal('navigator', {
    locks: { request: async (_key: string, fn: () => void) => fn() },
  });
  await persistPumpMint(backup, () => true);
  await persistPumpMint(backup, () => true);
  await expect(
    persistPumpMint({ ...backup, mint: 'different' }, () => true),
  ).rejects.toThrow('already has');
  await expect(persistPumpMint(backup, () => false)).rejects.toThrow(
    'Project changed',
  );
  expect(values.get(pumpMintStorageKey('project-a'))).toBe(
    JSON.stringify(backup),
  );
});
