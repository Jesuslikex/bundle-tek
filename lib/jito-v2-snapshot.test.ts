import { describe, expect, it } from 'vitest';
import { jitoBundleFixture } from '../test/jito-bundle-fixture';
import { jitoOwnerScope } from './jito-owner-scope';
import { requireJitoV2Snapshot } from './jito-v2-snapshot';

async function fixture() {
  const f = await jitoBundleFixture();
  const m = f.manifest;
  const expected = {
    ownerId: 'authenticated-owner',
    responseOwnerScope: await jitoOwnerScope('authenticated-owner'),
    projectId: m.projectId,
    sessionId: m.sessionId,
    bundleId: m.id,
    manifestSha256: m.sha256,
  };
  const snapshot = {
    projectId: m.projectId,
    sessionId: m.sessionId,
    bundle: {
      manifest: m,
      state: 'reviewed',
      bundleId: null,
      signatures: [null, null] as (string | null)[],
      updatedAt: m.createdAt,
      finalization: null,
    },
    attempts: [] as Array<Record<string, unknown>>,
    legacyReadOnly: false,
  };
  const attempt = {
    bundleId: m.id,
    packet: 0,
    attemptId: crypto.randomUUID(),
    manifestSha256: m.sha256,
    signer: m.swaps[0].wallet,
    intentId: m.swaps[0].id,
    transaction: null,
    signature: null,
    state: 'unknown',
  };
  return { f, expected, snapshot, attempt };
}

describe('exact authenticated Jito v2 snapshot', () => {
  it('validates a detached snapshot when input and context change during asynchronous checks', async () => {
    const { expected, snapshot, attempt } = await fixture();
    snapshot.attempts.push(attempt);
    const original = structuredClone(snapshot);
    const pending = requireJitoV2Snapshot(snapshot, expected);
    snapshot.projectId = crypto.randomUUID();
    snapshot.bundle.manifest.swaps[0].wallet = 'changed-while-pending';
    snapshot.attempts[0].signer = 'changed-while-pending';
    snapshot.attempts.length = 0;
    expected.manifestSha256 = 'aa'.repeat(32);
    const validated = await pending;
    expect(validated).toEqual(original);
    expect(validated).not.toBe(snapshot);
    expect(validated.bundle).not.toBe(snapshot.bundle);
    snapshot.bundle.state = 'cancelled';
    expect(validated.bundle.state).toBe('reviewed');
  });
  it('accepts empty and unknown evidence without granting any operation authority', async () => {
    const { expected, snapshot, attempt } = await fixture();
    expect(await requireJitoV2Snapshot(snapshot, expected)).toEqual(snapshot);
    snapshot.attempts.push(attempt);
    expect(
      (await requireJitoV2Snapshot(snapshot, expected)).attempts[0].state,
    ).toBe('unknown');
  });
  it('matches registered signatures and exact packet, wallet and intent including tip', async () => {
    const { f, expected, snapshot, attempt } = await fixture();
    snapshot.bundle.signatures = [
      f.swap.signed.signature,
      f.tip.signed.signature,
    ];
    snapshot.attempts.push(
      {
        ...attempt,
        state: 'registered',
        transaction: f.swap.signed.transaction,
        signature: f.swap.signed.signature,
      },
      {
        ...attempt,
        packet: 1,
        attemptId: crypto.randomUUID(),
        signer: f.manifest.tip.wallet,
        intentId: null,
        state: 'registered',
        transaction: f.tip.signed.transaction,
        signature: f.tip.signed.signature,
      },
    );
    expect(
      (await requireJitoV2Snapshot(snapshot, expected)).attempts,
    ).toHaveLength(2);
  });
  it('keeps legacy history read-only and permits its historical signatures without v2 attempts', async () => {
    const { f, expected, snapshot } = await fixture();
    snapshot.legacyReadOnly = true;
    snapshot.bundle.signatures[0] = f.swap.signed.signature;
    expect(
      (await requireJitoV2Snapshot(snapshot, expected)).legacyReadOnly,
    ).toBe(true);
    snapshot.legacyReadOnly = false;
    await expect(requireJitoV2Snapshot(snapshot, expected)).rejects.toThrow();
  });
  it('retains legacy finalized history without treating a missing receipt as verified', async () => {
    const { f, expected, snapshot } = await fixture();
    snapshot.legacyReadOnly = true;
    snapshot.bundle.state = 'finalized';
    snapshot.bundle.signatures = [
      f.swap.signed.signature,
      f.tip.signed.signature,
    ];
    const legacy = await requireJitoV2Snapshot(snapshot, expected);
    expect(legacy.legacyReadOnly).toBe(true);
    expect(legacy.bundle.finalization).toBeNull();
    snapshot.legacyReadOnly = false;
    await expect(requireJitoV2Snapshot(snapshot, expected)).rejects.toThrow();
  });
  it('refuses absent attempt history, legacy status, or authenticated owner binding', async () => {
    const { expected, snapshot } = await fixture();
    await expect(
      requireJitoV2Snapshot({ ...snapshot, attempts: undefined }, expected),
    ).rejects.toThrow();
    await expect(
      requireJitoV2Snapshot(
        { ...snapshot, legacyReadOnly: undefined },
        expected,
      ),
    ).rejects.toThrow();
    await expect(
      requireJitoV2Snapshot(snapshot, {
        ...expected,
        ownerId: 'another-owner',
      }),
    ).rejects.toThrow();
    await expect(
      requireJitoV2Snapshot(snapshot, {
        ...expected,
        responseOwnerScope: null,
      }),
    ).rejects.toThrow();
  });
  it('refuses a different project, session, bundle, or digest', async () => {
    const { expected, snapshot } = await fixture();
    for (const key of ['projectId', 'sessionId', 'bundleId'] as const)
      await expect(
        requireJitoV2Snapshot(snapshot, {
          ...expected,
          [key]: crypto.randomUUID(),
        }),
      ).rejects.toThrow();
    await expect(
      requireJitoV2Snapshot(snapshot, {
        ...expected,
        manifestSha256: 'ab'.repeat(32),
      }),
    ).rejects.toThrow();
  });
  it('refuses wrong and duplicate attempt identities, packet indices, and contexts', async () => {
    const { expected, snapshot, attempt } = await fixture();
    const bad = [
      { ...attempt, packet: -1 },
      { ...attempt, packet: 2 },
      { ...attempt, packet: 0.5 },
      { ...attempt, bundleId: crypto.randomUUID() },
      { ...attempt, attemptId: 'bad' },
      { ...attempt, manifestSha256: 'ab'.repeat(32) },
      { ...attempt, signer: 'other' },
      { ...attempt, intentId: null },
      { ...attempt, state: 'mystery' },
    ];
    for (const item of bad)
      await expect(
        requireJitoV2Snapshot({ ...snapshot, attempts: [item] }, expected),
      ).rejects.toThrow();
    await expect(
      requireJitoV2Snapshot(
        { ...snapshot, attempts: [attempt, { ...attempt }] },
        expected,
      ),
    ).rejects.toThrow();
    await expect(
      requireJitoV2Snapshot(
        {
          ...snapshot,
          attempts: [
            attempt,
            {
              ...attempt,
              packet: 1,
              signer: snapshot.bundle.manifest.tip.wallet,
              intentId: null,
            },
          ],
        },
        expected,
      ),
    ).rejects.toThrow();
  });
  it('refuses inconsistent receipts and record states', async () => {
    const { f, expected, snapshot, attempt } = await fixture();
    for (const item of [
      { ...attempt, state: 'unknown', transaction: f.swap.signed.transaction },
      {
        ...attempt,
        state: 'registered',
        transaction: f.swap.signed.transaction,
        signature: f.swap.signed.signature,
      },
      {
        ...attempt,
        state: 'registered',
        transaction: null,
        signature: f.swap.signed.signature,
      },
    ])
      await expect(
        requireJitoV2Snapshot({ ...snapshot, attempts: [item] }, expected),
      ).rejects.toThrow();
    for (const state of ['submitting', 'submitted', 'finalized'])
      await expect(
        requireJitoV2Snapshot(
          { ...snapshot, bundle: { ...snapshot.bundle, state } },
          expected,
        ),
      ).rejects.toThrow();
    await expect(
      requireJitoV2Snapshot(
        { ...snapshot, attempts: [attempt], legacyReadOnly: true },
        expected,
      ),
    ).rejects.toThrow();
    await expect(
      requireJitoV2Snapshot(
        {
          ...snapshot,
          attempts: [attempt],
          bundle: { ...snapshot.bundle, state: 'cancelled' },
        },
        expected,
      ),
    ).rejects.toThrow();
  });
});
