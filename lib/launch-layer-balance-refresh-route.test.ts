import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { BalanceSnapshot } from './wallet-balance-format';
import { layerBalanceRefreshFixture } from '../test/launch-layer-balance-refresh-fixture';
import { layerTestStorage } from '../test/launch-layer-storage';
import { saveOwnedLaunchLayerPlan } from './launch-layer-service';
import {
  refreshLayerSol,
  layerSolRefreshHttpError,
  readLayerSolJson,
  type LayerSolProgress,
} from './launch-layer-balance-refresh';

const state = vi.hoisted(() => ({
  db: null as D1Database | null,
  owner: 'alice' as string | null,
  observe: vi.fn(),
}));
vi.mock('@/app/chatgpt-auth', () => ({
  getChatGPTUser: async () => (state.owner ? { userId: state.owner } : null),
}));
vi.mock('@/db', () => ({ getD1: () => state.db! }));
vi.mock('@/lib/wallet-balances', async (original) => ({
  ...(await original<typeof import('./wallet-balances')>()),
  observeWalletBalances: async (
    chain: string,
    addresses: string[],
    signal: AbortSignal,
  ): Promise<BalanceSnapshot> => state.observe(chain, addresses, signal),
}));
import { GET } from '@/app/api/launch/layers/route';
import { POST } from '@/app/api/wallet-workspace/balances/route';

let f: Awaited<ReturnType<typeof layerBalanceRefreshFixture>>,
  storage: Awaited<ReturnType<typeof layerTestStorage>>,
  plan: Awaited<ReturnType<typeof saveOwnedLaunchLayerPlan>>;
let clock: number;
async function setup(count = 7) {
  f = await layerBalanceRefreshFixture(count);
  storage = await layerTestStorage(f.f);
  state.db = storage.db;
  state.owner = 'alice';
  await storage.client.executeMultiple(
    `CREATE TABLE wallet_balance_gates(owner_id TEXT PRIMARY KEY,next_allowed_at INTEGER NOT NULL);CREATE TABLE wallet_balance_snapshots(owner_id TEXT,chain TEXT,address TEXT,document TEXT,block_number INTEGER,PRIMARY KEY(owner_id,chain,address));`,
  );
  state.observe.mockReset();
  state.observe.mockImplementation(
    async (_chain: string, addresses: string[]) => f.refresh(addresses),
  );
  plan = await saveOwnedLaunchLayerPlan(
    storage.db,
    'alice',
    f.f.input,
    f.f.now,
  );
}
beforeEach(async () => {
  clock = Date.parse('2026-10-21T21:00:00.000Z');
  vi.spyOn(Date, 'now').mockImplementation(() => clock);
  await setup();
});
afterEach(() => {
  storage.client.close();
  state.db = null;
  vi.restoreAllMocks();
  vi.useRealTimers();
});
function campaign(onProgress: (p: LayerSolProgress) => void = () => {}) {
  const reads = vi.fn(async (signal: AbortSignal) => {
    const response = await GET(
      new Request(
        `https://bundle.test/api/launch/layers?projectId=${encodeURIComponent(plan.projectId)}&id=${plan.id}&balances=1`,
      ),
    );
    if (!response.ok) throw layerSolRefreshHttpError(response.status);
    const body = (await readLayerSolJson(response, signal)) as {
      evidence: unknown;
    };
    return body.evidence;
  });
  const refresh = vi.fn(async (addresses: string[], signal: AbortSignal) => {
    const response = await POST(
      new Request('https://bundle.test/api/wallet-workspace/balances', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: 'https://bundle.test',
        },
        body: JSON.stringify({ chain: 'Solana', addresses }),
        signal,
      }),
    );
    if (!response.ok) throw layerSolRefreshHttpError(response.status);
    const body = (await readLayerSolJson(response, signal)) as {
      snapshot: unknown;
    };
    return body.snapshot;
  });
  const publish = vi.fn();
  return {
    reads,
    refresh,
    publish,
    run: () =>
      refreshLayerSol({
        plan,
        signal: new AbortController().signal,
        current: () => true,
        readEvidence: reads,
        refreshGroup: refresh,
        onProgress,
        onComparison: publish,
      }),
  };
}
it('composes the actual owner GET, balance POST, atomic libSQL retention and exact GET recovery', async () => {
  const flow = campaign(),
    result = await flow.run();
  expect(flow.reads).toHaveBeenCalledTimes(2);
  expect(flow.refresh).toHaveBeenCalledTimes(1);
  expect(state.observe).toHaveBeenCalledTimes(1);
  expect(flow.publish).toHaveBeenCalledOnce();
  expect(
    (
      await storage.client.execute(
        'SELECT count(*) AS n FROM wallet_balance_snapshots',
      )
    ).rows[0].n,
  ).toBe(7);
  expect(result.observedTotalRaw).toBe(String(9007199254740993n * 7n));
  expect(result.evidence).toMatchObject({
    fundingAllowed: false,
    signingAllowed: false,
    executionAllowed: false,
  });
});
it('preserves the existing shared 15-second gate and does not repeat the provider call', async () => {
  await campaign().run();
  const flow = campaign();
  await expect(flow.run()).rejects.toMatchObject({ code: 'limited' });
  expect(state.observe).toHaveBeenCalledOnce();
  expect(flow.publish).not.toHaveBeenCalled();
});
it.each(['anonymous', 'foreign', 'stale'] as const)(
  'refuses %s scope before a balance provider call',
  async (kind) => {
    if (kind === 'anonymous') state.owner = null;
    if (kind === 'foreign') state.owner = 'bob';
    if (kind === 'stale')
      await storage.client.execute({
        sql: 'UPDATE workspace_projects SET archived=1 WHERE id=?',
        args: [plan.projectId],
      });
    const flow = campaign();
    await expect(flow.run()).rejects.toMatchObject({
      code: kind === 'anonymous' ? 'access' : 'changed',
    });
    expect(flow.refresh).not.toHaveBeenCalled();
    expect(state.observe).not.toHaveBeenCalled();
  },
);
it('refuses an entire retained group when a wallet revision changes during the read', async () => {
  state.observe.mockImplementation(
    async (_chain: string, addresses: string[]) => {
      const receipt = await f.refresh(addresses);
      await storage.client.execute({
        sql: 'UPDATE workspace_wallets SET revision=revision+1 WHERE address=?',
        args: [addresses[0]],
      });
      return receipt;
    },
  );
  const flow = campaign();
  await expect(flow.run()).rejects.toMatchObject({ code: 'changed' });
  expect(state.observe).toHaveBeenCalledOnce();
  expect(flow.publish).not.toHaveBeenCalled();
  expect(
    (
      await storage.client.execute(
        'SELECT count(*) AS n FROM wallet_balance_snapshots',
      )
    ).rows[0].n,
  ).toBe(0);
});
it('passes the actual owner gate after the finite group wait and confirms all earlier libSQL rows', async () => {
  storage.client.close();
  await setup(105);
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  let waiting!: () => void;
  const reachedWait = new Promise<void>((resolve) => {
    waiting = resolve;
  });
  const flow = campaign((p) => {
    if (p.phase === 'waiting') waiting();
  });
  const run = flow.run();
  await reachedWait;
  expect(state.observe).toHaveBeenCalledOnce();
  clock += 14999;
  await vi.advanceTimersByTimeAsync(14999);
  expect(state.observe).toHaveBeenCalledOnce();
  clock++;
  await vi.advanceTimersByTimeAsync(1);
  const result = await run;
  expect(state.observe).toHaveBeenCalledTimes(2);
  expect(flow.reads).toHaveBeenCalledTimes(4);
  expect(flow.publish).toHaveBeenCalledTimes(2);
  expect(result.rows.every((row) => row.observation !== null)).toBe(true);
  expect(result.observedTotalRaw).toBeNull();
  expect(
    (
      await storage.client.execute(
        'SELECT count(*) AS n FROM wallet_balance_snapshots',
      )
    ).rows[0].n,
  ).toBe(105);
});
