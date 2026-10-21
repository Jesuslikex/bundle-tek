import { afterEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createClient } from '@libsql/client';
import { createTursoDatabase } from '@/db/turso';
import { warmupSessionSettlementStorageFixture } from '@/test/warmup-session-settlement-storage-fixture';
import {
  prepareWalletWarmupSessionAction as prepare,
  readWalletWarmupSessionPreparation as read,
} from './wallet-warmup-session-preparation';
import { retainWalletWarmupSessionSettlement } from './wallet-warmup-session-settlement-storage';
import { isSessionBoundWarmupPreparation } from './warmup-session-preparation-scope';
import { WARMUP_HISTORY_LIMIT } from './warmup-history-capacity';
import { retainWalletWarmupSessionActionBinding } from './wallet-warmup-session-action-binding';
import { validateWalletWarmupSessionPacket } from './wallet-warmup-session-packet';
const mocks = vi.hoisted(() => ({
  db: null as unknown as D1Database,
  user: { userId: 'owner' } as { userId: string } | null,
}));
vi.mock('@/app/chatgpt-auth', () => ({
  getChatGPTUser: async () => mocks.user,
}));
vi.mock('@/db', () => ({ getD1: () => mocks.db }));
vi.mock('@/lib/wallet-rpc-pacing', () => ({ paceWalletRpc: async () => {} }));
import { POST } from '@/app/api/wallet-workspace/warmup/signing/route';
const signal = () => new AbortController().signal,
  clients: { close(): void }[] = [];
afterEach(() => {
  for (const c of clients.splice(0)) c.close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function install(db: D1Database) {
  for (const name of [
    '0128_wallet_warmup_session_preparations',
    '0129_wallet_warmup_session_packets',
    '0130_wallet_warmup_session_packet_freshness',
  ])
    for (const sql of readFileSync(`drizzle/${name}.sql`, 'utf8')
      .split('--> statement-breakpoint')
      .map((s) => s.trim())
      .filter(Boolean))
      await db.prepare(sql).run();
}
it('retains exact unsigned bytes atomically and recovers after expiry without another quote', async () => {
  const f = await fixture(),
    request = input(f);
  const quote = vi.fn(async () => ({
    summary: structuredClone(f.packets.buy.preparation.document),
    transaction: f.packets.buy.approval.transaction,
  }));
  const saved = await prepare(f.db, 'owner', request, signal(), quote, f.clock);
  expect(saved.packet).toEqual({
    transaction: f.packets.buy.approval.transaction,
    sha256: f.packets.buy.preparation.document.transaction.sha256,
  });
  expect(await counts(f.db)).toEqual([1, 1, 3]);
  await f.append('stop');
  f.advance(120000);
  expect(
    await prepare(f.db, 'owner', request, signal(), quote, f.clock),
  ).toEqual(saved);
  expect(quote).toHaveBeenCalledTimes(1);
  expect(await read(f.db, 'other', request.id, signal())).toBeNull();
  for (const sql of [
    "UPDATE wallet_warmup_session_packets SET unsigned_transaction='AAAA'",
    'DELETE FROM wallet_warmup_session_packets',
    'INSERT OR REPLACE INTO wallet_warmup_session_packets SELECT * FROM wallet_warmup_session_packets',
  ])
    await expect(f.db.prepare(sql).run()).rejects.toThrow();
});
it('rolls the preparation and binding back when the packet insert fails', async () => {
  const f = await fixture();
  await f.db
    .prepare(
      "CREATE TRIGGER fixture_packet_refusal BEFORE INSERT ON wallet_warmup_session_packets BEGIN SELECT RAISE(ABORT,'fixture refusal'); END",
    )
    .run();
  await expect(
    prepare(
      f.db,
      'owner',
      input(f),
      signal(),
      async () => ({
        summary: f.packets.buy.preparation.document,
        transaction: f.packets.buy.approval.transaction,
      }),
      f.clock,
    ),
  ).rejects.toThrow('No saved preparation could be confirmed');
  expect(await counts(f.db)).toEqual([0, 0, 2]);
  expect(
    await f.db
      .prepare('SELECT count(*) AS n FROM wallet_warmup_session_packets')
      .first(),
  ).toEqual({ n: 0 });
});
it('recovers the original exact packet after the committed batch loses its response', async () => {
  const f = await fixture(),
    request = input(f);
  const quote = vi.fn(async () => ({
    summary: f.packets.buy.preparation.document,
    transaction: f.packets.buy.approval.transaction,
  }));
  const db = {
    prepare: f.db.prepare.bind(f.db),
    batch: async (statements: Parameters<D1Database['batch']>[0]) => {
      await f.db.batch(statements);
      throw new Error('response lost');
    },
  } as unknown as D1Database;
  const saved = await prepare(db, 'owner', request, signal(), quote, f.clock);
  expect(saved.packet?.transaction).toBe(f.packets.buy.approval.transaction);
  expect(await read(f.db, 'owner', request.id, signal())).toEqual(saved);
  expect(quote).toHaveBeenCalledTimes(1);
});
it.each([
  'signed',
  'wrong-wallet',
  'hash',
  'bytes',
  'instructions',
  'lookups',
  'malformed',
] as const)(
  'refuses %s packet material before saving any session state',
  async (kind) => {
    const f = await fixture(),
      summary = structuredClone(f.packets.buy.preparation.document);
    let transaction = f.packets.buy.approval.transaction;
    if (kind === 'signed') transaction = f.packets.buy.raw.transaction[0];
    if (kind === 'wrong-wallet')
      summary.wallet = '11111111111111111111111111111111';
    if (kind === 'hash') summary.transaction.sha256 = 'a'.repeat(64);
    if (kind === 'bytes') summary.transaction.bytes++;
    if (kind === 'instructions') summary.transaction.instructionCount++;
    if (kind === 'lookups') summary.transaction.lookupTableCount++;
    if (kind === 'malformed') transaction = 'AAAA';
    await expect(
      prepare(
        f.db,
        'owner',
        input(f),
        signal(),
        async () => ({ summary, transaction }),
        f.clock,
      ),
    ).rejects.toThrow();
    expect(await counts(f.db)).toEqual([0, 0, 2]);
  },
);
async function fixture() {
  const f = await warmupSessionSettlementStorageFixture('0.01', {
    reviewOnly: true,
  });
  clients.push(f.client);
  await install(f.db);
  mocks.db = f.db;
  mocks.user = { userId: 'owner' };
  return f;
}
function input(f: Awaited<ReturnType<typeof fixture>>) {
  return {
    id: crypto.randomUUID(),
    journalId: f.journal.id,
    version: f.journal.version,
    headSha256: f.journal.headSha256,
  };
}
function callback(f: Awaited<ReturnType<typeof fixture>>) {
  return vi.fn(async () => structuredClone(f.packets.buy.preparation.document));
}
async function counts(db: D1Database) {
  return Promise.all(
    [
      'wallet_warmup_session_preparations',
      'wallet_warmup_session_action_bindings',
      'warmup_swap_preparations',
    ].map(
      async (table) =>
        (
          await db
            .prepare(`SELECT count(*) AS n FROM ${table}`)
            .first<{ n: number }>()
        )?.n,
    ),
  );
}
async function fillHistory(
  f: Awaited<ReturnType<typeof fixture>>,
  target = WARMUP_HISTORY_LIMIT,
) {
  await f.db
    .prepare(
      "WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<?) INSERT INTO warmup_swap_preparations(id,owner_id,plan_id,plan_revision,cycle,wallet_address,wallet_revision,document,created_at) SELECT 'capacity-'||x,'owner',?,1,1,?,1,'{}',? FROM n",
    )
    .bind(
      target - 2,
      f.plan.id,
      f.packets.wallet,
      new Date(f.clock()).toISOString(),
    )
    .run();
}
function intercept(
  db: D1Database,
  onRun: (run: () => Promise<unknown>) => Promise<unknown>,
) {
  return {
    batch: db.batch.bind(db),
    prepare(sql: string) {
      const original = db.prepare(sql);
      if (!sql.startsWith('INSERT INTO wallet_warmup_session_preparations'))
        return original;
      return {
        bind(...args: unknown[]) {
          const bound = original.bind(...args);
          return { run: () => onRun(() => bound.run()) };
        },
      };
    },
  } as D1Database;
}
it('creates the action-owned preparation and binding in one INSERT and recovers the exact ID without quoting again', async () => {
  const f = await fixture(),
    request = input(f),
    quote = callback(f);
  let writes = 0;
  const db = intercept(f.db, async (run) => {
    writes++;
    return run();
  });
  const saved = await prepare(db, 'owner', request, signal(), quote, f.clock);
  expect(saved).toMatchObject({
    preparation: {
      id: request.id,
      planId: f.plan.id,
      document: { side: 'Buy' },
    },
    executionAllowed: false,
    signingAllowed: false,
    automaticExecutionAllowed: false,
  });
  expect(quote).toHaveBeenCalledWith(
    expect.objectContaining({
      action: expect.objectContaining({
        id: f.journal.snapshot.pending!.action.id,
      }),
      sellSource: null,
    }),
    expect.any(AbortSignal),
  );
  expect(await counts(f.db)).toEqual([1, 1, 3]);
  await f.append('stop');
  f.advance(120000);
  await f.db.prepare('UPDATE wallet_warmup_plans SET archived=1').run();
  expect(await prepare(db, 'owner', request, signal(), quote, f.clock)).toEqual(
    saved,
  );
  expect(quote).toHaveBeenCalledTimes(1);
  expect(writes).toBe(1);
  expect(await read(f.db, 'other', request.id, signal())).toBeNull();
});
it('refuses corrupted packet bytes on saved-only recovery even if its SQL guard was bypassed', async () => {
  const f = await fixture(),
    request = input(f);
  await prepare(
    f.db,
    'owner',
    request,
    signal(),
    async () => ({
      summary: f.packets.buy.preparation.document,
      transaction: f.packets.buy.approval.transaction,
    }),
    f.clock,
  );
  await f.db
    .prepare('DROP TRIGGER wallet_warmup_session_packets_no_update')
    .run();
  await f.db
    .prepare(
      "UPDATE wallet_warmup_session_packets SET unsigned_transaction='AAAA'",
    )
    .run();
  await f.db
    .prepare(
      "CREATE TRIGGER wallet_warmup_session_packets_no_update BEFORE UPDATE ON wallet_warmup_session_packets BEGIN SELECT RAISE(ABORT,'immutable'); END",
    )
    .run();
  await expect(read(f.db, 'owner', request.id, signal())).rejects.toThrow(
    'retained unsigned session packet',
  );
});
it('checks the envelope payer itself, independently of plan validation', async () => {
  const f = await fixture(),
    summary = structuredClone(f.packets.buy.preparation.document);
  summary.wallet = '11111111111111111111111111111111';
  await expect(
    validateWalletWarmupSessionPacket(
      f.packets.buy.approval.transaction,
      summary,
    ),
  ).rejects.toMatchObject({ status: 503 });
});
it('labels a summary-only retry explicitly and never adds bytes to that saved identity', async () => {
  const f = await fixture(),
    request = input(f);
  const saved = await prepare(
    f.db,
    'owner',
    request,
    signal(),
    callback(f),
    f.clock,
  );
  const quote = vi.fn(async () => ({
    summary: f.packets.buy.preparation.document,
    transaction: f.packets.buy.approval.transaction,
  }));
  expect(saved.packetAvailability).toBe('summary-only');
  expect(
    await prepare(f.db, 'owner', request, signal(), quote, f.clock),
  ).toEqual(saved);
  expect(quote).not.toHaveBeenCalled();
  await f.append('stop');
  await expect(
    f.db
      .prepare(
        'INSERT INTO wallet_warmup_session_packets(owner_id,preparation_id,preparation_sha256,unsigned_transaction,packet_sha256,record_sha256) VALUES(?,?,?,?,?,?)',
      )
      .bind(
        'owner',
        request.id,
        saved.identity.record_sha256,
        f.packets.buy.approval.transaction,
        f.packets.buy.preparation.document.transaction.sha256,
        'a'.repeat(64),
      )
      .run(),
  ).rejects.toThrow('context expired or changed');
});
it('refuses recovery from a partially installed packet schema with a stable 503', async () => {
  const f = await fixture(),
    request = input(f);
  await prepare(
    f.db,
    'owner',
    request,
    signal(),
    async () => ({
      summary: f.packets.buy.preparation.document,
      transaction: f.packets.buy.approval.transaction,
    }),
    f.clock,
  );
  await f.db.prepare('DROP TRIGGER wallet_warmup_session_packets_fresh').run();
  await expect(read(f.db, 'owner', request.id, signal())).rejects.toMatchObject(
    { status: 503 },
  );
});
it.each(['same', 'different'] as const)(
  'recovers the first exact bytes when %s IDs race through the native batch path',
  async (kind) => {
    const f = await fixture(),
      request = input(f);
    let calls = 0,
      reached = 0,
      release!: () => void;
    const barrier = new Promise<void>((r) => {
      release = r;
    });
    const quote = vi.fn(async () => {
      const packet = calls++ === 0 ? f.packets.buy : f.packets.sell;
      const summary = structuredClone(f.packets.buy.preparation.document);
      summary.transaction = structuredClone(
        packet.preparation.document.transaction,
      );
      return { summary, transaction: packet.approval.transaction };
    });
    const db = {
      prepare: f.db.prepare.bind(f.db),
      batch: async (statements: Parameters<D1Database['batch']>[0]) => {
        if (++reached === 2) release();
        await barrier;
        return f.db.batch(statements);
      },
    } as unknown as D1Database;
    const results = await Promise.allSettled([
      prepare(db, 'owner', request, signal(), quote, f.clock),
      prepare(
        db,
        'owner',
        kind === 'same' ? request : input(f),
        signal(),
        quote,
        f.clock,
      ),
    ]);
    const winner = results.find((r) => r.status === 'fulfilled');
    expect(winner?.status).toBe('fulfilled');
    if (kind === 'same') {
      expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
      if (
        results[0].status === 'fulfilled' &&
        results[1].status === 'fulfilled'
      )
        expect(results[0].value).toEqual(results[1].value);
    } else {
      const loser = results.find((r) => r.status === 'rejected');
      expect(loser?.status === 'rejected' ? loser.reason : null).toMatchObject({
        status: 409,
        recoveryId:
          winner?.status === 'fulfilled' ? winner.value.preparation.id : null,
      });
    }
    expect(await counts(f.db)).toEqual([1, 1, 3]);
    expect(
      await f.db
        .prepare('SELECT count(*) AS n FROM wallet_warmup_session_packets')
        .first(),
    ).toEqual({ n: 1 });
  },
);
it.each(['stop', 'wallet', 'plan'] as const)(
  'rolls the entire packet batch back after %s drift',
  async (kind) => {
    const f = await fixture();
    const db = {
      prepare: f.db.prepare.bind(f.db),
      batch: async (statements: Parameters<D1Database['batch']>[0]) => {
        if (kind === 'stop') await f.append('stop');
        if (kind === 'wallet')
          await f.db.prepare('UPDATE workspace_wallets SET revision=2').run();
        if (kind === 'plan')
          await f.db.prepare('UPDATE wallet_warmup_plans SET revision=2').run();
        return f.db.batch(statements);
      },
    } as unknown as D1Database;
    await expect(
      prepare(
        db,
        'owner',
        input(f),
        signal(),
        async () => ({
          summary: f.packets.buy.preparation.document,
          transaction: f.packets.buy.approval.transaction,
        }),
        f.clock,
      ),
    ).rejects.toThrow();
    expect(await counts(f.db)).toEqual([0, 0, 2]);
    expect(
      await f.db
        .prepare('SELECT count(*) AS n FROM wallet_warmup_session_packets')
        .first(),
    ).toEqual({ n: 0 });
  },
);
it('withholds material when packet storage guards are missing without retaining a partial preparation', async () => {
  const f = await fixture();
  await f.db.prepare('DROP TRIGGER wallet_warmup_session_packets_insert').run();
  await expect(
    prepare(
      f.db,
      'owner',
      input(f),
      signal(),
      async () => ({
        summary: f.packets.buy.preparation.document,
        transaction: f.packets.buy.approval.transaction,
      }),
      f.clock,
    ),
  ).rejects.toThrow('retained unsigned session packet');
  expect(await counts(f.db)).toEqual([0, 0, 2]);
});
it('refuses a second ID for a bound action before invoking a preparation callback', async () => {
  const f = await fixture(),
    first = input(f),
    quote = callback(f);
  await prepare(f.db, 'owner', first, signal(), quote, f.clock);
  await expect(
    prepare(f.db, 'owner', input(f), signal(), quote, f.clock),
  ).rejects.toMatchObject({ status: 409, recoveryId: first.id });
  expect(quote).toHaveBeenCalledTimes(1);
});
it.each([
  { owner: 'owner' },
  { preparation: { executionAllowed: true } },
  { actionId: 'fake' },
])('rejects caller-provided facts %j', async (extra) => {
  const f = await fixture(),
    quote = callback(f);
  await expect(
    prepare(f.db, 'owner', { ...input(f), ...extra }, signal(), quote, f.clock),
  ).rejects.toThrow();
  expect(quote).not.toHaveBeenCalled();
});
it('never adopts a preparation that already exists', async () => {
  const f = await fixture(),
    quote = callback(f);
  await expect(
    prepare(
      f.db,
      'owner',
      { ...input(f), id: f.packets.buy.preparation.id },
      signal(),
      quote,
      f.clock,
    ),
  ).rejects.toThrow();
  expect(await counts(f.db)).toEqual([0, 0, 2]);
  expect(quote).not.toHaveBeenCalled();
});

it.each(['before', 'write-boundary'])(
  'does not offer a missing owned-record recovery ID for a legacy binding %s',
  async (when) => {
    const f = await fixture(),
      quote = callback(f);
    const bindLegacy = () =>
      retainWalletWarmupSessionActionBinding(
        f.db,
        'owner',
        {
          journalId: f.journal.id,
          version: f.journal.version,
          headSha256: f.journal.headSha256,
          preparationId: f.packets.buy.preparation.id,
        },
        signal(),
        f.clock,
      );
    if (when === 'before') await bindLegacy();
    const db =
      when === 'before'
        ? f.db
        : intercept(f.db, async (run) => {
            await bindLegacy();
            return run();
          });
    await expect(
      prepare(db, 'owner', input(f), signal(), quote, f.clock),
    ).rejects.toMatchObject({
      status: 409,
      recoveryId: undefined,
      message: expect.stringContaining('no action-owned preparation record'),
    });
    expect(quote).toHaveBeenCalledTimes(when === 'before' ? 0 : 1);
    expect(await counts(f.db)).toEqual([0, 1, 2]);
  },
);
it.each(['stop', 'plan', 'wallet', 'binding-guard'])(
  'rolls back both preparation and ownership on insertion-time %s drift',
  async (kind) => {
    const f = await fixture();
    const db = intercept(f.db, async (run) => {
      if (kind === 'stop') await f.append('stop');
      if (kind === 'plan')
        await f.db.prepare('UPDATE wallet_warmup_plans SET revision=2').run();
      if (kind === 'wallet')
        await f.db.prepare('UPDATE workspace_wallets SET revision=2').run();
      if (kind === 'binding-guard')
        await f.db
          .prepare('DROP TRIGGER wallet_warmup_session_action_bindings_fresh')
          .run();
      return run();
    });
    await expect(
      prepare(db, 'owner', input(f), signal(), callback(f), f.clock),
    ).rejects.toThrow();
    expect(await counts(f.db)).toEqual([0, 0, 2]);
  },
);
it('rolls back the preparation itself when its subsequent binding refuses a failed simulation', async () => {
  const f = await fixture(),
    quote = callback(f);
  quote.mockImplementation(async () => ({
    ...structuredClone(f.packets.buy.preparation.document),
    simulation: {
      ...f.packets.buy.preparation.document.simulation,
      succeeded: false,
    },
  }));
  await expect(
    prepare(f.db, 'owner', input(f), signal(), quote, f.clock),
  ).rejects.toThrow();
  expect(await counts(f.db)).toEqual([0, 0, 2]);
});
it('preserves the original preparation capacity with no wrapper or binding left on a zero-row INSERT', async () => {
  const f = await fixture(),
    quote = callback(f);
  const db = intercept(f.db, async (run) => {
    await fillHistory(f);
    return run();
  });
  await expect(
    prepare(db, 'owner', input(f), signal(), quote, f.clock),
  ).rejects.toThrow();
  expect(await counts(f.db)).toEqual([0, 0, WARMUP_HISTORY_LIMIT]);
  expect(quote).toHaveBeenCalledTimes(1);
});
it.each([WARMUP_HISTORY_LIMIT - 1, WARMUP_HISTORY_LIMIT])(
  'preflights history at %i records without wasting a provider request',
  async (target) => {
    const f = await fixture(),
      quote = callback(f);
    await fillHistory(f, target);
    if (target === WARMUP_HISTORY_LIMIT) {
      await expect(
        prepare(f.db, 'owner', input(f), signal(), quote, f.clock),
      ).rejects.toThrow('history is full');
      expect(quote).not.toHaveBeenCalled();
      expect(await counts(f.db)).toEqual([0, 0, target]);
    } else {
      await prepare(f.db, 'owner', input(f), signal(), quote, f.clock);
      expect(quote).toHaveBeenCalledTimes(1);
      expect(await counts(f.db)).toEqual([1, 1, WARMUP_HISTORY_LIMIT]);
    }
  },
);
it.each(['archived', 'revision'])(
  'refuses a stale %s wallet before calling a provider',
  async (kind) => {
    const f = await fixture(),
      quote = callback(f);
    await f.db
      .prepare(
        kind === 'archived'
          ? 'UPDATE workspace_wallets SET archived=1'
          : 'UPDATE workspace_wallets SET revision=2',
      )
      .run();
    await expect(
      prepare(f.db, 'owner', input(f), signal(), quote, f.clock),
    ).rejects.toThrow('plan or wallets changed');
    expect(quote).not.toHaveBeenCalled();
    expect(await counts(f.db)).toEqual([0, 0, 2]);
  },
);
it('gives unconfirmed-write guidance when there is no retained result or conflict to recover', async () => {
  const f = await fixture(),
    quote = callback(f);
  let writes = 0;
  const db = intercept(f.db, async () => {
    writes++;
    throw Error('write unavailable');
  });
  await expect(
    prepare(db, 'owner', input(f), signal(), quote, f.clock),
  ).rejects.toMatchObject({
    message: expect.stringContaining('No saved preparation could be confirmed'),
    recoveryId: undefined,
  });
  expect(writes).toBe(1);
  expect(quote).toHaveBeenCalledTimes(1);
  expect(await counts(f.db)).toEqual([0, 0, 2]);
});
it('recovers a lost write response using the original ID with one callback and one INSERT', async () => {
  const f = await fixture(),
    quote = callback(f);
  let writes = 0;
  const db = intercept(f.db, async (run) => {
    writes++;
    await run();
    throw Error('lost response');
  });
  const saved = await prepare(db, 'owner', input(f), signal(), quote, f.clock);
  expect(saved.executionAllowed).toBe(false);
  expect(writes).toBe(1);
  expect(quote).toHaveBeenCalledTimes(1);
});
it('recovers a same-ID winner that commits between the initial lookup and the occupied-ID precheck', async () => {
  const f = await fixture(),
    request = input(f),
    outerQuote = callback(f),
    winnerQuote = callback(f);
  let winner: Awaited<ReturnType<typeof prepare>> | undefined;
  const db = {
    batch: f.db.batch.bind(f.db),
    prepare(sql: string) {
      const original = f.db.prepare(sql);
      if (
        sql !==
        'SELECT id FROM warmup_swap_preparations WHERE owner_id=? AND id=?'
      )
        return original;
      return {
        bind(...args: unknown[]) {
          const bound = original.bind(...args);
          return {
            first: async () => {
              winner = await prepare(
                f.db,
                'owner',
                request,
                signal(),
                winnerQuote,
                f.clock,
              );
              return bound.first();
            },
          };
        },
      };
    },
  } as D1Database;
  const saved = await prepare(
    db,
    'owner',
    request,
    signal(),
    outerQuote,
    f.clock,
  );
  expect(saved).toEqual(winner);
  expect(outerQuote).not.toHaveBeenCalled();
  expect(winnerQuote).toHaveBeenCalledTimes(1);
  expect(await counts(f.db)).toEqual([1, 1, 3]);
});
it('keeps a committed result recoverable after response cancellation', async () => {
  const f = await fixture(),
    request = input(f),
    controller = new AbortController();
  const db = intercept(f.db, async (run) => {
    await run();
    controller.abort();
    return {};
  });
  await expect(
    prepare(db, 'owner', request, controller.signal, callback(f), f.clock),
  ).rejects.toThrow();
  expect(await read(f.db, 'owner', request.id, signal())).not.toBeNull();
  expect(await counts(f.db)).toEqual([1, 1, 3]);
});
it('does not persist a callback result after cancellation', async () => {
  const f = await fixture(),
    controller = new AbortController();
  await expect(
    prepare(
      f.db,
      'owner',
      input(f),
      controller.signal,
      async () => {
        controller.abort();
        return structuredClone(f.packets.buy.preparation.document);
      },
      f.clock,
    ),
  ).rejects.toThrow();
  expect(await counts(f.db)).toEqual([0, 0, 2]);
});
it.each(['identical', 'changed-quote'])(
  'returns the first retained result for concurrent same-ID requests with %s callbacks',
  async (kind) => {
    const f = await fixture(),
      request = input(f),
      quote = callback(f);
    if (kind === 'changed-quote') {
      let calls = 0;
      quote.mockImplementation(async () => {
        const p = structuredClone(f.packets.buy.preparation.document);
        p.transaction.sha256 = (calls++ === 0 ? 'a' : 'b').repeat(64);
        p.expiresAt = new Date(f.clock() + 30000 + calls * 1000).toISOString();
        return p;
      });
    }
    let reached = 0,
      release!: () => void;
    const barrier = new Promise<void>((r) => {
      release = r;
    });
    const db = intercept(f.db, async (run) => {
      if (++reached === 2) release();
      await barrier;
      return run();
    });
    const results = await Promise.all([
      prepare(db, 'owner', request, signal(), quote, () => f.clock() + 1),
      prepare(db, 'owner', request, signal(), quote, () => f.clock() + 2),
    ]);
    expect(results[0]).toEqual(results[1]);
    expect(await counts(f.db)).toEqual([1, 1, 3]);
    expect(quote).toHaveBeenCalledTimes(2);
    expect(
      await prepare(db, 'owner', request, signal(), quote, f.clock),
    ).toEqual(results[0]);
    expect(quote).toHaveBeenCalledTimes(2);
  },
);
it('admits one of two distinct IDs racing for an action and returns the winner ID for recovery', async () => {
  const f = await fixture(),
    quote = callback(f);
  let reached = 0,
    release!: () => void;
  const barrier = new Promise<void>((r) => {
    release = r;
  });
  const db = intercept(f.db, async (run) => {
    if (++reached === 2) release();
    await barrier;
    return run();
  });
  const results = await Promise.allSettled([
    prepare(db, 'owner', input(f), signal(), quote, f.clock),
    prepare(db, 'owner', input(f), signal(), quote, f.clock),
  ]);
  const winner = results.find((r) => r.status === 'fulfilled');
  expect(winner?.status).toBe('fulfilled');
  const loser = results.find((r) => r.status === 'rejected');
  expect(loser?.status === 'rejected' ? loser.reason : null).toMatchObject({
    status: 409,
    recoveryId:
      winner?.status === 'fulfilled' ? winner.value.preparation.id : null,
  });
  expect(await counts(f.db)).toEqual([1, 1, 3]);
});
it('protects the preparation, its owner record and replacement paths from mutation', async () => {
  const f = await fixture(),
    saved = await prepare(
      f.db,
      'owner',
      input(f),
      signal(),
      callback(f),
      f.clock,
    );
  for (const sql of [
    "UPDATE wallet_warmup_session_preparations SET action_id='changed'",
    'DELETE FROM wallet_warmup_session_preparations',
    'INSERT OR REPLACE INTO wallet_warmup_session_preparations SELECT * FROM wallet_warmup_session_preparations',
    `UPDATE warmup_swap_preparations SET document='{}' WHERE id='${saved.preparation.id}'`,
    `DELETE FROM warmup_swap_preparations WHERE id='${saved.preparation.id}'`,
    `INSERT OR REPLACE INTO warmup_swap_preparations SELECT * FROM warmup_swap_preparations WHERE id='${saved.preparation.id}'`,
  ])
    await expect(f.db.prepare(sql).run()).rejects.toThrow();
  expect(await read(f.db, 'owner', saved.preparation.id, signal())).toEqual(
    saved,
  );
});
it('blocks new signing intents for session-bound preparations directly in SQL', async () => {
  const f = await fixture(),
    saved = await prepare(
      f.db,
      'owner',
      input(f),
      signal(),
      callback(f),
      f.clock,
    );
  await expect(
    f.db
      .prepare(
        "INSERT INTO warmup_signing_intents(id,owner_id,preparation_id,wallet_address,document,state,created_at,updated_at) VALUES(?,?,?,?,?,'awaiting_signature',?,?)",
      )
      .bind(
        crypto.randomUUID(),
        'owner',
        saved.preparation.id,
        f.packets.wallet,
        '{}',
        new Date(f.clock()).toISOString(),
        new Date(f.clock()).toISOString(),
      )
      .run(),
  ).rejects.toThrow('Session-bound signing is not enabled');
});
it('the actual manual review API refuses session preparations before parsing packets or making a provider call', async () => {
  const f = await fixture(),
    saved = await prepare(
      f.db,
      'owner',
      input(f),
      signal(),
      callback(f),
      f.clock,
    ),
    fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  const response = await POST(
    new Request('http://localhost/api/wallet-workspace/warmup/signing', {
      method: 'POST',
      headers: {
        origin: 'http://localhost',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        action: 'review',
        preparationId: saved.preparation.id,
        transaction: 'not a transaction',
      }),
    }),
  );
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({
    error: 'Session-bound signing is not enabled',
  });
  expect(fetcher).not.toHaveBeenCalled();
});
it('leaves legacy schemas and other owners outside the manual-route session gate', async () => {
  const client = createClient({ url: 'file::memory:' });
  clients.push(client);
  const db = createTursoDatabase(client);
  expect(
    await isSessionBoundWarmupPreparation(db, 'owner', crypto.randomUUID()),
  ).toBe(false);
  const f = await fixture(),
    saved = await prepare(
      f.db,
      'owner',
      input(f),
      signal(),
      callback(f),
      f.clock,
    );
  expect(
    await isSessionBoundWarmupPreparation(f.db, 'other', saved.preparation.id),
  ).toBe(false);
  expect(
    await isSessionBoundWarmupPreparation(f.db, 'owner', saved.preparation.id),
  ).toBe(true);
});

it.each(['register', 'submit'])(
  'the manual %s API refuses a legacy session-owned intent before any signature/provider work',
  async (action) => {
    const f = await fixture(),
      saved = await prepare(
        f.db,
        'owner',
        input(f),
        signal(),
        callback(f),
        f.clock,
      ),
      intentId = crypto.randomUUID();
    // Model only a legacy stored intent; normal insertion is blocked above.
    await f.db
      .prepare('DROP TRIGGER warmup_session_bound_intents_disabled')
      .run();
    await f.db
      .prepare(
        'ALTER TABLE warmup_signing_intents ADD COLUMN failure_receipt TEXT',
      )
      .run();
    await f.db
      .prepare(
        "INSERT INTO warmup_signing_intents(id,owner_id,preparation_id,wallet_address,document,state,created_at,updated_at) VALUES(?,?,?,?,?,'awaiting_signature',?,?)",
      )
      .bind(
        intentId,
        'owner',
        saved.preparation.id,
        f.packets.wallet,
        '{}',
        new Date(f.clock()).toISOString(),
        new Date(f.clock()).toISOString(),
      )
      .run();
    await f.db
      .prepare(
        readFileSync(
          'drizzle/0128_wallet_warmup_session_preparations.sql',
          'utf8',
        )
          .split('--> statement-breakpoint')
          .map((s) => s.trim())
          .find((s) =>
            s.startsWith(
              'CREATE TRIGGER warmup_session_bound_intents_disabled',
            ),
          )!,
      )
      .run();
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    const response = await POST(
      new Request('http://localhost/api/wallet-workspace/warmup/signing', {
        method: 'POST',
        headers: {
          origin: 'http://localhost',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          action,
          id: intentId,
          transaction: 'not a transaction',
        }),
      }),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: 'Session-bound signing is not enabled',
    });
    expect(fetcher).not.toHaveBeenCalled();
  },
);
it('derives a Sell preparation from its retained finalized session Buy', async () => {
  const f = await warmupSessionSettlementStorageFixture();
  clients.push(f.client);
  const buy = await retainWalletWarmupSessionSettlement(
    f.db,
    'owner',
    f.request(),
    signal(),
    f.fetcher,
    f.clock,
  );
  f.setJournal(buy.journal);
  f.advance(15000);
  const action = JSON.parse(buy.journal.sourceDocument).review.actions[1].id;
  const journal = await f.append('begin-review', action);
  await install(f.db);
  const quote = vi.fn(async () =>
    structuredClone(f.packets.sell.preparation.document),
  );
  const saved = await prepare(
    f.db,
    'owner',
    {
      id: crypto.randomUUID(),
      journalId: journal.id,
      version: journal.version,
      headSha256: journal.headSha256,
    },
    signal(),
    quote,
    f.clock,
  );
  expect(quote).toHaveBeenCalledWith(
    expect.objectContaining({
      sellSource: {
        buyReceiptId: f.packets.buy.receiptId,
        remainingRaw: '101',
        decimals: 6,
      },
    }),
    expect.any(AbortSignal),
  );
  expect(saved.preparation.document.side).toBe('Sell');
});
