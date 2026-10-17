import bs58 from 'bs58';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  armSniperGuard,
  observeSniperGuard,
  readSniperGuard,
  saveSniperGuardSettings,
  stopSniperGuard,
  type SniperGuardLaunchReader,
} from './sniper-guard-service';
import type { SniperGuardRpc } from './sniper-guard-chain';
import { PUMP_NATIVE_QUOTE } from './pump-launch-config';
import type { SniperGuardSettings } from './sniper-guard';

const key = (n: number) => bs58.encode(new Uint8Array(32).fill(n));
const sig = (n: number) => bs58.encode(new Uint8Array(64).fill(n));
const REVIEW = 'review-1',
  PROJECT = 'project-1';
const dev = key(1),
  holder = key(2),
  owned = key(3),
  sniper = key(9),
  curve = key(40);
const settings = (
  patch: Partial<SniperGuardSettings> = {},
): SniperGuardSettings => ({
  format: 'sniper-guard-settings-v1',
  thresholdRaw: '1000',
  response: { kind: 'nuke', scope: 'holders' },
  end: { kind: 'timed', seconds: 30 },
  whitelist: [],
  ...patch,
});
let launchState = 'signed';
const readLaunch: SniperGuardLaunchReader = async () => ({
  projectId: PROJECT,
  launchState,
  launch: {
    mint: key(50),
    bondingCurve: curve,
    quoteMint: PUMP_NATIVE_QUOTE,
    quoteDecimals: 9,
    quoteTokenProgram: null,
    developer: dev,
    holders: [holder],
  },
});
const readState = async () => launchState;
const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  launchState = 'signed';
});
function database() {
  const sqlite = new DatabaseSync(':memory:');
  databases.push(sqlite);
  sqlite.exec(
    'CREATE TABLE pump_launch_reviews(id TEXT PRIMARY KEY);CREATE TABLE wallet_ownership_proofs(owner_id TEXT,chain TEXT,address TEXT);',
  );
  sqlite.prepare('INSERT INTO pump_launch_reviews VALUES(?)').run(REVIEW);
  sqlite
    .prepare('INSERT INTO wallet_ownership_proofs VALUES(?,?,?)')
    .run('owner', 'Solana', owned);
  for (const part of readFileSync(
    'drizzle/0095_sniper_guards.sql',
    'utf8',
  ).split('--> statement-breakpoint'))
    sqlite.exec(part);
  const db = {
    prepare(sql: string) {
      let values: unknown[] = [];
      const statement = {
        bind(...next: unknown[]) {
          values = next;
          return statement;
        },
        async first() {
          return sqlite.prepare(sql).get(...(values as never[])) ?? null;
        },
        async all() {
          return { results: sqlite.prepare(sql).all(...(values as never[])) };
        },
        async run() {
          const r = sqlite.prepare(sql).run(...(values as never[]));
          return { meta: { changes: Number(r.changes) } };
        },
      };
      return statement;
    },
  };
  return { sqlite, db: db as unknown as D1Database };
}
function chain(
  rows: { n: number; signer: string; lamports: number }[],
  balances = {
    value: [
      {
        data: {
          parsed: {
            info: {
              mint: key(50),
              owner: holder,
              tokenAmount: { amount: '777' },
            },
          },
        },
      },
    ],
  },
) {
  return vi.fn<SniperGuardRpc>(async (method, params) => {
    if (method === 'getSignaturesForAddress') {
      const until = (params[1] as { until?: string }).until;
      const newest = [...rows].reverse().map((r) => ({
        signature: sig(r.n),
        slot: r.n,
        err: null,
      }));
      const stop = newest.findIndex((r) => r.signature === until);
      return stop >= 0 ? newest.slice(0, stop) : newest;
    }
    if (method === 'getTransaction') {
      const row = rows.find((r) => sig(r.n) === params[0])!;
      return {
        slot: row.n,
        blockTime: null,
        meta: {
          err: null,
          preBalances: [5e9, 0],
          postBalances: [4e9, row.lamports],
        },
        transaction: {
          signatures: [sig(row.n)],
          message: {
            accountKeys: [
              { pubkey: row.signer, signer: true },
              { pubkey: curve, signer: false },
            ],
          },
        },
      };
    }
    if (method === 'getMultipleAccounts') return balances;
    throw new Error(method);
  });
}
const signal = () => new AbortController().signal;
const at = (ms: number) => new Date(Date.UTC(2026, 9, 17, 5, 0, 0) + ms);

describe('Sniper Guard storage', () => {
  it('saves editable planned settings and locks them once armed', async () => {
    const { db } = database();
    const saved = await saveSniperGuardSettings(
      db,
      'owner',
      REVIEW,
      settings(),
      null,
      at(0),
      readLaunch,
    );
    expect(saved).toMatchObject({
      state: 'planned',
      revision: 1,
      projectId: PROJECT,
    });
    expect(saved.automaticExecution).toBe(false);
    const edited = await saveSniperGuardSettings(
      db,
      'owner',
      REVIEW,
      settings({ thresholdRaw: '2000' }),
      1,
      at(1),
      readLaunch,
    );
    expect(edited.settings.thresholdRaw).toBe('2000');
    await expect(
      saveSniperGuardSettings(
        db,
        'owner',
        REVIEW,
        settings(),
        1,
        at(2),
        readLaunch,
      ),
    ).rejects.toThrow('changed elsewhere');
    const armed = await armSniperGuard(
      db,
      'owner',
      REVIEW,
      2,
      at(3),
      readLaunch,
    );
    expect(armed.state).toBe('watching');
    expect(armed.launch?.bondingCurve).toBe(curve);
    await expect(
      saveSniperGuardSettings(
        db,
        'owner',
        REVIEW,
        settings(),
        3,
        at(4),
        readLaunch,
      ),
    ).rejects.toThrow('locked');
  });
  it('keeps other owners out', async () => {
    const { db } = database();
    await saveSniperGuardSettings(
      db,
      'owner',
      REVIEW,
      settings(),
      null,
      at(0),
      readLaunch,
    );
    expect(await readSniperGuard(db, 'someone-else', REVIEW)).toBeNull();
  });
  it('refuses a cancelled or failed launch', async () => {
    const { db } = database();
    launchState = 'cancelled';
    await expect(
      saveSniperGuardSettings(
        db,
        'owner',
        REVIEW,
        settings(),
        null,
        at(0),
        readLaunch,
      ),
    ).rejects.toThrow('nothing to watch');
  });
  it('database triggers reject illegal transitions even without the service', async () => {
    const { db, sqlite } = database();
    await saveSniperGuardSettings(
      db,
      'owner',
      REVIEW,
      settings(),
      null,
      at(0),
      readLaunch,
    );
    expect(() =>
      sqlite.exec(
        "UPDATE sniper_guards SET state='triggered',revision=2,finished_at='x'",
      ),
    ).toThrow('transition rejected');
    expect(() =>
      sqlite.exec("UPDATE sniper_guards SET state='watching',revision=2"),
    ).toThrow('transition rejected');
    expect(() => sqlite.exec('DELETE FROM sniper_guards')).toThrow('retained');
    await stopSniperGuard(db, 'owner', REVIEW, 1, at(1));
    expect(() =>
      sqlite.exec(
        "UPDATE sniper_guards SET state='planned',revision=3,finished_at=NULL",
      ),
    ).toThrow('transition rejected');
  });
});

describe('Sniper Guard observation', () => {
  async function armed() {
    const ctx = database();
    await saveSniperGuardSettings(
      ctx.db,
      'owner',
      REVIEW,
      settings(),
      null,
      at(0),
      readLaunch,
    );
    await armSniperGuard(ctx.db, 'owner', REVIEW, 1, at(0), readLaunch);
    return ctx;
  }
  it('keeps watching while external buys stay at or under the threshold', async () => {
    const { db } = await armed();
    const rpc = chain([
      { n: 1, signer: dev, lamports: 5000 },
      { n: 2, signer: owned, lamports: 5000 },
      { n: 3, signer: sniper, lamports: 1000 },
    ]);
    const result = await observeSniperGuard(
      db,
      'owner',
      REVIEW,
      2,
      rpc,
      signal(),
      () => at(1000),
      readState,
    );
    expect(result.state).toBe('watching');
    expect(result.observation?.evaluation.externalTotalRaw).toBe('1000');
    expect(result.observation?.evaluation.excludedCount).toBe(2);
    expect(result.observation?.cursor).toBe(sig(3));
  });
  it('triggers above the threshold and lists the Nuke wallets with balances, without signing', async () => {
    const { db } = await armed();
    const rpc = chain([
      { n: 1, signer: sniper, lamports: 600 },
      { n: 2, signer: key(12), lamports: 401 },
    ]);
    const result = await observeSniperGuard(
      db,
      'owner',
      REVIEW,
      2,
      rpc,
      signal(),
      () => at(1000),
      readState,
    );
    expect(result.state).toBe('triggered');
    expect(result.finishedAt).not.toBeNull();
    expect(result.observation?.evaluation.triggeringSignature).toBe(sig(2));
    expect(result.observation?.evaluation.actions).toEqual({
      sellWallets: [holder],
      keepWallets: [dev],
      stopRemainingBuys: true,
    });
    expect(result.observation?.balances?.[0]).toMatchObject({
      wallet: holder,
      amountRaw: '777',
    });
    expect(rpc.mock.calls.map(([m]) => m)).not.toContain('sendTransaction');
    await expect(
      observeSniperGuard(
        db,
        'owner',
        REVIEW,
        3,
        rpc,
        signal(),
        () => at(2000),
        readState,
      ),
    ).rejects.toThrow('not watching');
  });
  it('accumulates across polls from the saved cursor', async () => {
    const { db } = await armed();
    const rows = [{ n: 1, signer: sniper, lamports: 700 }];
    const rpc = chain(rows);
    await observeSniperGuard(
      db,
      'owner',
      REVIEW,
      2,
      rpc,
      signal(),
      () => at(500),
      readState,
    );
    rows.push({ n: 2, signer: key(12), lamports: 301 });
    const second = await observeSniperGuard(
      db,
      'owner',
      REVIEW,
      3,
      rpc,
      signal(),
      () => at(900),
      readState,
    );
    expect(second.observation?.evaluation.externalTotalRaw).toBe('1001');
    expect(second.state).toBe('triggered');
  });
  it('ends when the timer runs out without a trigger', async () => {
    const { db } = await armed();
    const result = await observeSniperGuard(
      db,
      'owner',
      REVIEW,
      2,
      chain([]),
      signal(),
      () => at(30_000),
      readState,
    );
    expect(result.state).toBe('ended');
    expect(result.observation?.endReason).toBe('timed');
  });
  it('ends Until complete once the launch is finalized', async () => {
    const ctx = database();
    await saveSniperGuardSettings(
      ctx.db,
      'owner',
      REVIEW,
      settings({ end: { kind: 'until-complete' } }),
      null,
      at(0),
      readLaunch,
    );
    await armSniperGuard(ctx.db, 'owner', REVIEW, 1, at(0), readLaunch);
    const watching = await observeSniperGuard(
      ctx.db,
      'owner',
      REVIEW,
      2,
      chain([]),
      signal(),
      () => at(1000),
      readState,
    );
    expect(watching.state).toBe('watching');
    launchState = 'finalized';
    const ended = await observeSniperGuard(
      ctx.db,
      'owner',
      REVIEW,
      3,
      chain([]),
      signal(),
      () => at(2000),
      readState,
    );
    expect(ended.state).toBe('ended');
    expect(ended.observation?.endReason).toBe('launch-complete');
  });
  it('rejects a stale revision so two tabs cannot both record a poll', async () => {
    const { db } = await armed();
    await observeSniperGuard(
      db,
      'owner',
      REVIEW,
      2,
      chain([]),
      signal(),
      () => at(100),
      readState,
    );
    await expect(
      observeSniperGuard(
        db,
        'owner',
        REVIEW,
        2,
        chain([]),
        signal(),
        () => at(200),
        readState,
      ),
    ).rejects.toThrow('changed elsewhere');
  });
});
