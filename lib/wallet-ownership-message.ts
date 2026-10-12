import { EVM_NETWORKS } from './evm-network';
import { walletAddress, walletChain } from './wallet-workspace';
import type { LaunchChain } from './launch-plan';

export type OwnershipChallenge = {
  id: string;
  chain: LaunchChain;
  chainId: number | null;
  address: string;
  message: string;
  issuedAt: string;
  expiresAt: string;
};
export function ownershipMessage(
  origin: string,
  chain: LaunchChain,
  address: string,
  id: string,
  issuedAt: string,
  expiresAt: string,
) {
  return [
    'PulseForge wallet ownership verification',
    `Origin: ${origin}`,
    `Network: ${chain}`,
    chain === 'Solana'
      ? 'Signature: Ed25519'
      : `Chain ID: ${EVM_NETWORKS[chain].id}`,
    `Address: ${address}`,
    `Challenge: ${id}`,
    `Issued: ${issuedAt}`,
    `Expires: ${expiresAt}`,
    'Purpose: record ownership of this saved public address. This message does not authorize a transaction.',
  ].join('\n');
}
export function validateOwnershipChallenge(
  value: unknown,
  origin: string,
  chain: LaunchChain,
  address: string,
  now = Date.now(),
): OwnershipChallenge {
  const fail = () => {
    throw new Error(
      'Unexpected or expired ownership message. Request a new message.',
    );
  };
  if (!value || typeof value !== 'object') return fail();
  const challenge = value as OwnershipChallenge;
  const parsedOrigin = new URL(origin);
  if (
    parsedOrigin.origin !== origin ||
    !['https:', 'http:'].includes(parsedOrigin.protocol)
  )
    return fail();
  if (
    walletChain(chain) !== chain ||
    walletAddress(address, chain) !== address ||
    challenge.chain !== chain ||
    challenge.address !== address ||
    challenge.chainId !==
      (chain === 'Solana' ? null : EVM_NETWORKS[chain].id) ||
    typeof challenge.id !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      challenge.id,
    ) ||
    typeof challenge.issuedAt !== 'string' ||
    typeof challenge.expiresAt !== 'string'
  )
    return fail();
  const issued = Date.parse(challenge.issuedAt),
    expires = Date.parse(challenge.expiresAt);
  if (
    !Number.isFinite(issued) ||
    !Number.isFinite(expires) ||
    new Date(issued).toISOString() !== challenge.issuedAt ||
    new Date(expires).toISOString() !== challenge.expiresAt ||
    expires - issued !== 300_000 ||
    issued > now + 30_000 ||
    expires <= now
  )
    return fail();
  if (
    challenge.message !==
    ownershipMessage(
      origin,
      chain,
      address,
      challenge.id,
      challenge.issuedAt,
      challenge.expiresAt,
    )
  )
    return fail();
  return challenge;
}
