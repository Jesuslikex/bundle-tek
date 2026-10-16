import { afterEach, expect, it } from 'vitest';
import bs58 from 'bs58';
import { address } from '@solana/kit';
import { pairRuntimeFixture } from '../test/pair-runtime-fixture';
import { inspectOwnedImportedPairOrder } from './imported-pair-order-candidate';
import { collectPairRuntimePreview } from './pair-runtime-preview';
let fixture: Awaited<ReturnType<typeof pairRuntimeFixture>> | undefined;
afterEach(() => {
  fixture?.close();
  fixture = undefined;
});

async function run(mode = 'ok', limit: 5 | 100 = 5) {
  const f = (fixture = await pairRuntimeFixture());
  const records: { keys: string[]; floor: number; slot: number }[] = [];
  const target = bs58.encode(new Uint8Array(32).fill(43));
  if (mode === 'custody') {
    const added = [41, 42, 43].map((seed) =>
      bs58.encode(new Uint8Array(32).fill(seed)),
    );
    for (const key of added)
      f.orderState.otherAccounts.set(key, {
        owner: '11111111111111111111111111111111',
        executable: false,
        lamports: '1000000',
        data: ['', 'base64'],
      });
    f.orderState.transform = (m) => {
      m.staticAccounts.splice(3, 0, ...added.map((key) => address(key)));
      m.instructions = m.instructions.map((ix) => ({
        ...ix,
        programAddressIndex:
          ix.programAddressIndex >= 3
            ? ix.programAddressIndex + 3
            : ix.programAddressIndex,
        accountIndices: ix.accountIndices?.map((i) => (i >= 3 ? i + 3 : i)),
      }));
      return m;
    };
  }
  const work = inspectOwnedImportedPairOrder(
    f.db,
    'alice',
    f.orderRequest,
    new AbortController().signal,
    f.runtimeDependencies,
    async (preflight, order, rpc, now) => {
      const inventoryRpc = async (method: string, params: unknown[]) => {
        const result = (await rpc(method, params)) as {
          context?: { slot?: string };
          value?: unknown[];
        };
        const config = params[1] as
          | { minContextSlot: number; dataSlice?: { length: number } }
          | undefined;
        if (
          method === 'getMultipleAccounts' &&
          config?.dataSlice?.length === 166
        ) {
          const keys = params[0] as string[];
          if (mode === 'advance' || mode === 'custody')
            result.context!.slot = String(config.minContextSlot + 1);
          if (mode === 'partial' && records.length === 1) result.value!.pop();
          if (mode === 'stale' && records.length === 1)
            result.context!.slot = String(config.minContextSlot - 1);
          if (mode === 'span' && records.length === 1)
            result.context!.slot = String(preflight.evidence.slot + 33);
          if (
            mode === 'custody' &&
            keys.includes(target) &&
            keys.length === 5
          ) {
            const position = keys.indexOf(target);
            result.value![position] = {
              owner: 'Stake11111111111111111111111111111111111111',
              executable: false,
              lamports: '1000000',
              data: ['', 'base64'],
            };
          }
          records.push({
            keys: [...keys],
            floor: config.minContextSlot,
            slot: Number(result.context!.slot),
          });
        }
        return result;
      };
      return collectPairRuntimePreview(
        { preflight, order },
        inventoryRpc,
        f.runtimeDependencies.programRpc!,
        new AbortController().signal,
        now,
        'strict',
        limit,
      );
    },
  );
  return { f, records, work, target };
}
it('caps both runtime inventories at five while retaining complete final code and simulation evidence', async () => {
  const f = await run();
  const result = await f.work;
  expect(f.records.length).toBeGreaterThanOrEqual(4);
  expect(f.records.every((r) => r.keys.length <= 5)).toBe(true);
  expect(result.review.runtime.codeIdentityObserved).toBe(true);
  expect(result.review.runtime.signingAllowed).toBe(false);
  expect(result.review.review.runtimeTrace).toBeDefined();
  expect(result.review.runtime.programs).toHaveLength(f.f.programs.size);
});
it('records each advancing chunk and uses its own floor without relabeling a common snapshot', async () => {
  const f = await run('advance');
  const result = await f.work;
  expect(f.records.every((r) => r.slot === r.floor + 1)).toBe(true);
  expect(f.records[1].floor).toBeGreaterThanOrEqual(f.records[0].slot);
  expect(result.review.runtime.maximumSlot).toBeGreaterThanOrEqual(
    Math.max(...f.records.map((r) => r.slot)),
  );
});
it.each(['partial', 'stale', 'span'])(
  'refuses a %s inventory chunk',
  async (mode) => {
    const f = await run(mode);
    await expect(f.work).rejects.toThrow();
  },
);
it('reports the real second-chunk slot and position for writable custody refusal', async () => {
  const f = await run('custody');
  let caught: unknown;
  try {
    await f.work;
  } catch (error) {
    caught = error;
  }
  const diagnostics: unknown[] = [];
  for (let i = 0; caught && i < 8; i++) {
    const error = caught as { cause?: unknown; pairDiagnostic?: unknown };
    if (error.pairDiagnostic) diagnostics.push(error.pairDiagnostic);
    caught = error.cause;
  }
  const request = f.records.find(
    (r) => r.keys.includes(f.target) && r.keys.length === 5,
  )!;
  expect(request).toBeDefined();
  expect(diagnostics).toContainEqual(
    expect.objectContaining({
      accountAddress: f.target,
      observationPhase: 'before-inventory',
      contextSlot: request.slot,
      rpcAccountPosition: 0,
      rpcAccountCount: 5,
      compiledAccountIndex: 5,
      packetScopeEvidence: 'available',
    }),
  );
});
