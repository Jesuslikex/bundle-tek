import { expect, it } from 'vitest';
import {
  encodeLaunchRecoveryCursor,
  decodeLaunchRecoveryCursor,
  launchRecoveryPageRequest,
  validateLaunchRecoveryDiscovery,
  validateLaunchRecoveryItem,
  readLaunchRecoveryDiscovery,
  type LaunchRecoveryItem,
} from './launch-recovery-discovery';
const item: LaunchRecoveryItem = {
  source: 'pump',
  reviewKind: 'groups',
  id: 'historic-id',
  projectId: 'project-1',
  projectName: null,
  mint: '11111111111111111111111111111111',
  state: 'signed',
  createdAt: '2026-10-01T00:00:00.000Z',
  expiresAt: '2026-10-01T00:01:00.000Z',
  hasSignature: true,
  hasReceipt: true,
};
const page = (items = [item]) => ({
  format: 'launch-recovery-discovery-v1',
  scope: 'saved-solana-nonterminal',
  observedAt: '2026-10-24T00:00:00.000Z',
  cursor: null,
  nextCursor: null,
  items,
  signingAllowed: false,
  executionAllowed: false,
  receiptVerified: false,
});
it('keeps expired signed records unresolved and evidence unverified', () => {
  expect(validateLaunchRecoveryDiscovery(page()).items[0]).toEqual(item);
});
it('round trips original cursor positions and rejects authority/filter additions', () => {
  const c = encodeLaunchRecoveryCursor(item);
  expect(decodeLaunchRecoveryCursor(c)).toMatchObject({
    id: item.id,
    source: 'pump',
  });
  expect(launchRecoveryPageRequest(new URLSearchParams({ cursor: c }))).toBe(c);
  for (const q of ['owner=bob', 'cursor=x&cursor=y', 'limit=100', 'cursor='])
    expect(() => launchRecoveryPageRequest(new URLSearchParams(q))).toThrow();
  expect(() => decodeLaunchRecoveryCursor(c + '=')).toThrow();
});
it.each([
  { executionAllowed: true },
  { signingAllowed: true },
  { receiptVerified: true },
  { secret: 'raw' },
  { items: [item, item] },
  { items: Object.assign([], { length: 1 }) },
])('rejects authority, raw additions and malformed lists %j', (change) => {
  expect(() =>
    validateLaunchRecoveryDiscovery({ ...page(), ...change }),
  ).toThrow();
});
it.each([
  { mint: 'bad' },
  { state: 'finalized' },
  { source: 'unknown' },
  { expiresAt: item.createdAt },
  { id: 'bad\n' },
  { projectId: '../x' },
  { reviewKind: 'single' },
  { signed: 'raw' },
])('rejects malformed item %j', (change) =>
  expect(() => validateLaunchRecoveryItem({ ...item, ...change })).toThrow(),
);
it('rejects getters without invoking them', () => {
  let called = false;
  const x = { ...item };
  Object.defineProperty(x, 'id', {
    enumerable: true,
    get() {
      called = true;
      return 'x';
    },
  });
  expect(() => validateLaunchRecoveryItem(x)).toThrow();
  expect(called).toBe(false);
});
it('requires strict ordering and cursor binding', () => {
  expect(() =>
    validateLaunchRecoveryDiscovery(page([item, { ...item, id: 'z' }])),
  ).toThrow();
  const cursor = encodeLaunchRecoveryCursor(item);
  expect(() =>
    validateLaunchRecoveryDiscovery({ ...page(), cursor }, cursor),
  ).toThrow();
});
it('reads only bounded JSON and never echoes an HTML error', async () => {
  await expect(
    readLaunchRecoveryDiscovery(
      new Response('<secret>bad</secret>', { status: 502 }),
      new AbortController().signal,
    ),
  ).rejects.toThrow('discovery is unavailable');
  await expect(
    readLaunchRecoveryDiscovery(
      Response.json(page()),
      new AbortController().signal,
    ),
  ).resolves.toEqual(page());
});
