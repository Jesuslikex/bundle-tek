import { expect, it } from 'vitest';
import {
  marketplacePrivateKey,
  openMarketplaceKey,
  sealMarketplaceKey,
} from './marketplace-key-delivery';

const SECRET = 'x'.repeat(40);
const env = { MARKETPLACE_KEY_SECRET: SECRET };
// 64 bytes of base58 — the shape a wallet exports.
const KEY = '5'.repeat(88);

it('round-trips a key and never stores it in the clear', async () => {
  const sealed = await sealMarketplaceKey(KEY, env);
  expect(sealed).not.toContain(KEY);
  expect(sealed.startsWith('v1.')).toBe(true);
  expect(await openMarketplaceKey(sealed, env)).toBe(KEY);
});

it('binds the ciphertext to the secret', async () => {
  const sealed = await sealMarketplaceKey(KEY, env);
  await expect(
    openMarketplaceKey(sealed, { MARKETPLACE_KEY_SECRET: 'y'.repeat(40) }),
  ).rejects.toThrow();
});

it('refuses a short or missing secret and a malformed key', async () => {
  await expect(
    sealMarketplaceKey(KEY, { MARKETPLACE_KEY_SECRET: 'short' }),
  ).rejects.toThrow(/MARKETPLACE_KEY_SECRET/);
  await expect(sealMarketplaceKey(KEY, {})).rejects.toThrow(
    /MARKETPLACE_KEY_SECRET/,
  );
  expect(() => marketplacePrivateKey('not base58!')).toThrow(/base58/);
  expect(() => marketplacePrivateKey('1111')).toThrow(/32 or 64 bytes/);
});

it('rejects a tampered envelope', async () => {
  const sealed = await sealMarketplaceKey(KEY, env);
  const parts = sealed.split('.');
  parts[4] = Buffer.from('tampered').toString('base64');
  await expect(openMarketplaceKey(parts.join('.'), env)).rejects.toThrow();
});
