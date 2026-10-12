import { assertSolanaAddress } from './wallet-verification';
import { canonicalDistributionAmount, toBaseUnits } from './distribution-plan';
import {
  distributionAuditKey,
  validateDistributionClaim,
  type DistributionClaim,
} from './distribution-audit';
export type WalletOperationDocument =
  | { kind: 'memo'; wallet: string }
  | {
      kind: 'sol';
      wallet: string;
      fundingId: string;
      fundingRevision: number;
      recipient: string;
      amount: string;
      fundingKey: string;
    }
  | {
      kind: 'spl';
      wallet: string;
      distribution: DistributionClaim;
      recipient: string;
      distributionKey: string;
      funding?: { id: string; revision: number; key: string };
    };
export type WalletOperation = {
  id: string;
  walletAddress: string;
  kind: string;
  document: string;
  state:
    | 'preparing'
    | 'awaiting_signature'
    | 'submitted'
    | 'finalized'
    | 'failed'
    | 'cancelled';
  signature: string | null;
  createdAt: string;
  expiresAt: string;
  armedAt: string | null;
  minimumSlot: number | null;
  updatedAt: string;
};
export const UUID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export async function operationDocument(
  value: unknown,
): Promise<WalletOperationDocument> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid operation.');
  const body = value as Record<string, unknown>,
    wallet = assertSolanaAddress(body.wallet);
  if (body.kind === 'memo') return { kind: 'memo', wallet };
  if (body.kind === 'sol') {
    if (
      typeof body.fundingId !== 'string' ||
      !/^[a-zA-Z0-9-]{1,64}$/.test(body.fundingId) ||
      !Number.isSafeInteger(body.fundingRevision) ||
      Number(body.fundingRevision) < 1 ||
      Number(body.fundingRevision) > 1000000000 ||
      typeof body.amount !== 'string'
    )
      throw new Error('Invalid saved funding operation.');
    const recipient = assertSolanaAddress(body.recipient),
      amount = canonicalDistributionAmount(body.amount);
    if (
      wallet === recipient ||
      wallet === '11111111111111111111111111111111' ||
      recipient === '11111111111111111111111111111111' ||
      toBaseUnits(amount, 9) <= 0n
    )
      throw new Error('Invalid native SOL funding recipient or amount.');
    const key = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(
        JSON.stringify({
          network: 'devnet',
          fundingId: body.fundingId,
          wallet,
          recipient,
          amount,
        }),
      ),
    );
    return {
      kind: 'sol',
      wallet,
      fundingId: body.fundingId,
      fundingRevision: Number(body.fundingRevision),
      recipient,
      amount,
      fundingKey: [...new Uint8Array(key)]
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join(''),
    };
  }
  if (body.kind !== 'spl') throw new Error('Unsupported operation.');
  const distribution = validateDistributionClaim(body.distribution),
    recipient = assertSolanaAddress(body.recipient);
  if (
    distribution.wallet !== wallet ||
    !distribution.recipients.some((row) => row.address === recipient)
  )
    throw new Error('Operation does not match its distribution.');
  let funding: { id: string; revision: number; key: string } | undefined;
  if (body.funding !== undefined) {
    const link = body.funding as Record<string, unknown>;
    if (
      !link ||
      typeof link !== 'object' ||
      Array.isArray(link) ||
      typeof link.id !== 'string' ||
      !/^[a-zA-Z0-9-]{1,64}$/.test(link.id) ||
      !Number.isSafeInteger(link.revision) ||
      Number(link.revision) < 1 ||
      Number(link.revision) > 1000000000 ||
      distribution.recipients.length !== 1
    )
      throw new Error('Invalid saved token funding operation.');
    const digest = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(
        JSON.stringify({
          network: 'devnet',
          fundingId: link.id,
          wallet,
          mint: distribution.mint,
          recipient,
          amount: distribution.recipients[0].amount,
        }),
      ),
    );
    funding = {
      id: link.id,
      revision: Number(link.revision),
      key: [...new Uint8Array(digest)]
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join(''),
    };
  }
  return {
    kind: 'spl',
    wallet,
    distribution,
    recipient,
    distributionKey: await distributionAuditKey(distribution),
    ...(funding ? { funding } : {}),
  };
}
export async function operationClaimHash(claim: string) {
  const bytes = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(claim)),
  );
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
