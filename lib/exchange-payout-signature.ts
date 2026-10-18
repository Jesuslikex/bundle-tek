import bs58 from 'bs58';

/** Canonical public Solana transaction reference; never a private key. */
export function exchangePayoutSignature(value: unknown): string {
  if (typeof value === 'string' && value.length >= 64 && value.length <= 88) {
    try {
      const bytes = bs58.decode(value);
      if (
        bytes.length === 64 &&
        bytes.some((b) => b !== 0) &&
        bs58.encode(bytes) === value
      )
        return value;
    } catch {
      /* Refuse malformed public evidence. */
    }
  }
  throw new Error('A canonical payout signature is required.');
}
