import { describe, expect, it, vi } from 'vitest';
import { jitoBundleFixture } from '../test/jito-bundle-fixture';
import { jitoOwnerScope } from './jito-owner-scope';
import { buildOwnedJitoSignedVector } from './jito-owned-signed-vector';

async function fixture() {
  const f = await jitoBundleFixture();
  const m = f.manifest;
  const swap = {
    bundleId: m.id,
    packet: 0,
    attemptId: crypto.randomUUID(),
    manifestSha256: m.sha256,
    signer: m.swaps[0].wallet,
    intentId: m.swaps[0].id,
    transaction: f.swap.signed.transaction,
    signature: f.swap.signed.signature,
    state: 'registered',
  };
  const tip = {
    bundleId: m.id,
    packet: 1,
    attemptId: crypto.randomUUID(),
    manifestSha256: m.sha256,
    signer: m.tip.wallet,
    intentId: null,
    transaction: f.tip.signed.transaction,
    signature: f.tip.signed.signature,
    state: 'registered',
  };
  const snapshot = {
    projectId: m.projectId,
    sessionId: m.sessionId,
    bundle: {
      manifest: m,
      state: 'reviewed',
      bundleId: null,
      signatures: [swap.signature, tip.signature],
      updatedAt: m.createdAt,
      finalization: null,
    },
    attempts: [swap, tip],
    legacyReadOnly: false,
  };
  const context = {
    ownerId: 'alice',
    responseOwnerScope: await jitoOwnerScope('alice'),
    projectId: m.projectId,
    sessionId: m.sessionId,
    bundleId: m.id,
    manifestSha256: m.sha256,
  };
  return {
    f,
    swap,
    tip,
    snapshot,
    context,
    input: { ...context, rawSnapshot: snapshot },
  };
}

describe('owned signed Jito vector evidence only', () => {
  it('binds exact ordered swap and tip while granting no execution authority', async () => {
    const f = await fixture();
    const fetcher = vi.spyOn(globalThis, 'fetch');
    try {
      const result = await buildOwnedJitoSignedVector(f.input);
      expect(result.packets.map((p) => p.packet)).toEqual([0, 1]);
      expect(result.packets.map((p) => p.transaction)).toEqual([
        f.swap.transaction,
        f.tip.transaction,
      ]);
      expect(result.packets[1].intentId).toBeNull();
      expect(result.fingerprint).toMatch(/^[a-f0-9]{64}$/);
      expect(result.signatureVerified).toBe(true);
      expect(result.providerQualified).toBe(false);
      expect(result.runtimeAttested).toBe(false);
      expect(result.signingAllowed).toBe(false);
      expect(result.executionAllowed).toBe(false);
      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      fetcher.mockRestore();
    }
  });
  it('detaches inputs before async validation and does not alias returned packet bytes', async () => {
    const f = await fixture();
    const pending = buildOwnedJitoSignedVector(f.input);
    f.input.ownerId = 'bob';
    f.snapshot.attempts[0].transaction = 'changed';
    f.snapshot.bundle.manifest.id = crypto.randomUUID();
    const result = await pending;
    expect(result.ownerScope).toBe(await jitoOwnerScope('alice'));
    expect(result.packets[0].transaction).toBe(f.f.swap.signed.transaction);
    const fresh = await fixture();
    const a = await buildOwnedJitoSignedVector(fresh.input);
    const first = a.packets[0].bytes[0];
    a.packets[0].bytes[0] ^= 255;
    const b = await buildOwnedJitoSignedVector(fresh.input);
    expect(b.packets[0].bytes[0]).toBe(first);
  });
  it('rejects changed transaction bytes, invalid signatures, and swap/tip substitution', async () => {
    for (const change of [
      'tamper',
      'signature',
      'swap-tip',
      'noncanonical',
    ] as const) {
      const f = await fixture();
      if (change === 'tamper') {
        const bytes = Buffer.from(f.swap.transaction, 'base64');
        bytes[1] ^= 1;
        f.swap.transaction = bytes.toString('base64');
      }
      if (change === 'signature') f.swap.signature = f.tip.signature;
      if (change === 'swap-tip')
        [f.swap.transaction, f.tip.transaction] = [
          f.tip.transaction,
          f.swap.transaction,
        ];
      if (change === 'noncanonical') f.swap.transaction += '\n';
      await expect(buildOwnedJitoSignedVector(f.input)).rejects.toThrow();
    }
  });
  it('rejects reordered packet positions and repeated or missing receipts', async () => {
    for (const change of [
      'positions',
      'duplicate',
      'missing',
      'unknown',
    ] as const) {
      const f = await fixture();
      if (change === 'positions') {
        f.swap.packet = 1;
        f.tip.packet = 0;
      }
      if (change === 'duplicate') f.tip.attemptId = f.swap.attemptId;
      if (change === 'missing') f.snapshot.attempts.pop();
      if (change === 'unknown') {
        f.swap.state = 'unknown';
        f.swap.transaction = null as unknown as string;
        f.swap.signature = null as unknown as string;
        f.snapshot.bundle.signatures[0] = null as unknown as string;
      }
      await expect(buildOwnedJitoSignedVector(f.input)).rejects.toThrow();
    }
  });
  it('orders unordered receipt rows by packet without changing the fingerprint', async () => {
    const f = await fixture();
    const first = await buildOwnedJitoSignedVector(f.input);
    f.snapshot.attempts.reverse();
    const second = await buildOwnedJitoSignedVector(f.input);
    expect(second.fingerprint).toBe(first.fingerprint);
    expect(second.packets.map((p) => p.packet)).toEqual([0, 1]);
  });
  it('rejects wrong owner, scope, project, session, bundle or manifest digest', async () => {
    for (const key of [
      'ownerId',
      'responseOwnerScope',
      'projectId',
      'sessionId',
      'bundleId',
      'manifestSha256',
    ] as const) {
      const f = await fixture();
      f.input[key] =
        key === 'manifestSha256'
          ? 'ab'.repeat(32)
          : key === 'ownerId'
            ? 'bob'
            : key === 'responseOwnerScope'
              ? await jitoOwnerScope('bob')
              : crypto.randomUUID();
      await expect(buildOwnedJitoSignedVector(f.input)).rejects.toThrow();
    }
  });
  it('rejects legacy, terminal and incomplete bundles', async () => {
    for (const change of ['legacy', 'submitted', 'missing'] as const) {
      const f = await fixture();
      if (change === 'legacy') f.snapshot.legacyReadOnly = true;
      if (change === 'submitted') {
        f.snapshot.bundle.state = 'submitted';
        f.snapshot.bundle.bundleId = 'aa'.repeat(32) as unknown as null;
      }
      if (change === 'missing')
        f.snapshot.bundle.signatures[1] = null as unknown as string;
      await expect(buildOwnedJitoSignedVector(f.input)).rejects.toThrow();
    }
  });
  it('changes the context fingerprint when the owner or attempt identity changes', async () => {
    const f = await fixture();
    const first = await buildOwnedJitoSignedVector(f.input);
    f.input.ownerId = 'bob';
    f.input.responseOwnerScope = await jitoOwnerScope('bob');
    const second = await buildOwnedJitoSignedVector(f.input);
    expect(second.fingerprint).not.toBe(first.fingerprint);
    f.swap.attemptId = crypto.randomUUID();
    const third = await buildOwnedJitoSignedVector(f.input);
    expect(third.fingerprint).not.toBe(second.fingerprint);
  });
});
