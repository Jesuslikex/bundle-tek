import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { layerNativeFixture } from '../test/launch-layer-native-fixture';
import { layerTestStorage } from '../test/launch-layer-storage';
import { saveOwnedLaunchLayerPlan } from './launch-layer-service';
import { readOwnedLayerNativeEvidence } from './launch-layer-native-service';
import { layerNativeComparison } from './launch-layer-native-coverage';
let f: Awaited<ReturnType<typeof layerNativeFixture>>,
  storage: Awaited<ReturnType<typeof layerTestStorage>>,
  saved: Awaited<ReturnType<typeof saveOwnedLaunchLayerPlan>>;
beforeEach(async () => {
  f = await layerNativeFixture();
  storage = await layerTestStorage(f.f);
  await storage.client.executeMultiple(
    await readFile('drizzle/0012_messy_zzzax.sql', 'utf8'),
  );
  saved = await saveOwnedLaunchLayerPlan(
    storage.db,
    'alice',
    f.f.input,
    f.f.now,
  );
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw Error(
        'Provider calls are forbidden in this saved-observation test.',
      );
    }),
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  storage.client.close();
});
const read = () =>
  readOwnedLayerNativeEvidence(
    storage.db,
    'alice',
    f.f.selection.projectId,
    saved.id,
    f.f.now,
  );
it('reads only owned selected observations and explicitly preserves missing/invalid records', async () => {
  const address = f.f.address(1),
    valid = f.document(address, '0');
  await storage.client.execute({
    sql: 'INSERT INTO wallet_balance_snapshots VALUES(?,?,?,?,?)',
    args: ['alice', 'Solana', address, JSON.stringify(valid), 123],
  });
  await storage.client.execute({
    sql: 'INSERT INTO wallet_balance_snapshots VALUES(?,?,?,?,?)',
    args: [
      'bob',
      'Solana',
      f.f.address(2),
      JSON.stringify(f.document(f.f.address(2))),
      123,
    ],
  });
  await storage.client.execute({
    sql: 'INSERT INTO wallet_balance_snapshots VALUES(?,?,?,?,?)',
    args: ['alice', 'Solana', f.f.address(3), '<html>', 123],
  });
  const evidence = await read(),
    result = layerNativeComparison(evidence, saved, saved.envelope);
  expect(result.rows[0].observation?.raw).toBe('0');
  expect(result.rows[1].issue).toBe('missing');
  expect(result.rows[2].issue).toBe('invalid');
  expect(result.observedTotalRaw).toBeNull();
  expect(evidence).toMatchObject({
    fundingAllowed: false,
    signingAllowed: false,
    executionAllowed: false,
  });
  expect(fetch).not.toHaveBeenCalled();
  await expect(
    readOwnedLayerNativeEvidence(
      storage.db,
      'bob',
      f.f.selection.projectId,
      saved.id,
      f.f.now,
    ),
  ).rejects.toMatchObject({ status: 404 });
});
it('refuses stale role references and a mutation during the observation read', async () => {
  const prepare = storage.db.prepare.bind(storage.db);
  vi.spyOn(storage.db, 'prepare').mockImplementation((sql) => {
    const statement = prepare(sql);
    if (
      !sql.startsWith(
        'SELECT address,document,block_number FROM wallet_balance_snapshots',
      )
    )
      return statement;
    const bind = statement.bind.bind(statement);
    statement.bind = (...args) => {
      const bound = bind(...args),
        all = bound.all.bind(bound) as typeof bound.all;
      bound.all = async <T = Record<string, unknown>>() => {
        const result = await all<T>();
        await storage.client.execute(
          "UPDATE workspace_wallets SET revision=3 WHERE owner_id='alice'",
        );
        return result;
      };
      return bound;
    };
    return statement;
  });
  await expect(read()).rejects.toMatchObject({
    status: 409,
    message: expect.stringContaining('changed while loading'),
  });
  await expect(read()).rejects.toMatchObject({
    status: 409,
    message: expect.stringContaining('Current project'),
  });
});
