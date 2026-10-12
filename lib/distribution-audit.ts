import { assertSolanaAddress } from './wallet-verification';
import { canonicalDistributionAmount } from './distribution-plan';
export type DistributionClaim = {
  wallet: string;
  mint: string;
  recipients: Array<{ address: string; amount: string }>;
};
export type WalletAuditEvent = {
  id: string;
  walletAddress: string;
  network: string;
  eventType: string;
  transactionSignature: string | null;
  details: string;
  createdAt: string;
};

export function validateDistributionClaim(value: unknown): DistributionClaim {
  if (!value || typeof value !== 'object')
    throw new Error('Invalid distribution claim.');
  const body = value as Record<string, unknown>;
  const wallet = assertSolanaAddress(body.wallet),
    mint = assertSolanaAddress(body.mint);
  if (
    !Array.isArray(body.recipients) ||
    body.recipients.length < 1 ||
    body.recipients.length > 1000
  )
    throw new Error('Invalid distribution recipients.');
  const recipients = body.recipients
    .map((item: unknown) => {
      if (!item || typeof item !== 'object')
        throw new Error('Invalid distribution recipient.');
      const row = item as Record<string, unknown>;
      const recipient = assertSolanaAddress(row.address);
      if (typeof row.amount !== 'string')
        throw new Error('Use exact decimal strings.');
      const amount = canonicalDistributionAmount(row.amount);
      if (amount === '0' || recipient === wallet)
        throw new Error('Invalid transfer recipient or amount.');
      return { address: recipient, amount };
    })
    .sort((a, b) => a.address.localeCompare(b.address));
  if (new Set(recipients.map((row) => row.address)).size !== recipients.length)
    throw new Error('Merge duplicate recipients before review.');
  return { wallet, mint, recipients };
}

export async function distributionAuditKey(claim: DistributionClaim) {
  const canonical = validateDistributionClaim(claim);
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(
      JSON.stringify({ network: 'devnet', ...canonical }),
    ),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}
