import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { privateKeyToAddress } from 'viem/accounts';

// Client-only custody. This module has no RPC, fetch or signing entry points.
export const VAULT_STORAGE_KEY = 'pulseforge.wallet-vault.v1';
export const VAULT_ITERATIONS = 600_000;
const MAX_WALLETS = 500;
const MAX_ENVELOPE_BYTES = 300_000;
const aad = new TextEncoder().encode('PulseForge/browser-wallet-vault/v1');
type Family = 'solana' | 'evm';
type SecretWallet = {
  id: string;
  family: Family;
  address: string;
  seed: string;
  createdAt: string;
};
export type VaultWallet = Omit<SecretWallet, 'seed'>;
type Payload = { version: 1; wallets: SecretWallet[] };
export type VaultEnvelope = {
  version: 1;
  algorithm: 'AES-256-GCM';
  kdf: 'PBKDF2-SHA256';
  iterations: typeof VAULT_ITERATIONS;
  salt: string;
  iv: string;
  ciphertext: string;
};
export type VaultSession = { key: CryptoKey; salt: string; payload: Payload };
function hex(bytes: Uint8Array) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(
    '',
  );
}
function bytes(value: unknown, length?: number) {
  if (
    typeof value !== 'string' ||
    !/^(?:[0-9a-f]{2})+$/.test(value) ||
    (length !== undefined && value.length !== length * 2)
  )
    throw new Error('Invalid encrypted vault format.');
  return Uint8Array.from(value.match(/../g)!, (part) => parseInt(part, 16));
}
export function parseVaultEnvelope(text: string): VaultEnvelope {
  if (text.length > MAX_ENVELOPE_BYTES)
    throw new Error('Vault backup is too large.');
  const value = JSON.parse(text) as VaultEnvelope;
  if (
    !value ||
    value.version !== 1 ||
    value.algorithm !== 'AES-256-GCM' ||
    value.kdf !== 'PBKDF2-SHA256' ||
    value.iterations !== VAULT_ITERATIONS
  )
    throw new Error('Unsupported encrypted vault format.');
  bytes(value.salt, 16);
  bytes(value.iv, 12);
  if (bytes(value.ciphertext).length < 16)
    throw new Error('Invalid encrypted vault format.');
  return value;
}
function addressFor(family: Family, seed: Uint8Array) {
  if (family === 'evm') return privateKeyToAddress(`0x${hex(seed)}`);
  const pair = nacl.sign.keyPair.fromSeed(seed);
  try {
    return bs58.encode(pair.publicKey);
  } finally {
    pair.secretKey.fill(0);
  }
}
function validatePayload(value: Payload): Payload {
  if (
    !value ||
    value.version !== 1 ||
    !Array.isArray(value.wallets) ||
    value.wallets.length > MAX_WALLETS
  )
    throw new Error('Invalid vault contents.');
  const identities = new Set<string>();
  for (const wallet of value.wallets) {
    if (
      !wallet ||
      !['solana', 'evm'].includes(wallet.family) ||
      typeof wallet.id !== 'string' ||
      !/^[0-9a-f-]{36}$/.test(wallet.id) ||
      typeof wallet.createdAt !== 'string' ||
      !Number.isFinite(Date.parse(wallet.createdAt))
    )
      throw new Error('Invalid vault wallet.');
    const seed = bytes(wallet.seed, 32);
    try {
      if (addressFor(wallet.family, seed) !== wallet.address)
        throw new Error('Vault address does not match its key.');
    } finally {
      seed.fill(0);
    }
    if (identities.has(wallet.id) || identities.has(wallet.address))
      throw new Error('Duplicate vault wallet.');
    identities.add(wallet.id);
    identities.add(wallet.address);
  }
  return value;
}
async function derive(passphrase: string, salt: Uint8Array) {
  const encoded = new TextEncoder().encode(passphrase);
  if (Array.from(passphrase).length < 12 || encoded.length > 1024) {
    encoded.fill(0);
    throw new Error(
      'Use a vault passphrase of at least 12 characters, up to 1024 UTF-8 bytes.',
    );
  }
  try {
    const material = await crypto.subtle.importKey(
      'raw',
      encoded,
      'PBKDF2',
      false,
      ['deriveKey'],
    );
    return await crypto.subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt: salt as Uint8Array<ArrayBuffer>,
        iterations: VAULT_ITERATIONS,
        hash: 'SHA-256',
      },
      material,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    );
  } finally {
    encoded.fill(0);
  }
}
export async function createVault(passphrase: string): Promise<VaultSession> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return {
    key: await derive(passphrase, salt),
    salt: hex(salt),
    payload: { version: 1, wallets: [] },
  };
}
export async function encryptVault(session: VaultSession): Promise<string> {
  validatePayload(session.payload);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plain = new TextEncoder().encode(JSON.stringify(session.payload));
  try {
    const encrypted = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 },
      session.key,
      plain,
    );
    return JSON.stringify({
      version: 1,
      algorithm: 'AES-256-GCM',
      kdf: 'PBKDF2-SHA256',
      iterations: VAULT_ITERATIONS,
      salt: session.salt,
      iv: hex(iv),
      ciphertext: hex(new Uint8Array(encrypted)),
    } satisfies VaultEnvelope);
  } finally {
    plain.fill(0);
  }
}
export async function unlockVault(
  text: string,
  passphrase: string,
): Promise<VaultSession> {
  const envelope = parseVaultEnvelope(text);
  const key = await derive(passphrase, bytes(envelope.salt));
  let plain: ArrayBuffer;
  try {
    plain = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: bytes(envelope.iv) as Uint8Array<ArrayBuffer>,
        additionalData: aad,
        tagLength: 128,
      },
      key,
      bytes(envelope.ciphertext) as Uint8Array<ArrayBuffer>,
    );
  } catch {
    throw new Error('Could not unlock vault. Check your passphrase or backup.');
  }
  try {
    return {
      key,
      salt: envelope.salt,
      payload: validatePayload(
        JSON.parse(new TextDecoder().decode(plain)) as Payload,
      ),
    };
  } finally {
    new Uint8Array(plain).fill(0);
  }
}
export function publicVaultWallets(session: VaultSession): VaultWallet[] {
  return session.payload.wallets.map(({ id, family, address, createdAt }) => ({
    id,
    family,
    address,
    createdAt,
  }));
}
export function generateVaultWallets(
  session: VaultSession,
  family: Family,
  count: number,
): VaultSession {
  if (
    !['solana', 'evm'].includes(family) ||
    !Number.isSafeInteger(count) ||
    count < 1 ||
    count > 100 ||
    session.payload.wallets.length + count > MAX_WALLETS
  )
    throw new Error('Generate 1 to 100 wallets, up to 500 in this vault.');
  const wallets: SecretWallet[] = [];
  for (let i = 0; i < count; i++) {
    const seed = crypto.getRandomValues(new Uint8Array(32));
    try {
      wallets.push({
        id: crypto.randomUUID(),
        family,
        address: addressFor(family, seed),
        seed: hex(seed),
        createdAt: new Date().toISOString(),
      });
    } finally {
      seed.fill(0);
    }
  }
  return {
    ...session,
    payload: validatePayload({
      version: 1,
      wallets: [...session.payload.wallets, ...wallets],
    }),
  };
}

function importedWallet(family: Family, value: unknown): SecretWallet {
  if (!['solana', 'evm'].includes(family))
    throw new Error('Unsupported wallet family.');
  let seed: Uint8Array | undefined;
  let pairBytes: Uint8Array | undefined;
  try {
    if (family === 'evm') {
      if (
        typeof value !== 'string' ||
        !/^(?:0x)?[0-9a-f]{64}$/i.test(value.trim())
      )
        throw new Error();
      seed = bytes(value.trim().replace(/^0x/i, '').toLowerCase(), 32);
    } else {
      if (typeof value === 'string') {
        const key = value.trim();
        if (key.length < 64 || key.length > 88) throw new Error();
        pairBytes = bs58.decode(key);
      } else if (
        Array.isArray(value) &&
        value.length === 64 &&
        value.every(
          (byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255,
        )
      )
        pairBytes = Uint8Array.from(value);
      else throw new Error();
      if (pairBytes.length !== 64) throw new Error();
      seed = pairBytes.slice(0, 32);
      const derived = nacl.sign.keyPair.fromSeed(seed);
      try {
        if (!nacl.verify(derived.publicKey, pairBytes.subarray(32)))
          throw new Error();
      } finally {
        derived.secretKey.fill(0);
      }
    }
    return {
      id: crypto.randomUUID(),
      family,
      address: addressFor(family, seed),
      seed: hex(seed),
      createdAt: new Date().toISOString(),
    };
  } catch {
    // Library errors may contain supplied key material. Never surface them.
    throw new Error(
      family === 'solana'
        ? 'Use a valid 64-byte Solana keypair in base58 or JSON byte-array format.'
        : 'Use a valid 32-byte EVM private key in hexadecimal format.',
    );
  } finally {
    seed?.fill(0);
    pairBytes?.fill(0);
  }
}

export function importVaultWallets(
  session: VaultSession,
  family: Family,
  text: string,
): {
  session: VaultSession;
  added: number;
  skipped: number;
  importedIds: string[];
} {
  validatePayload(session.payload);
  if (typeof text !== 'string' || !text.trim() || text.length > 100_000)
    throw new Error(
      'Import 1 to 100 keys, with a maximum input size of 100 KB.',
    );
  const trimmed = text.trim();
  let entries: unknown[];
  let exported = false;
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new Error('Invalid JSON key file.');
    }
    if (Array.isArray(parsed))
      entries = parsed.every((value) => typeof value === 'number')
        ? [parsed]
        : parsed;
    else if (
      parsed &&
      typeof parsed === 'object' &&
      'format' in parsed &&
      parsed.format === 'pulseforge-private-wallet-export-v1' &&
      'wallets' in parsed &&
      Array.isArray(parsed.wallets)
    ) {
      entries = parsed.wallets;
      exported = true;
    } else
      throw new Error(
        'Use a key list, Solana JSON keypair, or PulseForge private-key export.',
      );
  } else
    entries = trimmed
      .split(/\r?\n/)
      .map((value) => value.trim())
      .filter(Boolean);
  if (!entries.length || entries.length > 100)
    throw new Error('Import between 1 and 100 keys per batch.');
  const parsed = entries.map((entry, index) => {
    try {
      if (!exported) return importedWallet(family, entry);
      if (
        !entry ||
        typeof entry !== 'object' ||
        !('family' in entry) ||
        !['solana', 'evm'].includes(String(entry.family)) ||
        !('address' in entry) ||
        typeof entry.address !== 'string'
      )
        throw new Error('Invalid exported wallet.');
      const entryFamily = entry.family as Family;
      const value =
        entryFamily === 'solana'
          ? 'secretKey' in entry
            ? entry.secretKey
            : undefined
          : 'privateKey' in entry
            ? entry.privateKey
            : undefined;
      const wallet = importedWallet(entryFamily, value);
      if (wallet.address !== entry.address)
        throw new Error('Exported address does not match its private key.');
      return wallet;
    } catch (error) {
      throw new Error(
        `Key ${index + 1}: ${error instanceof Error ? error.message : 'Invalid private key.'}`,
      );
    }
  });
  const existing = new Set(
    session.payload.wallets.map(
      (wallet) => `${wallet.family}:${wallet.address}`,
    ),
  );
  const added: SecretWallet[] = [];
  for (const wallet of parsed) {
    const identity = `${wallet.family}:${wallet.address}`;
    if (existing.has(identity)) continue;
    existing.add(identity);
    added.push(wallet);
  }
  if (session.payload.wallets.length + added.length > MAX_WALLETS)
    throw new Error('This import would exceed the vault limit of 500 wallets.');
  return {
    session: {
      ...session,
      payload: { version: 1, wallets: [...session.payload.wallets, ...added] },
    },
    added: added.length,
    skipped: parsed.length - added.length,
    importedIds: added.map((wallet) => wallet.id),
  };
}
// Call only after a fresh passphrase unlock and explicit user export action.
export function exportVaultPrivateKeys(session: VaultSession): string {
  validatePayload(session.payload);
  return JSON.stringify(
    {
      format: 'pulseforge-private-wallet-export-v1',
      wallets: session.payload.wallets.map((wallet) => {
        const seed = bytes(wallet.seed, 32);
        try {
          if (wallet.family === 'evm')
            return {
              ...publicVaultWallets({
                ...session,
                payload: { version: 1, wallets: [wallet] },
              })[0],
              privateKey: `0x${wallet.seed}`,
            };
          const pair = nacl.sign.keyPair.fromSeed(seed);
          try {
            return {
              id: wallet.id,
              family: wallet.family,
              address: wallet.address,
              createdAt: wallet.createdAt,
              secretKey: Array.from(pair.secretKey),
            };
          } finally {
            pair.secretKey.fill(0);
          }
        } finally {
          seed.fill(0);
        }
      }),
    },
    null,
    2,
  );
}

export async function saveBrowserVault(
  expected: string | null,
  next: string,
  isCurrent: () => boolean = () => true,
): Promise<void> {
  parseVaultEnvelope(next);
  if (!navigator.locks)
    throw new Error('This browser does not support safe vault writes.');
  await navigator.locks.request(VAULT_STORAGE_KEY, () => {
    if (!isCurrent())
      throw new Error('Vault operation cancelled. Unlock again.');
    if (localStorage.getItem(VAULT_STORAGE_KEY) !== expected)
      throw new Error(
        'The vault changed in another tab. Lock and unlock it again.',
      );
    // A failed quota/write leaves the previous encrypted value intact.
    localStorage.setItem(VAULT_STORAGE_KEY, next);
  });
}
