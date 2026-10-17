import { afterEach, describe, expect, it, vi } from 'vitest';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { privateKeyToAddress } from 'viem/accounts';
import {
  createVault,
  encryptVault,
  unlockVault,
  generateVaultWallets,
  importVaultWallets,
  publicVaultWallets,
  exportVaultPrivateKeys,
  parseVaultEnvelope,
  saveBrowserVault,
  VAULT_STORAGE_KEY,
} from './browser-wallet-vault';

const passphrase = 'test-only vault passphrase';
afterEach(() => vi.unstubAllGlobals());

describe('encrypted browser custody', () => {
  it('accepts an eight-character password for encrypted creation and unlock, refusing seven', async () => {
    await expect(createVault('fixture')).rejects.toThrow(
      'at least 8 characters',
    );
    const password = 'fixture8';
    const session = generateVaultWallets(
      await createVault(password),
      'solana',
      1,
    );
    const encrypted = await encryptVault(session);
    await expect(unlockVault(encrypted, 'fixture')).rejects.toThrow();
    const restored = await unlockVault(encrypted, password);
    expect(publicVaultWallets(restored)).toEqual(publicVaultWallets(session));
    expect(encrypted).not.toContain(password);
    expect(parseVaultEnvelope(encrypted).iterations).toBe(600_000);
  });
  it('persists only ciphertext and authenticates a fresh unlock', async () => {
    const session = generateVaultWallets(
      await createVault(passphrase),
      'solana',
      2,
    );
    const stored = await encryptVault(session);
    for (const wallet of session.payload.wallets) {
      expect(stored).not.toContain(wallet.seed);
      expect(stored).not.toContain(wallet.address);
    }
    expect(stored).not.toContain(passphrase);
    const restored = await unlockVault(stored, passphrase);
    expect(publicVaultWallets(restored)).toEqual(publicVaultWallets(session));
    expect(restored.key.extractable).toBe(false);
    await expect(
      crypto.subtle.exportKey('raw', restored.key),
    ).rejects.toThrow();
    await expect(
      unlockVault(stored, 'a different wrong passphrase'),
    ).rejects.toThrow('Could not unlock vault');
  });
  it('uses a fresh salt and IV and rejects ciphertext, IV and salt tampering', async () => {
    const first = await createVault(passphrase);
    expect((await createVault(passphrase)).salt).not.toBe(first.salt);
    const stored = await encryptVault(first);
    expect(parseVaultEnvelope(await encryptVault(first)).iv).not.toBe(
      parseVaultEnvelope(stored).iv,
    );
    for (const field of ['ciphertext', 'iv', 'salt'] as const) {
      const tampered = parseVaultEnvelope(stored);
      tampered[field] =
        (tampered[field][0] === '0' ? '1' : '0') + tampered[field].slice(1);
      await expect(
        unlockVault(JSON.stringify(tampered), passphrase),
      ).rejects.toThrow();
    }
  });
  it('exports independently verifiable Solana keypairs and EVM keys', async () => {
    const mixed = generateVaultWallets(
      generateVaultWallets(await createVault(passphrase), 'solana', 1),
      'evm',
      1,
    );
    const exported = JSON.parse(
      exportVaultPrivateKeys(
        await unlockVault(await encryptVault(mixed), passphrase),
      ),
    );
    const sol = exported.wallets[0];
    expect(sol.secretKey).toHaveLength(64);
    expect(
      bs58.encode(
        nacl.sign.keyPair.fromSecretKey(Uint8Array.from(sol.secretKey))
          .publicKey,
      ),
    ).toBe(sol.address);
    expect(privateKeyToAddress(exported.wallets[1].privateKey)).toBe(
      exported.wallets[1].address,
    );
    expect(
      publicVaultWallets(mixed).every(
        (wallet) => !('seed' in wallet) && !('privateKey' in wallet),
      ),
    ).toBe(true);
  });
  it('rejects a key/address mismatch before persistence or export', async () => {
    const session = generateVaultWallets(
      await createVault(passphrase),
      'evm',
      1,
    );
    session.payload.wallets[0].address =
      '0x0000000000000000000000000000000000000000';
    await expect(encryptVault(session)).rejects.toThrow('does not match');
    expect(() => exportVaultPrivateKeys(session)).toThrow('does not match');
  });
  it('bounds wallet generation and rejects weak, oversized and unsupported inputs', async () => {
    await expect(createVault('short')).rejects.toThrow('wallet password');
    await expect(createVault('x'.repeat(1025))).rejects.toThrow(
      'wallet password',
    );
    const session = await createVault(passphrase);
    for (const count of [0, 101, 1.5, NaN])
      expect(() => generateVaultWallets(session, 'evm', count)).toThrow();
    const format = parseVaultEnvelope(await encryptVault(session));
    expect(() =>
      parseVaultEnvelope(JSON.stringify({ ...format, iterations: 1 })),
    ).toThrow('Unsupported');
    expect(() =>
      parseVaultEnvelope(JSON.stringify({ ...format, iv: '00' })),
    ).toThrow('Invalid');
    expect(() => parseVaultEnvelope('x'.repeat(300001))).toThrow('too large');
  });
});

describe('local private-key import', () => {
  function solanaKeypair() {
    const pair = nacl.sign.keyPair();
    return {
      key: bs58.encode(pair.secretKey),
      json: JSON.stringify(Array.from(pair.secretKey)),
      address: bs58.encode(pair.publicKey),
    };
  }
  it('accepts Solana base58 and CLI JSON keypairs and independently derives their public identities', async () => {
    const first = solanaKeypair();
    const second = solanaKeypair();
    const initial = await createVault(passphrase);
    const result = importVaultWallets(initial, 'solana', first.key);
    const withJson = importVaultWallets(result.session, 'solana', second.json);
    expect(initial.payload.wallets).toHaveLength(0);
    expect(
      publicVaultWallets(withJson.session).map((wallet) => wallet.address),
    ).toEqual([first.address, second.address]);
    const encrypted = await encryptVault(withJson.session);
    expect(encrypted).not.toContain(first.key);
    expect(
      publicVaultWallets(await unlockVault(encrypted, passphrase)),
    ).toEqual(publicVaultWallets(withJson.session));
  });
  it('accepts prefixed/unprefixed EVM hex and skips duplicates within the batch and vault', async () => {
    const initial = generateVaultWallets(
      await createVault(passphrase),
      'evm',
      1,
    );
    const key = initial.payload.wallets[0].seed;
    const second = generateVaultWallets(await createVault(passphrase), 'evm', 1)
      .payload.wallets[0].seed;
    const result = importVaultWallets(
      initial,
      'evm',
      `${key}\n0x${second.toUpperCase()}\n0x${second}`,
    );
    expect(result.added).toBe(1);
    expect(result.skipped).toBe(2);
    expect(result.importedIds).toHaveLength(1);
    expect(result.session.payload.wallets[1].address).toBe(
      privateKeyToAddress(`0x${second}`),
    );
    const duplicate = importVaultWallets(result.session, 'evm', `0x${second}`);
    expect(duplicate.added).toBe(0);
    expect(duplicate.skipped).toBe(1);
  });
  it('restores a mixed-family private-key export with address verification and newly assigned record IDs', async () => {
    const original = generateVaultWallets(
      generateVaultWallets(await createVault(passphrase), 'solana', 1),
      'evm',
      1,
    );
    const empty = await createVault('a different import vault passphrase');
    const imported = importVaultWallets(
      empty,
      'evm',
      exportVaultPrivateKeys(original),
    );
    expect(imported.added).toBe(2);
    expect(
      imported.session.payload.wallets.map((wallet) => [
        wallet.family,
        wallet.address,
        wallet.seed,
      ]),
    ).toEqual(
      original.payload.wallets.map((wallet) => [
        wallet.family,
        wallet.address,
        wallet.seed,
      ]),
    );
    expect(imported.session.payload.wallets[0].id).not.toBe(
      original.payload.wallets[0].id,
    );
    const tampered = JSON.parse(exportVaultPrivateKeys(original));
    tampered.wallets[0].address = solanaKeypair().address;
    expect(() =>
      importVaultWallets(empty, 'solana', JSON.stringify(tampered)),
    ).toThrow('address does not match');
    expect(empty.payload.wallets).toHaveLength(0);
  });
  it('rejects a malformed member without admitting earlier valid keys or exposing secrets in errors', async () => {
    const initial = await createVault(passphrase);
    const sol = solanaKeypair();
    const secretInvalid = 'not-a-key-' + 'X'.repeat(40);
    let message = '';
    try {
      importVaultWallets(initial, 'solana', `${sol.key}\n${secretInvalid}`);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('Key 2:');
    expect(message).not.toContain(sol.key);
    expect(message).not.toContain(secretInvalid);
    expect(initial.payload.wallets).toHaveLength(0);
    for (const key of ['0x' + '0'.repeat(64), '0x' + 'f'.repeat(64)]) {
      expect(() => importVaultWallets(initial, 'evm', key)).toThrow(
        'valid 32-byte',
      );
    }
  });
  it('validates all 64 Solana keypair bytes rather than trusting the supplied public half', async () => {
    const initial = await createVault(passphrase);
    const pair = nacl.sign.keyPair();
    pair.secretKey[63] ^= 1;
    expect(() =>
      importVaultWallets(initial, 'solana', bs58.encode(pair.secretKey)),
    ).toThrow('valid 64-byte');
    expect(() =>
      importVaultWallets(
        initial,
        'solana',
        JSON.stringify(Array.from(pair.secretKey)),
      ),
    ).toThrow('valid 64-byte');
    expect(() =>
      importVaultWallets(
        initial,
        'solana',
        bs58.encode(pair.secretKey.subarray(0, 32)),
      ),
    ).toThrow();
    const invalidBytes = Array.from(nacl.sign.keyPair().secretKey);
    invalidBytes[0] = 256;
    expect(() =>
      importVaultWallets(initial, 'solana', JSON.stringify(invalidBytes)),
    ).toThrow();
  });
  it('bounds batches/files and rejects unsupported export families', async () => {
    const initial = await createVault(passphrase);
    const key = solanaKeypair().key;
    for (const value of [
      '',
      '{',
      'x'.repeat(100001),
      Array(101).fill(key).join('\n'),
    ])
      expect(() => importVaultWallets(initial, 'solana', value)).toThrow();
    expect(() =>
      importVaultWallets(
        initial,
        'solana',
        JSON.stringify({
          format: 'pulseforge-private-wallet-export-v1',
          wallets: [{ family: 'unknown', address: key, privateKey: key }],
        }),
      ),
    ).toThrow('Invalid exported wallet');
  });
  it('accepts duplicate imports at capacity but refuses any additional key', async () => {
    let full = await createVault(passphrase);
    for (let i = 0; i < 5; i++) full = generateVaultWallets(full, 'evm', 100);
    expect(
      importVaultWallets(full, 'evm', full.payload.wallets[0].seed).skipped,
    ).toBe(1);
    const fresh = generateVaultWallets(await createVault(passphrase), 'evm', 1)
      .payload.wallets[0].seed;
    expect(() => importVaultWallets(full, 'evm', fresh)).toThrow(
      'limit of 500',
    );
    expect(full.payload.wallets).toHaveLength(500);
    const encrypted = await encryptVault(full);
    expect(encrypted.length).toBeLessThanOrEqual(300_000);
    const restored = await unlockVault(encrypted, passphrase);
    expect(publicVaultWallets(restored)).toEqual(publicVaultWallets(full));
  });
});

describe('browser vault persistence', () => {
  function storage() {
    const values = new Map<string, string>();
    const setItem = vi.fn((key: string, value: string) => {
      values.set(key, value);
    });
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem,
    });
    vi.stubGlobal('navigator', {
      locks: {
        request: async (_name: string, callback: () => void) => callback(),
      },
    });
    return { values, setItem };
  }
  it('creates without overwriting, rejects stale writes, and commits a current write', async () => {
    const { values } = storage();
    const session = await createVault(passphrase);
    const first = await encryptVault(session);
    const next = await encryptVault(generateVaultWallets(session, 'solana', 1));
    await saveBrowserVault(null, first);
    await expect(saveBrowserVault(null, next)).rejects.toThrow(
      'changed in another tab',
    );
    expect(values.get(VAULT_STORAGE_KEY)).toBe(first);
    await saveBrowserVault(first, next);
    expect(values.get(VAULT_STORAGE_KEY)).toBe(next);
  });
  it('checks cancellation inside the lock and leaves prior ciphertext intact', async () => {
    const { values, setItem } = storage();
    const encrypted = await encryptVault(await createVault(passphrase));
    await expect(
      saveBrowserVault(null, encrypted, () => false),
    ).rejects.toThrow('cancelled');
    expect(setItem).not.toHaveBeenCalled();
    expect(values.size).toBe(0);
  });
  it('fails closed without browser locks or on quota failure', async () => {
    const { setItem, values } = storage();
    const encrypted = await encryptVault(await createVault(passphrase));
    setItem.mockImplementation(() => {
      throw new Error('Quota exceeded');
    });
    await expect(saveBrowserVault(null, encrypted)).rejects.toThrow('Quota');
    expect(values.size).toBe(0);
    vi.stubGlobal('navigator', {});
    await expect(saveBrowserVault(null, encrypted)).rejects.toThrow(
      'safe vault writes',
    );
  });
});
