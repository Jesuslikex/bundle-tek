import { createCipheriv, createDecipheriv, randomBytes, scrypt } from 'node:crypto';
import bs58 from 'bs58';

// Delivered keys are sealed at rest under a deployment secret. The secret lives
// in the same trust boundary as the database credentials, so this protects a
// database dump, not a compromised host — say so in the UI.
export const MARKETPLACE_KEY_SECRET_ENV = 'MARKETPLACE_KEY_SECRET';
const VERSION = 'v1';

function secret(env: Record<string, string | undefined> = process.env) {
  const value = env[MARKETPLACE_KEY_SECRET_ENV];
  if (!value || value.length < 32)
    throw Error(
      'MARKETPLACE_KEY_SECRET is not configured (32+ characters), so delivered keys cannot be sealed.',
    );
  return value;
}

const derive = (value: string, salt: Buffer) =>
  new Promise<Buffer>((resolve, reject) =>
    scrypt(value, salt, 32, (error, key) =>
      error ? reject(error) : resolve(key),
    ),
  );

/** A 32-byte seed or 64-byte secret key, base58, is what a wallet exports. */
export function marketplacePrivateKey(value: string) {
  const text = value.trim();
  let bytes: Uint8Array;
  try {
    bytes = bs58.decode(text);
  } catch {
    throw Error('The private key is not valid base58.');
  }
  if (bytes.length !== 32 && bytes.length !== 64)
    throw Error('The private key must decode to 32 or 64 bytes.');
  return text;
}

export async function sealMarketplaceKey(
  privateKey: string,
  env: Record<string, string | undefined> = process.env,
) {
  const text = marketplacePrivateKey(privateKey);
  const salt = randomBytes(16),
    iv = randomBytes(12);
  const key = await derive(secret(env), salt);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const sealed = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return [
    VERSION,
    Buffer.from(salt).toString('base64'),
    Buffer.from(iv).toString('base64'),
    Buffer.from(cipher.getAuthTag()).toString('base64'),
    Buffer.from(sealed).toString('base64'),
  ].join('.');
}

export async function openMarketplaceKey(
  sealed: string,
  env: Record<string, string | undefined> = process.env,
) {
  const [version, salt, iv, tag, body] = sealed.split('.');
  if (version !== VERSION || !salt || !iv || !tag || !body)
    throw Error('The sealed key is malformed.');
  const key = await derive(secret(env), Buffer.from(salt, 'base64'));
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(body, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}
