import { expect, it } from 'vitest';
import {
  admitReservationHistory,
  type ReservationHistoryPage,
} from './marketplace-reservation-history';
const now = Date.parse('2026-10-20T12:00:00.000Z');
function page(count = 20): ReservationHistoryPage {
  const entries = Array.from({ length: count }, (_, i) => ({
    id: crypto.randomUUID(),
    createdAt: new Date(now - i * 1000).toISOString(),
    expiresAt: new Date(now - i * 1000 + 300000).toISOString(),
    releasedAt: null,
    state: 'held' as const,
    count: 2,
    askingPriceLamports: '75000001',
    contextSha256: 'a'.repeat(64),
  }));
  const last = entries.at(-1)!;
  return {
    format: 'bundle-reservation-history-v1',
    chain: 'Solana',
    seller: 'Bundle',
    observedAt: new Date(now).toISOString(),
    entries,
    nextCursor:
      count === 20 ? { id: last.id, createdAt: last.createdAt } : null,
    reserveAllowed: false,
    releaseAllowed: false,
    purchaseEnabled: false,
    paymentEnabled: false,
    deliveryEnabled: false,
    signingAllowed: false,
  };
}
it('admits bounded sorted summaries without financial authority and binds the next cursor', () => {
  const history = page();
  expect(admitReservationHistory({ history }, null, now)).toEqual(history);
  expect(
    admitReservationHistory({ history: page(0) }, null, now).nextCursor,
  ).toBeNull();
  const cursor = {
    createdAt: new Date(now + 1).toISOString(),
    id: crypto.randomUUID(),
  };
  expect(
    admitReservationHistory({ history }, cursor, now).entries,
  ).toHaveLength(20);
});
it.each([
  'authority',
  'chain',
  'duplicate',
  'order',
  'cursor',
  'short-cursor',
  'state',
  'release',
  'expiry',
  'future',
  'old',
  'boundary',
  'extra',
] as const)('refuses altered %s history', (kind) => {
  const history = page();
  if (kind === 'authority') Object.assign(history, { releaseAllowed: true });
  if (kind === 'chain') Object.assign(history, { chain: 'Ethereum' });
  if (kind === 'duplicate') history.entries[1] = history.entries[0];
  if (kind === 'order') history.entries.reverse();
  if (kind === 'cursor') history.nextCursor!.id = crypto.randomUUID();
  if (kind === 'short-cursor') history.entries.pop();
  if (kind === 'state') history.entries[0].state = 'released';
  if (kind === 'release')
    history.entries[0].releasedAt = new Date(now + 1).toISOString();
  if (kind === 'expiry')
    history.entries[0].expiresAt = new Date(now + 300001).toISOString();
  if (kind === 'future') history.observedAt = new Date(now + 1).toISOString();
  if (kind === 'old') history.observedAt = new Date(now - 60000).toISOString();
  if (kind === 'extra') Object.assign(history, { authorization: 'forbidden' });
  const cursor =
    kind === 'boundary'
      ? { id: history.entries[0].id, createdAt: history.entries[0].createdAt }
      : null;
  expect(() => admitReservationHistory({ history }, cursor, now)).toThrow();
});
