import { expect, it, vi } from 'vitest';
import bs58 from 'bs58';
import { collectPumpProgramIdentities } from './pump-group-code-identity';
import { PUMP_UPGRADEABLE_LOADER } from './pump-launch-group-deployments';
import { SOLANA_MAINNET_GENESIS, WalletRpcError } from './wallet-balances';
import type { PumpLaunchRpc } from './pump-launch-simulation';
import { createPairReadRpc } from './pair-read-rpc';
vi.mock('./wallet-rpc-pacing', () => ({
  paceWalletRpc: vi.fn(async () => {}),
}));

function fixture(mode = 'ok') {
  const programs = Array.from({ length: 6 }, (_, i) =>
    bs58.encode(new Uint8Array(32).fill(20 + i * 2)),
  );
  const raw = new Map<string, { bytes: Uint8Array; executable: boolean }>();
  for (const [i, key] of programs.entries()) {
    const dataKey = bs58.encode(new Uint8Array(32).fill(21 + i * 2));
    const link = new Uint8Array(36),
      full = new Uint8Array(45 + 4096);
    new DataView(link.buffer).setUint32(0, 2, true);
    link.set(bs58.decode(dataKey), 4);
    const view = new DataView(full.buffer);
    view.setUint32(0, 3, true);
    view.setBigUint64(4, 90n, true);
    full[12] = 1;
    full.fill(7, 13, 45);
    full.fill(i + 10, 45);
    full.set([127, 69, 76, 70], 45);
    raw.set(key, { bytes: link, executable: true });
    raw.set(dataKey, { bytes: full, executable: false });
  }
  const calls: { method: string; params: unknown[] }[] = [],
    headerReads = new Map<string, number>();
  let accountReads = 0;
  const rpc: PumpLaunchRpc = async (method, params) => {
    calls.push({ method, params: structuredClone(params) });
    if (method === 'getGenesisHash') return SOLANA_MAINNET_GENESIS;
    if (method !== 'getMultipleAccounts') throw Error('Unexpected method');
    accountReads++;
    if (mode === 'rate-limit' && accountReads === 2)
      throw new WalletRpcError(429);
    const keys = params[0] as string[],
      config = params[1] as {
        minContextSlot: number;
        dataSlice: { offset: number; length: number };
      };
    const slot =
      mode === 'stale' && accountReads === 2
        ? 99
        : mode === 'span' && accountReads === 2
          ? 133
          : mode === 'advancing'
            ? config.minContextSlot + 1
            : 100;
    const value = keys.map((key) => {
      const a = raw.get(key)!;
      let bytes = a.bytes;
      if (
        !a.executable &&
        config.dataSlice.offset === 0 &&
        config.dataSlice.length === 45
      ) {
        const count = (headerReads.get(key) ?? 0) + 1;
        headerReads.set(key, count);
        if (mode === 'authority' && count > 1) {
          bytes = bytes.slice();
          bytes[13] = 9;
        }
      }
      return {
        owner: PUMP_UPGRADEABLE_LOADER,
        executable: a.executable,
        lamports: '1000000',
        space: String(bytes.length),
        data: [
          Buffer.from(
            bytes.slice(
              config.dataSlice.offset,
              config.dataSlice.offset + config.dataSlice.length,
            ),
          ).toString('base64'),
          'base64',
        ],
      };
    });
    if (mode === 'partial' && accountReads === 2) value.pop();
    return { context: { slot: String(slot) }, value };
  };
  return { programs, rpc, calls };
}
const run = (
  f: ReturnType<typeof fixture>,
  parallel: 1 | 4 = 4,
  cap: 5 | 100 = 100,
) =>
  collectPumpProgramIdentities(
    f.programs,
    100,
    new AbortController().signal,
    f.rpc,
    parallel,
    cap,
  );

it('caps every actual header/body/recheck read at five with identical complete program identities', async () => {
  const baseline = fixture(),
    limited = fixture();
  const original = await run(baseline),
    result = await run(limited, 4, 5);
  expect(result.programs).toEqual(original.programs);
  expect(result.totalCodeBytes).toBe(6 * 4096);
  expect(result.totalCodeBytes).toBe(original.totalCodeBytes);
  expect(result.reads).toBe(limited.calls.length);
  const reads = limited.calls.filter((c) => c.method === 'getMultipleAccounts');
  expect(reads.every((c) => (c.params[0] as string[]).length <= 5)).toBe(true);
  expect(
    reads.filter(
      (c) =>
        (c.params[1] as { dataSlice: { length: number } }).dataSlice.length ===
        45,
    ),
  ).toHaveLength(8);
  expect(result.signingAllowed).toBe(false);
});
it('keeps all five-account code scopes within the real transport wire cap', async () => {
  const f = fixture(),
    baseline = await run(fixture());
  const wire: { method: string; params: unknown[] }[] = [];
  const signal = new AbortController().signal;
  const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
    if (typeof init?.body !== 'string') throw Error('Expected JSON');
    const body = JSON.parse(init.body),
      messages = (Array.isArray(body) ? body : [body]) as {
        id: string;
        method: string;
        params: unknown[];
      }[];
    wire.push(...messages);
    const replies = await Promise.all(
      messages.map(async (m) => ({
        jsonrpc: '2.0',
        id: m.id,
        result: await f.rpc(m.method, m.params, signal),
      })),
    );
    return Response.json(Array.isArray(body) ? replies : replies[0]);
  });
  const transport = createPairReadRpc(
    'https://rpc.example.test/',
    signal,
    fetcher as typeof fetch,
    'unsigned-stock-qualification',
    5,
  );
  try {
    const result = await collectPumpProgramIdentities(
      f.programs,
      100,
      signal,
      transport.programRpc,
      4,
      5,
    );
    expect(result.programs).toEqual(baseline.programs);
    expect(result.totalCodeBytes).toBe(baseline.totalCodeBytes);
    expect(
      wire
        .filter((m) => m.method === 'getMultipleAccounts')
        .every((m) => (m.params[0] as string[]).length <= 5),
    ).toBe(true);
  } finally {
    transport.close();
  }
});
it('stops before issuing a second partition when the read lifecycle is cancelled', async () => {
  const f = fixture(),
    controller = new AbortController();
  const rpc: PumpLaunchRpc = async (method, params, signal) => {
    const result = await f.rpc(method, params, signal);
    if (method === 'getMultipleAccounts') controller.abort();
    return result;
  };
  await expect(
    collectPumpProgramIdentities(f.programs, 100, controller.signal, rpc, 4, 5),
  ).rejects.toThrow();
  expect(
    f.calls.filter((c) => c.method === 'getMultipleAccounts'),
  ).toHaveLength(1);
});
it('preserves the default group request trace and identities against explicit100', async () => {
  const a = fixture(),
    b = fixture();
  const original = await collectPumpProgramIdentities(
    a.programs,
    100,
    new AbortController().signal,
    a.rpc,
  );
  const explicit = await run(b, 1, 100);
  expect(a.calls).toEqual(b.calls);
  expect(original.programs).toEqual(explicit.programs);
  expect(original.reads).toBe(explicit.reads);
});
it('refuses the five-account setting on serial group reads before any RPC call', async () => {
  const f = fixture();
  await expect(run(f, 1, 5)).rejects.toThrow('scope');
  expect(f.calls).toHaveLength(0);
});
it('retains each individual response slot and advances subsequent floors', async () => {
  const f = fixture('advancing'),
    result = await run(f, 4, 5);
  const floors = f.calls
    .filter((c) => c.method === 'getMultipleAccounts')
    .map((c) => (c.params[1] as { minContextSlot: number }).minContextSlot);
  expect(floors[0]).toBe(100);
  expect(floors[1]).toBe(101);
  expect(result.maximumSlot).toBe(Math.max(...floors) + 1);
  expect(result.maximumSlot - result.minimumSlot).toBeLessThanOrEqual(32);
});
it.each(['stale', 'span', 'partial', 'authority', 'rate-limit'])(
  'refuses %s without a partial identity result or retry',
  async (mode) => {
    const f = fixture(mode);
    await expect(run(f, 4, 5)).rejects.toThrow();
    if (mode === 'rate-limit')
      expect(
        f.calls.filter((c) => c.method === 'getMultipleAccounts'),
      ).toHaveLength(2);
  },
);
