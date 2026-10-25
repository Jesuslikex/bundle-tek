import { afterEach, beforeEach, expect, it } from 'vitest';
import { createClient, type Client } from '@libsql/client';
import { readFileSync } from 'node:fs';
import { createTursoDatabase } from '../db/turso';
import { newAutoSellStrategy } from './auto-sell';
import type {
  AutoSellProfileTerms,
  SavedAutoSellProfile,
} from './auto-sell-profile';
import {
  AutoSellProfileStorageError,
  listAutoSellProfiles,
  readAutoSellProfile,
  saveAutoSellProfile,
} from './auto-sell-profile-storage';

const projectId = '00000000-0000-4000-8000-000000000001';
const otherProject = '00000000-0000-4000-8000-000000000002';
const profileId = '00000000-0000-4000-8000-000000000003';
const mint = 'So11111111111111111111111111111111111111112';
const wallet = '11111111111111111111111111111111';
const ignored = 'SysvarRent111111111111111111111111111111111';
const uuid = (n: number) =>
  '10000000-0000-4000-8000-' + String(n).padStart(12, '0');
const signal = () => new AbortController().signal;
function terms(): AutoSellProfileTerms {
  return {
    name: 'Saved Auto Sell',
    projectId,
    projectRevision: 1,
    token: { chain: 'Solana', mint, decimals: 9, totalSupplyRaw: '1000000000' },
    wallets: [{ address: wallet, revision: 1 }],
    configuration: {
      strategies: [
        {
          ...newAutoSellStrategy(0),
          id: 'strategy-one',
          replicationPercent: '100',
        },
      ],
      session: {
        startDelaySeconds: 0,
        endDurationSeconds: 60,
        endMaxSupplyPercent: '10',
        maxSlippageBps: 50,
      },
    },
  };
}
let client: Client, db: D1Database;
beforeEach(async () => {
  client = createClient({ url: 'file::memory:' });
  db = createTursoDatabase(client);
  for (const file of [
    '0011_huge_donald_blake.sql',
    '0024_imported_token_projects.sql',
    '0149_auto_sell_profiles.sql',
  ])
    for (const sql of readFileSync('drizzle/' + file, 'utf8')
      .split('--> statement-breakpoint')
      .filter((s) => s.trim()))
      await client.execute(sql);
  await client.execute({
    sql: 'INSERT INTO imported_token_projects(owner_id,id,chain,address,document,revision,archived,mutation_id,updated_at) VALUES(?,?,?,?,?,1,0,?,?)',
    args: [
      'owner',
      projectId,
      'Solana',
      mint,
      JSON.stringify({
        token: {
          chain: 'Solana',
          address: mint,
          decimals: 9,
          totalSupplyRaw: '1000000000',
        },
      }),
      uuid(9000),
      new Date().toISOString(),
    ],
  });
  await client.execute({
    sql: 'INSERT INTO workspace_wallets(owner_id,chain,address,folder_id,label,role,archived,revision,updated_at) VALUES(?,?,?,?,?,?,0,1,?)',
    args: [
      'owner',
      'Solana',
      wallet,
      'folder',
      'Wallet',
      'Holder',
      new Date().toISOString(),
    ],
  });
});
afterEach(() => client.close());
const input = (
  n = 1,
  expectedVersion = 0,
  value = terms(),
  profile = profileId,
) => ({ id: uuid(n), profileId: profile, expectedVersion, terms: value });
const save = (
  n = 1,
  expectedVersion = 0,
  value = terms(),
  profile = profileId,
) =>
  saveAutoSellProfile(
    db,
    'owner',
    input(n, expectedVersion, value, profile),
    signal(),
  );
it('stores an immutable false-authority profile and exactly reads the original owned snapshot', async () => {
  const saved = await save();
  expect(saved).toMatchObject({
    id: uuid(1),
    profileId,
    version: 1,
    signingAllowed: false,
    executionAllowed: false,
    automaticResumeAllowed: false,
  });
  expect(
    await readAutoSellProfile(db, 'owner', projectId, uuid(1), signal()),
  ).toEqual(saved);
  expect(
    await listAutoSellProfiles(db, 'owner', projectId, null, signal()),
  ).toEqual({
    profiles: [
      {
        id: uuid(1),
        profileId,
        version: 1,
        name: terms().name,
        projectRevision: 1,
        createdAt: saved.createdAt,
        sha256: saved.sha256,
        token: terms().token,
        walletCount: 1,
        strategyCount: 1,
      },
    ],
    nextCursor: null,
  });
  await expect(
    client.execute({
      sql: 'UPDATE auto_sell_profiles SET created_at=? WHERE id=?',
      args: [new Date().toISOString(), saved.id],
    }),
  ).rejects.toThrow('Auto Sell profile versions are immutable');
  await expect(
    client.execute({
      sql: 'DELETE FROM auto_sell_profiles WHERE id=?',
      args: [saved.id],
    }),
  ).rejects.toThrow('Auto Sell profile versions are retained');
});
it('recovers the exact save after project and wallets change without creating another version', async () => {
  const request = input(),
    saved = await saveAutoSellProfile(db, 'owner', request, signal());
  await client.execute(
    'UPDATE imported_token_projects SET revision=2,archived=1',
  );
  await client.execute('UPDATE workspace_wallets SET revision=2,archived=1');
  expect(await saveAutoSellProfile(db, 'owner', request, signal())).toEqual(
    saved,
  );
  expect(
    (await client.execute('SELECT COUNT(*) AS n FROM auto_sell_profiles'))
      .rows[0].n,
  ).toBe(1);
  await expect(save(2, 1)).rejects.toMatchObject({ status: 409 });
});
it('returns historical records and pages even after the current sources disappear', async () => {
  const saved = await save();
  await client.execute('DELETE FROM imported_token_projects');
  await client.execute('DELETE FROM workspace_wallets');
  expect(
    await readAutoSellProfile(db, 'owner', projectId, saved.id, signal()),
  ).toEqual(saved);
  expect(
    (await listAutoSellProfiles(db, 'owner', projectId, null, signal()))
      .profiles,
  ).toHaveLength(1);
  await expect(save(2, 1)).rejects.toMatchObject({ status: 404 });
});
it('keeps other owners and projects out of exact lookup, index and cursor scope', async () => {
  const saved = await save();
  await expect(
    readAutoSellProfile(db, 'other', projectId, saved.id, signal()),
  ).rejects.toMatchObject({ status: 404 });
  await expect(
    readAutoSellProfile(db, 'owner', otherProject, saved.id, signal()),
  ).rejects.toMatchObject({ status: 404 });
  expect(
    await listAutoSellProfiles(db, 'other', projectId, null, signal()),
  ).toEqual({ profiles: [], nextCursor: null });
  await expect(
    listAutoSellProfiles(db, 'other', projectId, saved.id, signal()),
  ).rejects.toMatchObject({ status: 404 });
  await expect(
    listAutoSellProfiles(db, 'owner', otherProject, saved.id, signal()),
  ).rejects.toMatchObject({ status: 404 });
});
it('refuses reusing one request ID for changed canonical terms, profile or expected version', async () => {
  await save();
  for (const request of [
    { ...input(), terms: { ...terms(), name: 'Changed' } },
    { ...input(), profileId: uuid(999) },
    { ...input(), expectedVersion: 1 },
  ])
    await expect(
      saveAutoSellProfile(db, 'owner', request, signal()),
    ).rejects.toMatchObject({ status: 409 });
});
it('serializes competing versions while identical concurrent request IDs recover one original', async () => {
  const first = await Promise.all([save(), save()]);
  expect(first[0]).toEqual(first[1]);
  const results = await Promise.allSettled([save(2, 1), save(3, 1)]);
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  const loser = results.find(
    (r) => r.status === 'rejected',
  ) as PromiseRejectedResult;
  expect(loser.reason).toMatchObject({ status: 409 });
  expect(
    (
      await client.execute(
        'SELECT version FROM auto_sell_profiles ORDER BY version',
      )
    ).rows.map((r) => r.version),
  ).toEqual([1, 2]);
});
it.each(['revision', 'archive', 'mint', 'outer-address', 'decimals', 'supply'])(
  'refuses a changed project %s',
  async (field) => {
    if (field === 'revision')
      await client.execute('UPDATE imported_token_projects SET revision=2');
    else if (field === 'archive')
      await client.execute('UPDATE imported_token_projects SET archived=1');
    else if (field === 'outer-address')
      await client.execute({
        sql: 'UPDATE imported_token_projects SET address=?',
        args: [ignored],
      });
    else {
      const token = {
        chain: 'Solana',
        address: field === 'mint' ? ignored : mint,
        decimals: field === 'decimals' ? 8 : 9,
        totalSupplyRaw: field === 'supply' ? '1000000001' : '1000000000',
      };
      await client.execute({
        sql: 'UPDATE imported_token_projects SET document=?',
        args: [JSON.stringify({ token })],
      });
    }
    await expect(save()).rejects.toMatchObject({ status: 409 });
    expect(
      (await client.execute('SELECT COUNT(*) AS n FROM auto_sell_profiles'))
        .rows[0].n,
    ).toBe(0);
  },
);
it.each(['revision', 'archive', 'missing', 'owner'])(
  'refuses a changed wallet %s',
  async (field) => {
    if (field === 'revision')
      await client.execute('UPDATE workspace_wallets SET revision=2');
    else if (field === 'archive')
      await client.execute('UPDATE workspace_wallets SET archived=1');
    else if (field === 'missing')
      await client.execute('DELETE FROM workspace_wallets');
    else await client.execute("UPDATE workspace_wallets SET owner_id='other'");
    await expect(save()).rejects.toMatchObject({ status: 409 });
  },
);
function beforeInsert(
  callback: () => Promise<void>,
  after = false,
): D1Database {
  return new Proxy(db, {
    get(target, key) {
      if (key !== 'prepare') return Reflect.get(target, key);
      return (sql: string) => {
        const statement = target.prepare(sql);
        if (!sql.startsWith('INSERT INTO auto_sell_profiles')) return statement;
        return new Proxy(statement, {
          get(original, key) {
            if (key !== 'bind') {
              const value = Reflect.get(original, key);
              return typeof value === 'function' ? value.bind(original) : value;
            }
            return (...args: unknown[]) => {
              const bound = original.bind(...args);
              return new Proxy(bound, {
                get(bound, key) {
                  if (key === 'run')
                    return async () => {
                      if (!after) await callback();
                      const result = await bound.run();
                      if (after) await callback();
                      return result;
                    };
                  const value = Reflect.get(bound, key);
                  return typeof value === 'function'
                    ? value.bind(bound)
                    : value;
                },
              });
            };
          },
        });
      };
    },
  });
}
it('rechecks the exact captured project document atomically at insertion', async () => {
  const raced = beforeInsert(async () => {
    await client.execute({
      sql: 'UPDATE imported_token_projects SET document=?',
      args: [
        JSON.stringify({
          token: {
            chain: 'Solana',
            address: mint,
            decimals: 9,
            totalSupplyRaw: '1000000000',
          },
          changed: 'same identity, different capture',
        }),
      ],
    });
  });
  await expect(
    saveAutoSellProfile(raced, 'owner', input(), signal()),
  ).rejects.toMatchObject({ status: 409 });
  expect(
    (await client.execute('SELECT COUNT(*) AS n FROM auto_sell_profiles'))
      .rows[0].n,
  ).toBe(0);
});
it('rechecks selected wallet revisions at the insertion boundary', async () => {
  const raced = beforeInsert(async () => {
    await client.execute('UPDATE workspace_wallets SET revision=2');
  });
  await expect(
    saveAutoSellProfile(raced, 'owner', input(), signal()),
  ).rejects.toMatchObject({ status: 409 });
});
it('keeps post-write cancellation recoverable by the exact original ID', async () => {
  const controller = new AbortController();
  const raced = beforeInsert(async () => {
    controller.abort();
  }, true);
  await expect(
    saveAutoSellProfile(raced, 'owner', input(), controller.signal),
  ).rejects.toMatchObject({ status: 499 });
  expect(
    (await readAutoSellProfile(db, 'owner', projectId, uuid(1), signal()))
      .version,
  ).toBe(1);
  expect((await save()).version).toBe(1);
});
it('does not touch storage when already cancelled or invalid', async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(
    saveAutoSellProfile(db, 'owner', input(), controller.signal),
  ).rejects.toMatchObject({ status: 499 });
  await expect(
    readAutoSellProfile(db, 'owner', projectId, uuid(1), controller.signal),
  ).rejects.toMatchObject({ status: 499 });
  for (const request of [
    { ...input(), id: 'bad' },
    { ...input(), expectedVersion: -1 },
    { ...input(), expectedVersion: 1000 },
    { ...input(), extra: true },
    { ...input(), terms: { ...terms(), password: 'forbidden' } },
  ])
    await expect(
      saveAutoSellProfile(
        db,
        'owner',
        request as Parameters<typeof saveAutoSellProfile>[2],
        signal(),
      ),
    ).rejects.toMatchObject({ status: 400 });
});
const seed = (saved: SavedAutoSellProfile) => ({
  sql: 'INSERT INTO auto_sell_profiles(id,owner_id,project_id,project_revision,profile_id,version,document,sha256,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
  args: [
    saved.id,
    'owner',
    projectId,
    saved.terms.projectRevision,
    saved.profileId,
    saved.version,
    JSON.stringify(saved),
    saved.sha256,
    saved.createdAt,
  ],
});
it('paginates metadata in stable descending order without loading complete large configuration bodies', async () => {
  const large = terms();
  large.configuration.strategies = Array.from({ length: 5 }, (_, i) => ({
    ...newAutoSellStrategy(i),
    id: 'strategy-' + i,
    replicationPercent: '100',
    whitelist: Array(1024).fill(ignored),
  }));
  const saved = await save(1, 0, large);
  expect(
    new TextEncoder().encode(JSON.stringify(saved)).byteLength,
  ).toBeGreaterThan(200000);
  await client.batch(
    Array.from({ length: 20 }, (_, i) =>
      seed({ ...saved, id: uuid(i + 2), version: i + 2 }),
    ),
    'write',
  );
  const pages = [];
  let before: string | null = null;
  do {
    const page = await listAutoSellProfiles(
      db,
      'owner',
      projectId,
      before,
      signal(),
    );
    expect(JSON.stringify(page).length).toBeLessThan(20000);
    expect(JSON.stringify(page)).not.toContain('configuration');
    pages.push(...page.profiles);
    before = page.nextCursor;
  } while (before);
  expect(pages).toHaveLength(21);
  expect(new Set(pages.map((p) => p.id)).size).toBe(21);
  expect(pages.map((p) => p.id)).toEqual(
    pages
      .map((p) => p.id)
      .sort()
      .reverse(),
  );
  expect(
    (await readAutoSellProfile(db, 'owner', projectId, saved.id, signal()))
      .terms,
  ).toEqual(saved.terms);
});
it('enforces the 100-profile and 1000-version retained capacity with no replacement/deletion', async () => {
  const saved = await save();
  await client.batch(
    Array.from({ length: 99 }, (_, i) =>
      seed({
        ...saved,
        id: uuid(i + 2),
        profileId: uuid(i + 1000),
        version: 1,
      }),
    ),
    'write',
  );
  await expect(save(2000, 0, terms(), uuid(3000))).rejects.toMatchObject({
    status: 409,
  });
  await client.batch(
    Array.from({ length: 900 }, (_, i) =>
      seed({ ...saved, id: uuid(i + 4000), version: i + 2 }),
    ),
    'write',
  );
  await expect(save(6000, 901)).rejects.toMatchObject({ status: 409 });
  expect(
    (await client.execute('SELECT COUNT(*) AS n FROM auto_sell_profiles'))
      .rows[0].n,
  ).toBe(1000);
  expect(
    (await readAutoSellProfile(db, 'owner', projectId, saved.id, signal()))
      .version,
  ).toBe(1);
});
it('refuses a corrupted canonical digest on exact read instead of returning unverified terms', async () => {
  await save();
  // Corruption fixture only; no production guard is relaxed by storage.
  await client.execute('DROP TRIGGER auto_sell_profiles_immutable');
  await client.execute({
    sql: "UPDATE auto_sell_profiles SET sha256=?,document=json_set(document,'$.sha256',?)",
    args: ['0'.repeat(64), '0'.repeat(64)],
  });
  await expect(
    readAutoSellProfile(db, 'owner', projectId, uuid(1), signal()),
  ).rejects.toMatchObject({ status: 503 });
});

it('independently refuses direct SQL insertion when the project outer address differs', async () => {
  const saved = await save();
  await client.execute({
    sql: 'UPDATE imported_token_projects SET address=?',
    args: [ignored],
  });
  await expect(
    client.execute(seed({ ...saved, id: uuid(2), version: 2 })),
  ).rejects.toThrow('Auto Sell profile project changed');
});
it('independently refuses duplicate wallet tuples in a direct SQL profile insertion', async () => {
  const saved = await save();
  const duplicate = {
    ...saved,
    id: uuid(2),
    version: 2,
    terms: {
      ...saved.terms,
      wallets: [...saved.terms.wallets, ...saved.terms.wallets],
    },
  };
  await expect(client.execute(seed(duplicate))).rejects.toThrow(
    'Auto Sell profile wallets changed',
  );
});
it('uses typed fixed errors for unavailable storage without exposing database diagnostics', async () => {
  const unavailable = new Proxy(db, {
    get(target, key) {
      if (key === 'prepare')
        return () => {
          throw Error('private database endpoint details');
        };
      return Reflect.get(target, key);
    },
  });
  await expect(
    listAutoSellProfiles(unavailable, 'owner', projectId, null, signal()),
  ).rejects.toMatchObject({
    status: 503,
    message: 'Auto Sell profile storage unavailable. No session was started.',
  });
  try {
    await readAutoSellProfile(
      unavailable,
      'owner',
      projectId,
      uuid(1),
      signal(),
    );
    throw Error('Expected failure');
  } catch (error) {
    expect(error).toBeInstanceOf(AutoSellProfileStorageError);
    expect(String(error)).not.toContain('private database');
  }
});
