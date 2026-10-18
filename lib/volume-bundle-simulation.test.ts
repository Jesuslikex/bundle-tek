import { expect, it } from 'vitest';
import {
  pumpNow,
  volumePumpFixture,
} from '../test/volume-pump-simulation-fixture';
import {
  simulateVolumePumpBundle,
  type VolumeSimulationRpc,
} from './volume-bundle-simulation';
it('simulates the complete original unsigned packet once through nine read-only calls', async () => {
  const f = await volumePumpFixture();
  const original = structuredClone(f.review);
  const p = await simulateVolumePumpBundle(
    f.review,
    f.route,
    f.rpc,
    new AbortController().signal,
    1000,
    () => pumpNow,
  );
  expect(f.review).toEqual(original);
  expect(p).toMatchObject({
    constructionSha256: f.review.sha256,
    routeSha256: f.route.sha256,
    slotMin: 1000,
    slotMax: 1002,
    buyLamports: '50000000',
    sellLamports: '49900000',
    netLamports: '-107000',
    feeLamports: '5000',
    tipLamports: '2000',
    originalBlockhashRetained: true,
    simulationChecksPassed: true,
    programCodeAdmissionRequired: true,
    trustedTransportRequired: true,
    signingAllowed: false,
    executionAllowed: false,
  });
  expect(f.calls).toHaveLength(9);
  const sims = f.calls.filter((c) => c.method === 'simulateTransaction');
  expect(sims).toHaveLength(1);
  expect(sims[0].params).toEqual([
    f.review.transaction,
    {
      encoding: 'base64',
      commitment: 'confirmed',
      minContextSlot: 1000,
      sigVerify: false,
      replaceRecentBlockhash: false,
      innerInstructions: true,
      accounts: { encoding: 'base64', addresses: f.addresses },
    },
  ]);
  expect(
    f.calls
      .filter((c) => c.method === 'isBlockhashValid')
      .every((c) => c.params[0] === f.input.blockhash),
  ).toBe(true);
  expect(f.calls.every((c) => !c.method.toLowerCase().includes('send'))).toBe(
    true,
  );
});
it.each([
  'network',
  'fee',
  'height',
  'validity',
  'stale',
  'window',
  'replacement',
  'failed',
  'units',
  'missing',
  'inventory',
  'authority',
  'tip',
  'loss',
  'conservation',
  'inner',
  'minimum',
  'final-state',
  'clock',
  'code',
  'config',
  'rent',
  'mint',
  'frozen',
  'account-bytes',
  'future-clock',
  'rpc',
  'late-height',
  'wrong-token-source',
])('withholds proof on %s evidence without retry', async (kind) => {
  const f = await volumePumpFixture();
  let snapshots = 0;
  const rpc: VolumeSimulationRpc = async (method, params, signal) => {
    const raw = await f.rpc(method, params, signal);
    if (kind === 'network' && method === 'getGenesisHash') return 'wrong';
    if (kind === 'rpc' && method === 'getFeeForMessage')
      throw new Error('Fixture transport failure');
    if (
      kind === 'late-height' &&
      method === 'getBlockHeight' &&
      snapshots === 2
    )
      return 469;
    if (kind === 'height' && method === 'getBlockHeight') return 469;
    if (kind === 'fee' && method === 'getFeeForMessage')
      return { context: { slot: 1000 }, value: 5001 };
    if (kind === 'validity' && method === 'isBlockhashValid')
      return { context: { slot: 1000 }, value: false };
    if (method === 'getMultipleAccounts') {
      snapshots++;
      const r = raw as { context: { slot: number }; value: typeof f.before };
      if (kind === 'stale') r.context.slot = 999;
      if (kind === 'clock') {
        const c = r.value[r.value.length - 1];
        c.data[0] = 'AA==';
      }
      if (kind === 'code') r.value[f.index(f.roles.program)].executable = false;
      if (kind === 'config')
        r.value[f.index(f.roles.global)].owner = f.input.mint;
      if (kind === 'rent')
        r.value[f.index(f.input.tokenAccount)].lamports = '1';
      if (kind === 'mint') {
        const a = r.value[f.index(f.input.mint)],
          b = Uint8Array.from(atob(a.data[0]), (c) => c.charCodeAt(0));
        b[46] = 1;
        a.data[0] = btoa(String.fromCharCode(...b));
      }
      if (kind === 'frozen') {
        const a = r.value[f.index(f.input.tokenAccount)],
          b = Uint8Array.from(atob(a.data[0]), (c) => c.charCodeAt(0));
        b[108] = 2;
        a.data[0] = btoa(String.fromCharCode(...b));
      }
      if (kind === 'account-bytes')
        r.value[f.index(f.roles.fee_config)].data[0] = '!!!!';
      if (kind === 'future-clock') {
        const a = r.value[r.value.length - 1],
          b = Uint8Array.from(atob(a.data[0]), (c) => c.charCodeAt(0));
        new DataView(b.buffer).setBigInt64(
          32,
          BigInt(pumpNow / 1000 + 3),
          true,
        );
        a.data[0] = btoa(String.fromCharCode(...b));
      }
      if (kind === 'final-state' && snapshots === 2)
        r.value[0].lamports = '999999999';
    }
    if (method === 'simulateTransaction') {
      const r = raw as typeof f.simulation;
      if (kind === 'window') r.context.slot = 1033;
      if (kind === 'replacement')
        Object.assign(r.value, {
          replacementBlockhash: { blockhash: f.input.blockhash },
        });
      if (kind === 'failed')
        Object.assign(r.value, { err: { InstructionError: [1, 'Custom'] } });
      if (kind === 'units') r.value.unitsConsumed = 1400001;
      if (kind === 'missing') r.value.accounts.pop();
      if (kind === 'inventory' || kind === 'authority') {
        const a = r.value.accounts[f.index(f.input.tokenAccount)];
        const b = Uint8Array.from(atob(a.data[0]), (c) => c.charCodeAt(0));
        b[kind === 'inventory' ? 64 : 72] = 1;
        a.data[0] = btoa(String.fromCharCode(...b));
      }
      if (kind === 'tip')
        r.value.accounts[f.index(f.input.tipRecipient)].lamports = '1000001999';
      if (kind === 'loss') r.value.accounts[0].lamports = '999700000';
      if (kind === 'conservation')
        r.value.accounts[f.index(f.roles.bonding_curve)].lamports =
          '1000100001';
      if (kind === 'inner') r.value.innerInstructions = [];
      if (kind === 'wrong-token-source')
        r.value.innerInstructions[0].instructions[1].accounts[0] = f.index(
          f.input.mint,
        );
      if (kind === 'minimum') {
        r.value.accounts[0].lamports = '998993000';
        r.value.accounts[f.index(f.roles.bonding_curve)].lamports =
          '1001000000';
      }
    }
    return raw;
  };
  await expect(
    simulateVolumePumpBundle(
      f.review,
      f.route,
      rpc,
      new AbortController().signal,
      1000,
      () => pumpNow,
    ),
  ).rejects.toThrow();
  expect(
    f.calls.filter((c) => c.method === 'simulateTransaction').length,
  ).toBeLessThanOrEqual(1);
});
it('stops before transport on cancellation or changed route and never publishes a late response', async () => {
  const f = await volumePumpFixture(),
    abort = new AbortController();
  abort.abort();
  await expect(
    simulateVolumePumpBundle(
      f.review,
      f.route,
      f.rpc,
      abort.signal,
      1000,
      () => pumpNow,
    ),
  ).rejects.toThrow();
  expect(f.calls).toHaveLength(0);
  const changed = structuredClone(f.route);
  changed.schemaSha256 = 'changed';
  await expect(
    simulateVolumePumpBundle(
      f.review,
      changed,
      f.rpc,
      new AbortController().signal,
      1000,
      () => pumpNow,
    ),
  ).rejects.toThrow();
  expect(f.calls).toHaveLength(0);
  const controller = new AbortController();
  let release: (value: unknown) => void = () => {};
  let reached = () => {};
  const pending = new Promise<void>((r) => {
    reached = r;
  });
  const rpc: VolumeSimulationRpc = async (method, params, signal) => {
    if (method === 'simulateTransaction') {
      reached();
      return new Promise((r) => {
        release = r;
      });
    }
    return f.rpc(method, params, signal);
  };
  const result = simulateVolumePumpBundle(
    f.review,
    f.route,
    rpc,
    controller.signal,
    1000,
    () => pumpNow,
  );
  await pending;
  controller.abort();
  await expect(result).rejects.toThrow();
  const count = f.calls.length;
  release(f.simulation);
  await Promise.resolve();
  await Promise.resolve();
  expect(f.calls).toHaveLength(count);
});
