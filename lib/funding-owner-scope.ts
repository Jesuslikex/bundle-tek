import { createHash } from 'node:crypto';

/** Stable opaque local-recovery namespace, never an authentication credential. */
export function fundingOwnerScope(ownerId: string): string {
  if (typeof ownerId !== 'string' || ownerId.length === 0)
    throw Error('A signed-in funding owner is required.');
  return createHash('sha256')
    .update(JSON.stringify(['bundle-funding-owner-scope-v1', ownerId]), 'utf8')
    .digest('hex');
}
export const FUNDING_OWNER_SCOPE_HEADER = 'x-bundle-funding-owner-scope';
