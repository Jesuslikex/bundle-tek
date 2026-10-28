import { expect, it } from 'vitest';
import bs58 from 'bs58';
import { collectPumpProgramIdentities } from './pump-group-code-identity';
import { PUMP_UPGRADEABLE_LOADER } from './pump-launch-group-deployments';
import { SOLANA_MAINNET_GENESIS, WalletRpcError } from './wallet-balances';
import type { PumpLaunchRpc } from './pump-launch-simulation';

function fixture(size = 1400 * 1024, declared = true) {
  const legacy = bs58.encode(new Uint8Array(32).fill(51)),
    upgraded = bs58.encode(new Uint8Array(32).fill(52)),
    dataKey = bs58.encode(new Uint8Array(32).fill(53));
  const code = (length: number, seed: number) => {
    const bytes = Uint8Array.from({ length }, (_, i) => (i + seed) % 256);
    bytes.set([127, 69, 76, 70]);
    return bytes;
  };
  const legacyCode = code(128 * 1024, 17),
    upgradeCode = code(size, 43);
  const link = new Uint8Array(36),
    full = new Uint8Array(size + 45);
  new DataView(link.buffer).setUint32(0, 2, true);
  link.set(bs58.decode(dataKey), 4);
  const view = new DataView(full.buffer);
  view.setUint32(0, 3, true);
  view.setBigUint64(4, 90n, true);
  full[12] = 1;
  full.fill(54, 13, 45);
  full.set(upgradeCode, 45);
  const calls: {
    keys: string[];
    offset: number;
    length: number;
    rawBytes: number;
  }[] = [];
  const rpc: PumpLaunchRpc = async (method, params) => {
    if (method === 'getGenesisHash') return SOLANA_MAINNET_GENESIS;
    if (method !== 'getMultipleAccounts') throw Error('Unexpected RPC');
    const keys = params[0] as string[],
      config = params[1] as { dataSlice: { offset: number; length: number } };
    let rawBytes = 0;
    const value = keys.map((key) => {
      const bytes =
        key === legacy ? legacyCode : key === upgraded ? link : full;
      const part = bytes.slice(
        config.dataSlice.offset,
        config.dataSlice.offset + config.dataSlice.length,
      );
      rawBytes += part.length;
      return {
        owner:
          key === legacy
            ? 'BPFLoader2111111111111111111111111111111111'
            : PUMP_UPGRADEABLE_LOADER,
        executable: key !== dataKey,
        lamports: '1000000',
        ...(declared ? { space: String(bytes.length) } : {}),
        data: [Buffer.from(part).toString('base64'), 'base64'],
      };
    });
    calls.push({ keys, ...config.dataSlice, rawBytes });
    return { context: { slot: '100' }, value };
  };
  return {
    legacy,
    upgraded,
    dataKey,
    legacyCode,
    upgradeCode,
    calls,
    rpc,
    run: (profile: 1 | 4 = 1, source = rpc) =>
      collectPumpProgramIdentities(
        [legacy, upgraded],
        100,
        new AbortController().signal,
        source,
        profile,
      ),
  };
}
it('packs mixed-loader bytes into fewer code calls with identical complete identities and byte limits', async () => {
  const f = fixture(),
    serial = await f.run();
  const serialSlices = f.calls.filter((c) => c.length > 45);
  expect(serialSlices.map((c) => c.offset)).toEqual([0, 45, 737325]);
  f.calls.length = 0;
  const packed = await f.run(4),
    packedSlices = f.calls.filter((c) => c.length > 45);
  expect(packedSlices).toHaveLength(2);
  expect(packedSlices[0].keys).toEqual([f.legacy, f.dataKey]);
  expect(packedSlices.map((c) => c.offset)).toEqual([0, 737280]);
  expect(packed.programs).toEqual(serial.programs);
  expect(packed.totalCodeBytes).toBe(serial.totalCodeBytes);
  for (const [i, bytes] of [f.legacyCode, f.upgradeCode].entries())
    expect(packed.programs[i].codeSha256).toBe(
      Buffer.from(await crypto.subtle.digest('SHA-256', bytes)).toString('hex'),
    );
  for (const call of packedSlices) {
    expect(call.length).toBeLessThanOrEqual(720 * 1024);
    expect(call.rawBytes).toBeLessThanOrEqual(1024 * 1024);
  }
});
it('retains the old loader-separated path when declared lengths are unavailable', async () => {
  const f = fixture(300000, false);
  await f.run(4);
  expect(f.calls.filter((c) => c.length > 45).map((c) => c.offset)).toEqual([
    0, 45,
  ]);
  expect(f.calls.every((c) => c.length === 45 || c.keys.length === 1)).toBe(
    true,
  );
});
it.each(['header', 'truncated', 'floor'] as const)(
  'refuses a changed mixed %s response without reusing bytes',
  async (mode) => {
    const f = fixture();
    const rpc: PumpLaunchRpc = async (method, params, signal) => {
      const response = (await f.rpc(method, params, signal)) as {
        context?: { slot: string };
        value?: { data: string[] }[];
      };
      const config = params[1] as
        | { dataSlice?: { offset: number; length: number } }
        | undefined;
      if (config?.dataSlice?.offset === 0 && config.dataSlice.length > 45) {
        const account =
          response.value![(params[0] as string[]).indexOf(f.dataKey)];
        const bytes = Buffer.from(account.data[0], 'base64');
        if (mode === 'header') bytes[13] ^= 1;
        if (mode === 'floor') response.context!.slot = '133';
        account.data[0] = (
          mode === 'truncated' ? bytes.subarray(1) : bytes
        ).toString('base64');
      }
      return response;
    };
    await expect(f.run(4, rpc)).rejects.toThrow(
      mode === 'header'
        ? 'header changed'
        : mode === 'truncated'
          ? 'Truncated'
          : 'outside the 32-slot span',
    );
  },
);
it('stops after the first bounded batch when mixed reads are rate limited', async () => {
  const f = fixture(3 * 1024 * 1024),
    error = new WalletRpcError(429);
  let reads = 0;
  const rpc: PumpLaunchRpc = async (method, params, signal) => {
    const config = params[1] as { dataSlice?: { length: number } } | undefined;
    if ((config?.dataSlice?.length ?? 0) > 45) {
      reads++;
      throw error;
    }
    return f.rpc(method, params, signal);
  };
  await expect(f.run(4, rpc)).rejects.toBe(error);
  expect(reads).toBe(4);
});

it.each(['complete', 'cancel'] as const)(
  'keeps mixed batches at four and preserves ordered bytes with reversed completion: %s',
  async (mode) => {
    const f = fixture(3 * 1024 * 1024),
      abort = new AbortController();
    const releases: (() => void)[] = [];
    let ready = () => {},
      active = 0,
      maximum = 0,
      codeCalls = 0;
    const started = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const rpc: PumpLaunchRpc = async (method, params, signal) => {
      const config = params[1] as
        | { dataSlice?: { length: number } }
        | undefined;
      if ((config?.dataSlice?.length ?? 0) > 45) {
        const ordinal = codeCalls++;
        active++;
        maximum = Math.max(maximum, active);
        if (ordinal < 4)
          await new Promise<void>((resolve) => {
            releases.push(resolve);
            if (releases.length === 4) ready();
          });
        active--;
      }
      return f.rpc(method, params, signal);
    };
    const pending = collectPumpProgramIdentities(
      [f.legacy, f.upgraded],
      100,
      abort.signal,
      rpc,
      4,
    );
    const failure =
      mode === 'cancel'
        ? expect(pending).rejects.toThrow(/cancelled|timed out/)
        : null;
    await started;
    if (mode === 'cancel') abort.abort();
    for (const index of [3, 1, 2, 0]) releases[index]();
    if (failure) {
      await failure;
      expect(codeCalls).toBe(4);
    } else {
      const report = await pending;
      expect(report.programs[1].codeSha256).toBe(
        Buffer.from(
          await crypto.subtle.digest('SHA-256', f.upgradeCode),
        ).toString('hex'),
      );
      expect(codeCalls).toBe(5);
    }
    expect(maximum).toBe(4);
  },
);
