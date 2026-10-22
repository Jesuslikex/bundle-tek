import { afterEach, expect, it, vi } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { volumeCleanupExclusionFixture } from './volume-cleanup-exclusion-fixture';
import {
  reserveFamily,
  signFamily,
  advanceFamilyExclusionClock,
} from './solana-family-exclusion-fixture';
import {
  markVolumeBundleAttempted,
  cancelVolumeBundleReservation,
  readVolumeBundleTipBudget,
} from '../lib/volume-bundle-reservations';
import {
  bindVolumeRecoveryPacket,
  recoverVolumeBundleSettlement,
} from '../lib/volume-bundle-recovery';
import { volumePumpSettlementFixture } from './volume-pump-settlement-fixture';
import { SOLANA_MAINNET_GENESIS } from '../lib/wallet-balances';

const databases: DatabaseSync[] = [];
async function fixture(maxMigration = Number.MAX_SAFE_INTEGER) {
  const f = await volumeCleanupExclusionFixture(maxMigration);
  databases.push(f.sqlite);
  return f;
}
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

it('admits an actual validated disabled runtime on the complete schema without a real provider or signer', async () => {
  const f = await fixture();
  const held = await f.reserve();
  expect(held).toMatchObject({
    state: 'held',
    signingAllowed: false,
    executionAllowed: false,
  });
  expect(
    f.sqlite.prepare('SELECT count(*) n FROM volume_bundle_reservations').get(),
  ).toEqual({ n: 1 });
});

it('cleanup blocks a newly validated bundle reservation atomically', async () => {
  const f = await fixture();
  reserveFamily(f.sqlite, 'cleanup', f.review.wallet, f.owner);
  await expect(f.reserve()).rejects.toThrow(/reserved/i);
  expect(
    f.sqlite.prepare('SELECT count(*) n FROM volume_bundle_reservations').get(),
  ).toEqual({ n: 0 });
  expect(
    f.sqlite
      .prepare('SELECT count(*) n FROM volume_bundle_reservation_events')
      .get(),
  ).toEqual({ n: 0 });
});

it('a held bundle blocks a new cleanup even after its review expires', async () => {
  const f = await fixture();
  await f.reserve();
  advanceFamilyExclusionClock(f.sqlite, 60000);
  expect(
    f.sqlite
      .prepare(
        "SELECT expires_at<strftime('%Y-%m-%dT%H:%M:%fZ','now') expired FROM volume_bundle_reservations",
      )
      .get(),
  ).toEqual({ expired: 1 });
  expect(() =>
    reserveFamily(f.sqlite, 'cleanup', f.review.wallet, f.owner),
  ).toThrow(/reserved/i);
});

it('a conservative attempted marker keeps blocking cleanup and cannot be cancelled', async () => {
  const f = await fixture();
  await f.reserve();
  await markVolumeBundleAttempted(
    f.db,
    f.owner,
    f.request.id,
    crypto.randomUUID(),
  );
  advanceFamilyExclusionClock(f.sqlite, 60000);
  expect(() =>
    reserveFamily(f.sqlite, 'cleanup', f.review.wallet, f.owner),
  ).toThrow(/reserved/i);
  await expect(
    cancelVolumeBundleReservation(f.db, f.owner, f.request.id),
  ).rejects.toThrow(/cannot be released/i);
});

it('explicit never-attempted cancellation preserves history and permits cleanup', async () => {
  const f = await fixture();
  await f.reserve();
  await cancelVolumeBundleReservation(f.db, f.owner, f.request.id);
  reserveFamily(f.sqlite, 'cleanup', f.review.wallet, f.owner);
  expect(
    f.sqlite.prepare('SELECT state FROM volume_bundle_reservations').get(),
  ).toEqual({ state: 'cancelled' });
  expect(
    f.sqlite.prepare('SELECT count(*) n FROM wallet_cleanups').get(),
  ).toEqual({ n: 1 });
  expect(
    await readVolumeBundleTipBudget(f.db, f.owner, f.saved.id),
  ).toMatchObject({ heldLamports: '0' });
});

it.each(['signing', 'signed', 'submitted'] as const)(
  'cleanup in %s blocks a newly validated bundle',
  async (state) => {
    const f = await fixture();
    reserveFamily(f.sqlite, 'cleanup', f.review.wallet, f.owner);
    if (state === 'signing')
      f.sqlite.prepare("UPDATE wallet_cleanups SET state='signing'").run();
    else signFamily(f.sqlite, 'cleanup', state === 'submitted');
    await expect(f.reserve()).rejects.toThrow(/reserved/i);
    expect(
      f.sqlite
        .prepare('SELECT count(*) n FROM volume_bundle_reservations')
        .get(),
    ).toEqual({ n: 0 });
  },
);

it('keeps same public addresses independent across owners and unrelated wallets', async () => {
  const f = await fixture();
  await f.reserve();
  reserveFamily(f.sqlite, 'cleanup', f.review.wallet, 'other-owner');
  reserveFamily(f.sqlite, 'cleanup', 'other-wallet', f.owner);
  expect(
    f.sqlite.prepare('SELECT count(*) n FROM wallet_cleanups').get(),
  ).toEqual({ n: 2 });
});

it('blocks a legacy held marker from becoming attempted without releasing budget or history', async () => {
  const f = await fixture(137);
  reserveFamily(f.sqlite, 'cleanup', f.review.wallet, f.owner);
  await f.reserve();
  f.sqlite.exec(
    readFileSync('drizzle/0138_volume_bundle_cleanup_exclusion.sql', 'utf8'),
  );
  await expect(
    markVolumeBundleAttempted(f.db, f.owner, f.request.id, crypto.randomUUID()),
  ).rejects.toThrow(/reserved by cleanup/i);
  expect(
    f.sqlite
      .prepare('SELECT state,attempt_id FROM volume_bundle_reservations')
      .get(),
  ).toEqual({ state: 'held', attempt_id: null });
  expect(
    (await readVolumeBundleTipBudget(f.db, f.owner, f.saved.id)).heldLamports,
  ).toBe('100000');
  expect(
    f.sqlite
      .prepare('SELECT count(*) n FROM volume_bundle_reservation_events')
      .get(),
  ).toEqual({ n: 1 });
  await cancelVolumeBundleReservation(f.db, f.owner, f.request.id);
  f.sqlite.prepare("UPDATE wallet_cleanups SET state='signing'").run();
});

it.each([
  { signed: false, attempted: false },
  { signed: true, attempted: false },
  { signed: false, attempted: true },
  { signed: true, attempted: true },
])(
  'refuses legacy cleanup signing or sending while a bundle remains: %j',
  async ({ signed, attempted }) => {
    const f = await fixture(137);
    reserveFamily(f.sqlite, 'cleanup', f.review.wallet, f.owner);
    if (signed) signFamily(f.sqlite, 'cleanup');
    await f.reserve();
    if (attempted)
      await markVolumeBundleAttempted(
        f.db,
        f.owner,
        f.request.id,
        crypto.randomUUID(),
      );
    f.sqlite.exec(
      readFileSync('drizzle/0138_volume_bundle_cleanup_exclusion.sql', 'utf8'),
    );
    expect(() =>
      f.sqlite
        .prepare(
          `UPDATE wallet_cleanups SET state='${signed ? 'submitted' : 'signing'}'`,
        )
        .run(),
    ).toThrow(/reserved by same-block Volume/i);
    expect(f.sqlite.prepare('SELECT state FROM wallet_cleanups').get()).toEqual(
      { state: signed ? 'signed' : 'awaiting_signature' },
    );
  },
);

it('keeps a legacy attempted marker readable and idempotent under conflict without new signing authority', async () => {
  const f = await fixture(137);
  reserveFamily(f.sqlite, 'cleanup', f.review.wallet, f.owner);
  await f.reserve();
  const attempt = crypto.randomUUID();
  await markVolumeBundleAttempted(f.db, f.owner, f.request.id, attempt);
  f.sqlite.exec(
    readFileSync('drizzle/0138_volume_bundle_cleanup_exclusion.sql', 'utf8'),
  );
  expect(
    await markVolumeBundleAttempted(f.db, f.owner, f.request.id, attempt),
  ).toMatchObject({
    state: 'attempted',
    attemptId: attempt,
    signingAllowed: false,
    executionAllowed: false,
  });
  await expect(
    markVolumeBundleAttempted(f.db, f.owner, f.request.id, crypto.randomUUID()),
  ).rejects.toThrow(/cannot be marked/i);
  await expect(
    cancelVolumeBundleReservation(f.db, f.owner, f.request.id),
  ).rejects.toThrow(/cannot be released/i);
});

it('returns only the old disabled reservation on a matching retry under legacy conflict, without fresh RPC or another hold', async () => {
  const f = await fixture(137);
  reserveFamily(f.sqlite, 'cleanup', f.review.wallet, f.owner);
  const held = await f.reserve();
  f.sqlite.exec(
    readFileSync('drizzle/0138_volume_bundle_cleanup_exclusion.sql', 'utf8'),
  );
  advanceFamilyExclusionClock(f.sqlite, 60000);
  const rpc = vi.fn(async () => {
    throw Error('Idempotent historical lookup must not request RPC');
  });
  f.deps.rpc = rpc;
  expect(await f.reserve()).toEqual(held);
  expect(rpc).not.toHaveBeenCalled();
  expect(held).toMatchObject({
    signingAllowed: false,
    executionAllowed: false,
  });
  expect(
    f.sqlite.prepare('SELECT count(*) n FROM volume_bundle_reservations').get(),
  ).toEqual({ n: 1 });
  expect(
    f.sqlite
      .prepare('SELECT count(*) n FROM volume_bundle_reservation_events')
      .get(),
  ).toEqual({ n: 1 });
});

it('records an exact synthetic finalized settlement under a legacy cleanup conflict without resending', async () => {
  const f = await fixture(137);
  const receipt = await volumePumpSettlementFixture();
  expect(f.review.sha256).toBe(receipt.review.sha256);
  reserveFamily(f.sqlite, 'cleanup', f.review.wallet, f.owner);
  await f.reserve();
  const attempt = crypto.randomUUID();
  await markVolumeBundleAttempted(f.db, f.owner, f.request.id, attempt);
  await bindVolumeRecoveryPacket(
    f.db,
    f.owner,
    f.request.id,
    attempt,
    receipt.packet,
  );
  f.sqlite.exec(
    readFileSync('drizzle/0138_volume_bundle_cleanup_exclusion.sql', 'utf8'),
  );
  const calls: string[] = [];
  let landed = false;
  const rpc = async (method: string) => {
    calls.push(method);
    if (method === 'getGenesisHash') return SOLANA_MAINNET_GENESIS;
    if (method === 'getTransaction')
      return landed ? structuredClone(receipt.receipt.result) : null;
    throw Error('No send or other RPC is available');
  };
  await expect(
    recoverVolumeBundleSettlement(
      f.db,
      f.owner,
      f.request.id,
      rpc,
      new AbortController().signal,
    ),
  ).resolves.toMatchObject({
    state: 'unresolved',
    holdsRetained: true,
    signingAllowed: false,
    executionAllowed: false,
  });
  expect(
    f.sqlite.prepare('SELECT state FROM volume_bundle_reservations').get(),
  ).toEqual({ state: 'attempted' });
  expect(() =>
    f.sqlite.prepare("UPDATE wallet_cleanups SET state='signing'").run(),
  ).toThrow(/reserved by same-block Volume/);
  expect(f.sqlite.prepare('SELECT state FROM wallet_cleanups').get()).toEqual({
    state: 'awaiting_signature',
  });
  landed = true;
  await recoverVolumeBundleSettlement(
    f.db,
    f.owner,
    f.request.id,
    rpc,
    new AbortController().signal,
  );
  expect(
    f.sqlite.prepare('SELECT state FROM volume_bundle_reservations').get(),
  ).toEqual({ state: 'settled' });
  f.sqlite.prepare("UPDATE wallet_cleanups SET state='signing'").run();
  expect(calls).not.toContain('sendTransaction');
  expect(
    f.sqlite.prepare('SELECT count(*) n FROM volume_bundle_settlements').get(),
  ).toEqual({ n: 1 });
});
