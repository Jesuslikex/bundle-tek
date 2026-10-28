import { afterAll, beforeAll, beforeEach, it, expect, vi } from 'vitest';
import { Miniflare } from 'miniflare';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { nativeWarmupFixture } from '../../../../../test/warmup-native-fixture';
import {
  requireWarmupSigningReview,
  type WarmupSigningReview,
} from '@/lib/warmup-signing';
import { warmupPreparationSummary } from '@/lib/warmup-preparation-history';
import { SOLANA_MAINNET_GENESIS } from '@/lib/wallet-balances';
import type { WarmupSigningEvent } from '@/lib/warmup-signing-events';
const mocks = vi.hoisted(() => ({
  db: null as unknown as D1Database,
  user: { userId: 'alice' } as { userId: string } | null,
  rpc: vi.fn(),
}));
vi.mock('@/app/chatgpt-auth', () => ({
  getChatGPTUser: async () => mocks.user,
}));
vi.mock('@/db', () => ({ getD1: () => mocks.db }));
vi.mock('@/lib/wallet-balances', async (original) => {
  const actual = await original<typeof import('@/lib/wallet-balances')>();
  return {
    ...actual,
    balanceRpc: (...args: Parameters<typeof actual.balanceRpc>) =>
      args[4] !== fetch ? actual.balanceRpc(...args) : mocks.rpc(...args),
  };
});
import { POST, GET } from './route';
import { GET as activity } from '../signing-activity/route';
let mf: Miniflare,
  f: Awaited<ReturnType<typeof nativeWarmupFixture>>,
  review: WarmupSigningReview;
beforeAll(async () => {
  mf = new Miniflare({
    telemetry: { enabled: false },
    workers: [
      {
        config: {
          name: 'warmup-failure-test',
          type: 'worker',
          compatibilityDate: '2026-09-01',
          manifest: {
            mainModule: 'index.js',
            modules: {
              'index.js': {
                type: 'esm',
                contents: 'export default {fetch(){return new Response("ok")}}',
              },
            },
          },
          env: { DB: { type: 'd1', id: 'warmup-failure-test-only' } },
        },
      },
    ],
  });
  mocks.db = await mf.getD1Database('DB', 'warmup-failure-test');
  for (const name of [
    '0021_wallet_warmup_plans',
    '0024_imported_token_projects',
    '0041_imported_swap_preparations',
    '0042_warmup_swap_preparations',
    '0045_warmup_signing_intents',
    '0047_shared_swap_reservations',
    '0046_warmup_signing_events',
    '0052_warmup_swap_failure',
  ])
    for (const sql of (
      await readFile(
        new URL(`../../../../../drizzle/${name}.sql`, import.meta.url),
        'utf8',
      )
    ).split('--> statement-breakpoint'))
      if (sql.trim()) await mocks.db.prepare(sql).run();
});
afterAll(async () => mf?.dispose());
beforeEach(async () => {
  mocks.user = { userId: 'alice' };
  await mocks.db
    .prepare('DROP TRIGGER warmup_signing_events_immutable_delete')
    .run();
  for (const table of [
    'warmup_signing_events',
    'warmup_signing_intents',
    'solana_swap_reservations',
    'solana_swap_signatures',
    'warmup_swap_preparations',
    'wallet_warmup_plans',
  ])
    await mocks.db.prepare('DELETE FROM ' + table).run();
  await mocks.db
    .prepare(
      "CREATE TRIGGER warmup_signing_events_immutable_delete BEFORE DELETE ON warmup_signing_events BEGIN SELECT RAISE(ABORT,'Warmup signing event is immutable'); END",
    )
    .run();
  f = await nativeWarmupFixture({ lookup: true, v2: true });
  review = {
    id: crypto.randomUUID(),
    preparationId: crypto.randomUUID(),
    wallet: f.wallet,
    sha256: f.order.preparation.sha256,
    transaction: f.order.preparation.transaction,
    network: 'mainnet',
    expiresAt: f.order.expiresAt,
    maximumFeeLamports: f.simulation.networkFeeLamports,
    inputRaw: f.order.inAmount,
    minimumOutputRaw: f.order.minimumOutAmount,
    inputMint: f.order.inputMint,
    outputMint: f.order.outputMint,
    lastValidBlockHeight: f.order.preparation.lastValidBlockHeight,
    settlement: await requireWarmupSigningReview(f.order, f.simulation),
  };
  await mocks.db
    .prepare('INSERT INTO wallet_warmup_plans VALUES(?,?,?,?,?,?)')
    .bind('alice', 'qa', '{}', 1, 0, new Date().toISOString())
    .run();
  await mocks.db
    .prepare('INSERT INTO warmup_swap_preparations VALUES(?,?,?,?,?,?,?,?,?)')
    .bind(
      review.preparationId,
      'alice',
      'qa',
      1,
      1,
      f.wallet,
      1,
      JSON.stringify(warmupPreparationSummary(f.order, f.simulation, f.mint)),
      new Date().toISOString(),
    )
    .run();
  await mocks.db
    .prepare(
      "INSERT INTO warmup_signing_intents(id,owner_id,preparation_id,wallet_address,document,state,signature,created_at,updated_at) VALUES(?,?,?,?,?,'signed',?,?,?)",
    )
    .bind(
      review.id,
      'alice',
      review.preparationId,
      f.wallet,
      JSON.stringify(review),
      f.signed.signature,
      new Date().toISOString(),
      new Date().toISOString(),
    )
    .run();
  mocks.rpc
    .mockReset()
    .mockImplementation(async (_endpoint, method) =>
      method === 'getGenesisHash' ? SOLANA_MAINNET_GENESIS : failedPacket(),
    );
});
const failedPacket = () => ({
  ...f.receipt,
  meta: {
    ...f.receipt.meta,
    postBalances: f.receipt.meta.preBalances.map((v, i) =>
      i === 0 ? (BigInt(v) - 5000n).toString() : v,
    ),
    err: { InstructionError: ['0', { Custom: '42' }] },
  },
});
const recover = () =>
  POST(
    new Request('http://local/api/wallet-workspace/warmup/signing', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'recover', id: review.id }),
    }),
  );
const events = async () => {
  const response = await activity(
    new Request(
      'http://local/api/wallet-workspace/warmup/signing-activity?planId=qa',
    ),
  );
  expect(response.status).toBe(200);
  return (await response.json()) as { events: WarmupSigningEvent[] };
};
const lock = () =>
  mocks.db
    .prepare(
      'SELECT state FROM solana_swap_reservations WHERE owner_id=? AND wallet_address=?',
    )
    .bind('alice', f.wallet)
    .first();
it('does not log or return a provider exception disguised as signing guidance', async () => {
  const secret = 'https://rpc.example.invalid/private-test-token';
  const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    mocks.rpc.mockRejectedValue(
      new Error(`Signing requires ${secret}`, {
        cause: new Error('synthetic-private-cause'),
      }),
    );
    const response = await recover();
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: 'Approval recovery unavailable. Keep the registered signature and check its outcome without resending.',
    });
    expect(logged.mock.calls).toEqual([
      ['Warmup approval failed', { stage: 'saved approval' }],
    ]);
    expect(JSON.stringify(logged.mock.calls)).not.toContain(secret);
    expect(JSON.stringify(logged.mock.calls)).not.toContain('synthetic-private-cause');
    expect(await lock()).toEqual({ state: 'signed' });
  } finally {
    logged.mockRestore();
  }
});
it('atomically retains failure fee and captured event, releases reservation once and isolates owners', async () => {
  expect(await lock()).toEqual({ state: 'signed' });
  const response = await recover();
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    state: 'failed',
    failureReceipt: {
      networkFeeLamports: '5000',
      walletChangeRaw: '-5000',
      error: { customCode: 42 },
    },
  });
  expect(await lock()).toBeNull();
  const page = await events();
  expect(page.events[0].failureReceipt?.networkFeeLamports).toBe('5000');
  expect(page.events[1].failureReceipt).toBeNull();
  await expect(
    mocks.db
      .prepare(
        'UPDATE warmup_signing_events SET failure_receipt=NULL WHERE sequence=?',
      )
      .bind(page.events[0].sequence)
      .run(),
  ).rejects.toThrow();
  await expect(
    mocks.db
      .prepare(
        'UPDATE warmup_signing_intents SET failure_receipt=NULL WHERE id=?',
      )
      .bind(review.id)
      .run(),
  ).rejects.toThrow();
  const calls = mocks.rpc.mock.calls.length;
  expect((await recover()).status).toBe(200);
  expect(mocks.rpc.mock.calls.length).toBe(calls);
  expect(mocks.rpc.mock.calls.some((c) => c[1] === 'sendTransaction')).toBe(
    false,
  );
  mocks.user = { userId: 'bob' };
  expect((await recover()).status).toBe(404);
  mocks.user = null;
  expect((await recover()).status).toBe(401);
});
it('enriches an older archived failed record without rewriting original snapshots and exposes both approval readers', async () => {
  await mocks.db
    .prepare(
      "UPDATE warmup_signing_intents SET state='failed',updated_at=? WHERE id=?",
    )
    .bind(new Date().toISOString(), review.id)
    .run();
  await mocks.db
    .prepare('UPDATE wallet_warmup_plans SET archived=1,revision=2')
    .run();
  const before = await events();
  expect((await recover()).status).toBe(200);
  const after = await events();
  expect(after.events.slice(1)).toEqual(before.events);
  expect(before.events[0].failureReceipt).toBeNull();
  expect(after.events[0].failureReceipt?.error.customCode).toBe(42);
  const single = await GET(
    new Request(
      'http://local/api/wallet-workspace/warmup/signing?preparationId=' +
        review.preparationId,
    ),
  );
  expect(single.status).toBe(200);
  expect(await single.json()).toMatchObject({
    intent: { state: 'failed', failureReceipt: { networkFeeLamports: '5000' } },
  });
  const list = await GET(
    new Request('http://local/api/wallet-workspace/warmup/signing?planId=qa'),
  );
  expect(list.status).toBe(200);
  const page = (await list.json()) as { intents: unknown[] };
  if (process.env.WARMUP_FAILURE_QA_EXPORT === '1') {
    const dir = new URL(
      '../../../../../work/warmup-failure-qa/',
      import.meta.url,
    );
    await mkdir(dir, { recursive: true });
    await writeFile(
      new URL('fixture.json', dir),
      JSON.stringify({
        planId: 'qa',
        intents: page.intents,
        events: after.events,
      }),
      'utf8',
    );
  }
});
it('keeps signed reservation when failure-event persistence fails and rolls back outcome/evidence', async () => {
  await mocks.db
    .prepare(
      "CREATE TRIGGER reject_failure BEFORE INSERT ON warmup_signing_events WHEN NEW.state='failed' BEGIN SELECT RAISE(ABORT,'test event failure'); END",
    )
    .run();
  try {
    expect((await recover()).status).not.toBe(200);
    expect(await lock()).toEqual({ state: 'signed' });
    expect(
      await mocks.db
        .prepare(
          'SELECT state,failure_receipt FROM warmup_signing_intents WHERE id=?',
        )
        .bind(review.id)
        .first(),
    ).toEqual({ state: 'signed', failure_receipt: null });
  } finally {
    await mocks.db.prepare('DROP TRIGGER reject_failure').run();
  }
  expect((await recover()).status).toBe(200);
  expect(await lock()).toBeNull();
});
it('withholds inconsistent rollback evidence and contradictory success for a saved failure', async () => {
  mocks.rpc.mockImplementation(async (_endpoint, method) =>
    method === 'getGenesisHash'
      ? SOLANA_MAINNET_GENESIS
      : {
          ...failedPacket(),
          meta: {
            ...failedPacket().meta,
            postBalances: f.receipt.meta.postBalances,
          },
        },
  );
  expect((await recover()).status).not.toBe(200);
  expect(await lock()).toEqual({ state: 'signed' });
  await mocks.db
    .prepare("UPDATE warmup_signing_intents SET state='failed' WHERE id=?")
    .bind(review.id)
    .run();
  mocks.rpc.mockImplementation(async (_endpoint, method) =>
    method === 'getGenesisHash' ? SOLANA_MAINNET_GENESIS : f.receipt,
  );
  expect((await recover()).status).not.toBe(200);
  expect(
    await mocks.db
      .prepare('SELECT failure_receipt FROM warmup_signing_intents WHERE id=?')
      .bind(review.id)
      .first(),
  ).toEqual({ failure_receipt: null });
});
