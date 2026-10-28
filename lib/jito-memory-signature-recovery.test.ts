import { expect, it, vi } from 'vitest';
import { jitoBundleFixture } from '../test/jito-bundle-fixture';
import { WalletSigningRejected } from './wallet-signing-rejection';
import { createJitoMemorySignatureRecovery } from './jito-memory-signature-recovery';
import { bundleFingerprint } from './jito-bundle';

const alice = 'a'.repeat(64),
  bob = 'b'.repeat(64);
it('serializes mutations and prompts and only accepts the originating sign token for its own packet', async () => {
  const f = await jitoBundleFixture(),
    cache = createJitoMemorySignatureRecovery();
  const token = cache.startOperation(alice, f.manifest.id, 0);
  expect(cache.operationActive()).toBe(true);
  expect(() => cache.startOperation(alice)).toThrow('in progress');
  expect(() => cache.startOperation(bob, f.manifest.id, 1)).toThrow(
    'in progress',
  );
  expect(() =>
    cache.requireRegistration(token, bob, f.manifest.id, 0),
  ).toThrow();
  expect(() =>
    cache.requireRegistration(token, alice, f.manifest.id, 1),
  ).toThrow();
  expect(() =>
    cache.requireRegistration({}, alice, f.manifest.id, 0),
  ).toThrow();
  expect(() =>
    cache.requireRegistration(token, alice, f.manifest.id, 0),
  ).not.toThrow();
  cache.finishOperation(token);
  const mutation = cache.startOperation(alice);
  expect(() => cache.startOperation(alice, f.manifest.id, 0)).toThrow(
    'in progress',
  );
  expect(() =>
    cache.requireRegistration(mutation, alice, f.manifest.id, 0),
  ).toThrow();
  cache.finishOperation(mutation);
  expect(cache.operationActive()).toBe(false);
});
it('lists only bounded pending identifiers for the matching owner and project session', async () => {
  const f = await jitoBundleFixture(),
    other = await jitoBundleFixture(),
    cache = createJitoMemorySignatureRecovery(2);
  await cache.reserve(alice, f.manifest, 0);
  await cache.reserve(alice, f.manifest, 1);
  expect(
    cache.pending(alice, f.manifest.projectId, f.manifest.sessionId),
  ).toEqual([
    { bundleId: f.manifest.id, packet: 0 },
    { bundleId: f.manifest.id, packet: 1 },
  ]);
  expect(
    cache.pending(bob, f.manifest.projectId, f.manifest.sessionId),
  ).toEqual([]);
  expect(
    cache.pending(alice, other.manifest.projectId, other.manifest.sessionId),
  ).toEqual([]);
  expect(() =>
    cache.pending('bad', f.manifest.projectId, f.manifest.sessionId),
  ).toThrow();
});

it('keeps a signature when the authenticated context changes during acknowledgement', async () => {
  const f = await jitoBundleFixture(),
    cache = createJitoMemorySignatureRecovery();
  const token = await cache.reserve(alice, f.manifest, 0);
  cache.markStarted(token);
  await cache.capture(token, f.manifest, f.swap.signed.transaction);
  let current = true;
  const pending = cache.acknowledge(
    alice,
    f.manifest,
    0,
    f.swap.signed.signature,
    () => {
      if (!current) throw Error('Context changed.');
    },
  );
  current = false;
  await expect(pending).rejects.toThrow('Context changed.');
  expect((await cache.inspect(alice, f.manifest, 0)).status).toBe('retained');
});

it.each([0, 1] as const)(
  'retains only a verified signature and reconstructs the exact packet %s after expiry',
  async (packet) => {
    const f = await jitoBundleFixture(),
      cache = createJitoMemorySignatureRecovery(),
      expected = packet === 0 ? f.swap.signed : f.tip.signed;
    const token = await cache.reserve(alice, f.manifest, packet);
    expect(await cache.inspect(alice, f.manifest, packet)).toEqual({
      status: 'reserved',
    });
    cache.markStarted(token);
    expect(await cache.inspect(alice, f.manifest, packet)).toEqual({
      status: 'started',
    });
    expect(await cache.capture(token, f.manifest, expected.transaction)).toBe(
      expected.signature,
    );
    expect(await cache.inspect(bob, f.manifest, packet)).toEqual({
      status: 'absent',
    });
    const clock = vi
      .spyOn(Date, 'now')
      .mockReturnValue(Date.parse(f.manifest.expiresAt) + 1);
    try {
      expect(await cache.inspect(alice, f.manifest, packet)).toEqual({
        status: 'retained',
        ...expected,
      });
      await expect(
        cache.acknowledge(alice, f.manifest, packet, 'different', () => {}),
      ).rejects.toThrow('acknowledgement');
      expect((await cache.inspect(alice, f.manifest, packet)).status).toBe(
        'retained',
      );
      await cache.acknowledge(
        alice,
        f.manifest,
        packet,
        expected.signature,
        () => {},
      );
      expect(await cache.inspect(alice, f.manifest, packet)).toEqual({
        status: 'absent',
      });
    } finally {
      clock.mockRestore();
    }
  },
);

it('binds owner, original bundle fingerprint, project, session, wallet and position', async () => {
  const f = await jitoBundleFixture(),
    other = await jitoBundleFixture(),
    cache = createJitoMemorySignatureRecovery();
  const token = await cache.reserve(alice, f.manifest, 0);
  expect(cache.has(alice, f.manifest.id, 0)).toBe(true);
  expect(cache.has(bob, f.manifest.id, 0)).toBe(false);
  expect(cache.has(alice, f.manifest.id, 1)).toBe(false);
  for (const [scope, id, index] of [
    ['bad', f.manifest.id, 0],
    [alice, 'not-a-uuid', 0],
    [alice, f.manifest.id, 5],
    [alice, f.manifest.id, -1],
  ] as const)
    expect(() => cache.has(scope, id, index)).toThrow('lookup');
  cache.markStarted(token);
  await cache.capture(token, f.manifest, f.swap.signed.transaction);
  expect(await cache.inspect(bob, f.manifest, 0)).toEqual({ status: 'absent' });
  expect(await cache.inspect(alice, other.manifest, 0)).toEqual({
    status: 'absent',
  });
  expect(await cache.inspect(alice, f.manifest, 1)).toEqual({
    status: 'absent',
  });
  for (const altered of [
    { ...f.manifest, projectId: other.manifest.projectId },
    { ...f.manifest, sessionId: other.manifest.sessionId },
    { ...f.manifest, sha256: '0'.repeat(64) },
    { ...f.manifest, swaps: [{ ...f.review, wallet: f.tip.review.recipient }] },
  ])
    await expect(cache.inspect(alice, altered, 0)).rejects.toThrow();
  const { sha256: _oldDigest, ...terms } = f.manifest;
  const differentProject = { ...terms, projectId: other.manifest.projectId };
  const independentlyValid = {
    ...differentProject,
    sha256: await bundleFingerprint(differentProject),
  };
  await expect(cache.inspect(alice, independentlyValid, 0)).rejects.toThrow(
    'context',
  );
  await expect(
    cache.inspect('not-an-owner-hash', f.manifest, 0),
  ).rejects.toThrow('owner scope');
  expect((await cache.inspect(alice, f.manifest, 0)).status).toBe('retained');
});

it('refuses duplicate and over-capacity reservations without evicting unresolved packets', async () => {
  const f = await jitoBundleFixture(),
    cache = createJitoMemorySignatureRecovery(1);
  const token = await cache.reserve(alice, f.manifest, 0);
  await expect(cache.reserve(alice, f.manifest, 0)).rejects.toThrow('pending');
  await expect(cache.reserve(alice, f.manifest, 1)).rejects.toThrow('capacity');
  cache.markStarted(token);
  await expect(cache.reserve(alice, f.manifest, 1)).rejects.toThrow('capacity');
  await cache.capture(token, f.manifest, f.swap.signed.transaction);
  await expect(cache.reserve(alice, f.manifest, 1)).rejects.toThrow('capacity');
  expect((await cache.inspect(alice, f.manifest, 0)).status).toBe('retained');
  await cache.acknowledge(
    alice,
    f.manifest,
    0,
    f.swap.signed.signature,
    () => {},
  );
  expect(await cache.reserve(alice, f.manifest, 1)).toBeDefined();
  for (const size of [0, 101, -1, 1.5])
    expect(() => createJitoMemorySignatureRecovery(size)).toThrow('capacity');
});

it('serializes concurrent duplicate reservations at the exact packet boundary', async () => {
  const f = await jitoBundleFixture(),
    cache = createJitoMemorySignatureRecovery();
  const results = await Promise.allSettled([
    cache.reserve(alice, f.manifest, 0),
    cache.reserve(alice, f.manifest, 0),
  ]);
  expect(
    results.filter((result) => result.status === 'fulfilled'),
  ).toHaveLength(1);
  expect(results.filter((result) => result.status === 'rejected')).toHaveLength(
    1,
  );
});

it('releases only unstarted or explicitly rejected prompts and holds unknown outcomes', async () => {
  const f = await jitoBundleFixture(),
    cache = createJitoMemorySignatureRecovery();
  const unstarted = await cache.reserve(alice, f.manifest, 0);
  cache.releaseUnstarted(unstarted);
  const token = await cache.reserve(alice, f.manifest, 0);
  cache.markStarted(token);
  expect(() => cache.releaseUnstarted(token)).toThrow('already started');
  expect(() => cache.releaseRejected(token, Error('unknown'))).toThrow(
    'not explicit',
  );
  expect((await cache.inspect(alice, f.manifest, 0)).status).toBe('started');
  cache.releaseRejected(token, new WalletSigningRejected({ code: 4001 }));
  expect((await cache.inspect(alice, f.manifest, 0)).status).toBe('absent');
  expect(() => cache.markStarted(token)).toThrow('reservation');
});

it('rejects forged or altered packets without destroying the original reservation', async () => {
  const f = await jitoBundleFixture(),
    cache = createJitoMemorySignatureRecovery();
  const token = await cache.reserve(alice, f.manifest, 0);
  cache.markStarted(token);
  await expect(
    cache.capture(token, f.manifest, f.manifest.swaps[0].transaction),
  ).rejects.toThrow();
  const changed = Uint8Array.from(atob(f.swap.signed.transaction), (c) =>
    c.charCodeAt(0),
  );
  changed[1] ^= 1;
  await expect(
    cache.capture(token, f.manifest, btoa(String.fromCharCode(...changed))),
  ).rejects.toThrow();
  expect((await cache.inspect(alice, f.manifest, 0)).status).toBe('started');
  await cache.capture(token, f.manifest, f.swap.signed.transaction);
  expect(() =>
    cache.releaseRejected(token, new WalletSigningRejected({ code: 4001 })),
  ).toThrow();
  expect((await cache.inspect(alice, f.manifest, 0)).status).toBe('retained');
});

it('does not release or replace a signature while capture verification is in flight', async () => {
  const f = await jitoBundleFixture(),
    cache = createJitoMemorySignatureRecovery();
  const token = await cache.reserve(alice, f.manifest, 0);
  cache.markStarted(token);
  const first = cache.capture(token, f.manifest, f.swap.signed.transaction);
  expect(() =>
    cache.releaseRejected(token, new WalletSigningRejected({ code: 4001 })),
  ).toThrow();
  await expect(
    cache.capture(token, f.manifest, f.swap.signed.transaction),
  ).rejects.toThrow('pending');
  await expect(first).resolves.toBe(f.swap.signed.signature);
  await expect(
    cache.capture(token, f.manifest, f.swap.signed.transaction),
  ).resolves.toBe(f.swap.signed.signature);
  expect((await cache.inspect(alice, f.manifest, 0)).status).toBe('retained');
});

it('notifies observers of lifecycle changes without disclosing any values', async () => {
  const f = await jitoBundleFixture(),
    cache = createJitoMemorySignatureRecovery();
  const listener = vi.fn(),
    unsubscribe = cache.subscribe(listener),
    broken = vi.fn(() => {
      throw Error('observer');
    });
  cache.subscribe(broken);
  const token = await cache.reserve(alice, f.manifest, 0);
  cache.markStarted(token);
  await cache.capture(token, f.manifest, f.swap.signed.transaction);
  expect(listener).toHaveBeenCalledTimes(3);
  expect(listener.mock.calls.every((args) => args.length === 0)).toBe(true);
  unsubscribe();
  await cache.acknowledge(
    alice,
    f.manifest,
    0,
    f.swap.signed.signature,
    () => {},
  );
  expect(listener).toHaveBeenCalledTimes(3);
  expect(broken).toHaveBeenCalledTimes(4);
});
