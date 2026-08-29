import bs58 from 'bs58';
import nacl from 'tweetnacl';

export const WALLET_CHALLENGE_TTL_MS = 5 * 60 * 1_000;
export const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
export const SOLANA_SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{80,90}$/;

export function assertSolanaAddress(value: unknown): string {
  if (typeof value !== 'string' || !SOLANA_ADDRESS.test(value)) throw new Error('Invalid Solana wallet address');
  const decoded = bs58.decode(value);
  if (decoded.length !== 32) throw new Error('Invalid Solana wallet address');
  return value;
}

export function createWalletChallenge(address: string, id: string, issuedAt: string) {
  return [
    'PulseForge wallet ownership',
    'Network: Solana devnet',
    `Address: ${assertSolanaAddress(address)}`,
    `Challenge: ${id}`,
    `Issued: ${issuedAt}`,
    'Purpose: Verify this public wallet for PulseForge. This does not authorize a transaction.',
  ].join('\n');
}

export function verifyWalletChallenge(message: string, signature: unknown, address: string) {
  if (typeof signature !== 'string' || !SOLANA_SIGNATURE.test(signature)) return false;
  try {
    return nacl.sign.detached.verify(new TextEncoder().encode(message), bs58.decode(signature), bs58.decode(assertSolanaAddress(address)));
  } catch {
    return false;
  }
}
