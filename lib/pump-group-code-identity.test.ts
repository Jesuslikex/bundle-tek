import { expect, it } from 'vitest';
import bs58 from 'bs58';
import {
  collectPumpProgramIdentities,
  matchesPumpProgramPolicy,
} from './pump-group-code-identity';
import { PUMP_UPGRADEABLE_LOADER } from './pump-launch-group-deployments';
import { SOLANA_MAINNET_GENESIS, WalletRpcError } from './wallet-balances';
import type { PumpLaunchRpc } from './pump-launch-simulation';
const program = bs58.encode(new Uint8Array(32).fill(2)),
  dataKey = bs58.encode(new Uint8Array(32).fill(3)),
  system = '11111111111111111111111111111111';
function mixedLoaderFixture(kind = 'ok', declared = true) {
  const legacy = bs58.encode(new Uint8Array(32).fill(50)),
    token = bs58.encode(new Uint8Array(32).fill(52)),
    tokenData = bs58.encode(new Uint8Array(32).fill(53));
  const raw = new Map<
    string,
    { owner: string; executable: boolean; bytes: Uint8Array }
  >();
  for (const [key, link, size] of [
    [program, dataKey, 793824],
    [legacy, null, 105032],
    [token, tokenData, 108600],
  ] as const) {
    const code = new Uint8Array(size);
    for (let i = 0; i < size; i++) code[i] = i % 256;
    code.set([127, 69, 76, 70]);
    if (link) {
      const pointer = new Uint8Array(36);
      new DataView(pointer.buffer).setUint32(0, 2, true);
      pointer.set(bs58.decode(link), 4);
      const data = new Uint8Array(size + 45),
        view = new DataView(data.buffer);
      view.setUint32(0, 3, true);
      view.setBigUint64(4, 90n, true);
      data[12] = 1;
      data.fill(4, 13, 45);
      data.set(code, 45);
      raw.set(key, {
        owner: PUMP_UPGRADEABLE_LOADER,
        executable: true,
        bytes: pointer,
      });
      raw.set(link, {
        owner: PUMP_UPGRADEABLE_LOADER,
        executable: false,
        bytes: data,
      });
    } else
      raw.set(key, {
        owner: 'BPFLoader2111111111111111111111111111111111',
        executable: true,
        bytes: code,
      });
  }
  raw.set(system, {
    owner: 'NativeLoader1111111111111111111111111111111',
    executable: true,
    bytes: Buffer.from('system_program'),
  });
  const slices: { keys: string[]; offset: number; length: number }[] = [];
  let active = 0,
    maximum = 0,
    slot = 100,
    codeReads = 0;
  const rpc: PumpLaunchRpc = async (method, params, signal) => {
    signal.throwIfAborted();
    if (method === 'getGenesisHash') return SOLANA_MAINNET_GENESIS;
    if (method !== 'getMultipleAccounts') throw Error('Unexpected method');
    const keys = params[0] as string[],
      cfg = params[1] as {
        minContextSlot: number;
        dataSlice: { offset: number; length: number };
      },
      slice = cfg.dataSlice;
    const isCode = slice.length > 45;
    // Header rechecks intentionally overlap; each code slice remains serial
    // and must use the latest completed response's floor.
    if (
      (isCode && cfg.minContextSlot !== slot) ||
      cfg.minContextSlot > slot ||
      cfg.minContextSlot < 100
    )
      throw Error('Floor did not advance');
    if (isCode) {
      codeReads++;
      active++;
      maximum = Math.max(maximum, active);
      slices.push({ keys: [...keys], ...slice });
      await Promise.resolve();
    }
    if (isCode && kind === 'rate-limit') {
      active--;
      throw new WalletRpcError(429);
    }
    const value = keys.map((key) => {
      const a = raw.get(key)!;
      let bytes = a.bytes.slice(slice.offset, slice.offset + slice.length);
      if (isCode && key === dataKey && kind === 'header') bytes[13] ^= 1;
      if (isCode && key === dataKey && kind === 'truncate')
        bytes = bytes.slice(1);
      return {
        owner: isCode && key === legacy && kind === 'owner' ? system : a.owner,
        executable: a.executable,
        lamports: '1000000',
        ...(declared ? { space: String(a.bytes.length) } : {}),
        data: [Buffer.from(bytes).toString('base64'), 'base64'],
      };
    });
    if (isCode) {
      active--;
      expect(slice.length).toBeLessThanOrEqual(720 * 1024);
      expect(keys.length * slice.length).toBeLessThanOrEqual(1048576);
    }
    slot++;
    return {
      context: { slot: String(kind === 'drift' && isCode ? slot - 2 : slot) },
      value,
    };
  };
  return {
    rpc,
    programs: [program, legacy, token, system],
    slices,
    stats: () => ({ maximum, codeReads }),
  };
}
it('packs mixed loaders only for explicit serial CPMM research with identical full identities and advancing floors', async () => {
  const ordinary = mixedLoaderFixture(),
    packed = mixedLoaderFixture();
  const a = await collectPumpProgramIdentities(
    ordinary.programs,
    100,
    new AbortController().signal,
    ordinary.rpc,
  );
  const b = await collectPumpProgramIdentities(
    packed.programs,
    100,
    new AbortController().signal,
    packed.rpc,
    1,
    100,
    'serial-cpmm-research',
  );
  expect(b.programs).toEqual(a.programs);
  expect(b.totalCodeBytes).toBe(a.totalCodeBytes);
  expect(ordinary.stats()).toEqual({ maximum: 1, codeReads: 3 });
  expect(packed.stats()).toEqual({ maximum: 1, codeReads: 2 });
  expect(ordinary.slices.map((s) => [s.offset, s.keys.length])).toEqual([
    [0, 1],
    [45, 2],
    [524333, 1],
  ]);
  expect(packed.slices.map((s) => [s.offset, s.keys.length])).toEqual([
    [0, 3],
    [348160, 1],
  ]);
});
it.each(['header', 'truncate', 'owner', 'drift', 'rate-limit'])(
  'serial mixed-loader packing refuses %s without a fallback',
  async (kind) => {
    const f = mixedLoaderFixture(kind);
    await expect(
      collectPumpProgramIdentities(
        f.programs,
        100,
        new AbortController().signal,
        f.rpc,
        1,
        100,
        'serial-cpmm-research',
      ),
    ).rejects.toThrow();
    expect(f.stats().maximum).toBe(1);
    if (kind === 'rate-limit') expect(f.stats().codeReads).toBe(1);
  },
);
it('preserves the unknown-size serial schedule even when mixed-loader research is requested', async () => {
  const a = mixedLoaderFixture('ok', false),
    b = mixedLoaderFixture('ok', false);
  const ordinary = await collectPumpProgramIdentities(
    a.programs,
    100,
    new AbortController().signal,
    a.rpc,
  );
  const packed = await collectPumpProgramIdentities(
    b.programs,
    100,
    new AbortController().signal,
    b.rpc,
    1,
    100,
    'serial-cpmm-research',
  );
  expect(packed.programs).toEqual(ordinary.programs);
  expect(b.slices).toEqual(a.slices);
  expect(b.stats().maximum).toBe(1);
});
it.each([
  [4, 100, 'serial-cpmm-research'],
  [1, 5, 'serial-cpmm-research'],
  [1, 100, 'unrecognized'],
])(
  'rejects incompatible research packing %s/%s/%s before any RPC',
  async (concurrency, cap, packing) => {
    const f = mixedLoaderFixture();
    await expect(
      collectPumpProgramIdentities(
        f.programs,
        100,
        new AbortController().signal,
        f.rpc,
        concurrency as 1 | 4,
        cap as 5 | 100,
        packing as 'serial-cpmm-research',
      ),
    ).rejects.toThrow();
    expect(f.slices).toHaveLength(0);
  },
);
function fixture(kind = 'ok', space = true, size = 300000) {
  let headerReads = 0;
  const calls: string[] = [];
  const code = new Uint8Array(size);
  code.set([127, 69, 76, 70]);
  if (kind === 'binary')
    for (let i = 4; i < code.length; i++) code[i] = i % 256;
  const link = new Uint8Array(36);
  new DataView(link.buffer).setUint32(0, 2, true);
  link.set(new Uint8Array(32).fill(3), 4);
  const full = new Uint8Array(45 + code.length);
  const view = new DataView(full.buffer);
  view.setUint32(0, 3, true);
  view.setBigUint64(4, 90n, true);
  full[12] = 1;
  full.fill(4, 13, 45);
  full.set(code, 45);
  const rpc: PumpLaunchRpc = async (method, params) => {
    calls.push(method);
    if (method === 'getGenesisHash') return SOLANA_MAINNET_GENESIS;
    if (method !== 'getMultipleAccounts')
      throw new Error('No other RPC methods');
    const keys = params[0] as string[],
      config = params[1] as { dataSlice: { offset: number; length: number } };
    const slice = config.dataSlice;
    if (keys.includes(dataKey) && slice.offset === 0) headerReads++;
    return {
      context: { slot: kind === 'drift' ? '133' : '100' },
      value: keys.map((key) => {
        let bytes =
          key === program
            ? link
            : key === system
              ? Buffer.from('system_program')
              : full;
        if (kind === 'authority' && key === dataKey && headerReads > 1) {
          bytes = bytes.slice();
          bytes[13] = 9;
        }
        if (kind === 'not-elf' && key === dataKey) {
          bytes = bytes.slice();
          bytes[45] = 0;
        }
        return {
          owner:
            key === system
              ? 'NativeLoader1111111111111111111111111111111'
              : PUMP_UPGRADEABLE_LOADER,
          executable: key !== dataKey,
          lamports: '1000000',
          ...(space
            ? {
                space: String(
                  bytes.length +
                    (kind === 'truncated' && key === dataKey ? 1 : 0),
                ),
              }
            : {}),
          data: [
            Buffer.from(
              bytes.slice(slice.offset, slice.offset + slice.length),
            ).toString('base64'),
            'base64',
          ],
        };
      }),
    };
  };
  return { rpc, calls, code };
}
it('retains all binary bytes and hashes in the pair-only fast decoder with the serial default unchanged', async () => {
  const f = fixture('binary', true, 740000);
  const serial = await collectPumpProgramIdentities(
    [program, system],
    100,
    new AbortController().signal,
    f.rpc,
  );
  const fast = await collectPumpProgramIdentities(
    [program, system],
    100,
    new AbortController().signal,
    f.rpc,
    4,
  );
  expect(fast.programs).toEqual(serial.programs);
  expect(fast.programs[0].codeSha256).toBe(
    Buffer.from(await crypto.subtle.digest('SHA-256', f.code)).toString('hex'),
  );
});
it.each(['newline', 'invalid-symbol', 'extra-padding'] as const)(
  'still rejects noncanonical %s base64 before the fast decoder',
  async (mode) => {
    const f = fixture();
    const rpc: PumpLaunchRpc = async (method, params, signal) => {
      const result = (await f.rpc(method, params, signal)) as {
        value?: { data: string[] }[];
      };
      const slice = (
        params[1] as { dataSlice?: { length: number } } | undefined
      )?.dataSlice;
      if (method === 'getMultipleAccounts' && slice && slice.length > 45)
        for (const a of result.value ?? [])
          a.data[0] +=
            mode === 'newline' ? '\n' : mode === 'invalid-symbol' ? '!' : '=';
      return result;
    };
    await expect(
      collectPumpProgramIdentities(
        [program],
        100,
        new AbortController().signal,
        rpc,
        4,
      ),
    ).rejects.toThrow();
  },
);
it.each([4096, 100 * 1024])(
  'packs unequal declared code sizes with fewer calls and the same complete hashes, short size=%i',
  async (shortSize) => {
    const sizes = [
      3 * 1024 * 1024,
      ...Array.from({ length: 7 }, () => shortSize),
    ];
    const programs = sizes.map((_s, i) =>
      bs58.encode(new Uint8Array(32).fill(10 + i * 2)),
    );
    const code = sizes.map((size, i) => {
      const bytes = new Uint8Array(size).fill(i + 20);
      bytes.set([127, 69, 76, 70]);
      return bytes;
    });
    const raw = new Map<string, { bytes: Uint8Array; executable: boolean }>();
    for (const [i, key] of programs.entries()) {
      const dataKey = bs58.encode(new Uint8Array(32).fill(11 + i * 2)),
        link = new Uint8Array(36),
        data = new Uint8Array(45 + sizes[i]);
      new DataView(link.buffer).setUint32(0, 2, true);
      link.set(bs58.decode(dataKey), 4);
      const view = new DataView(data.buffer);
      view.setUint32(0, 3, true);
      view.setBigUint64(4, 90n, true);
      data[12] = 1;
      data.fill(4, 13, 45);
      data.set(code[i], 45);
      raw.set(key, { bytes: link, executable: true });
      raw.set(dataKey, { bytes: data, executable: false });
    }
    const run = async (parallel: 1 | 4) => {
      let reads = 0;
      const rpc: PumpLaunchRpc = async (method, params) => {
        if (method === 'getGenesisHash') return SOLANA_MAINNET_GENESIS;
        if (method !== 'getMultipleAccounts') throw Error('Unexpected method');
        const keys = params[0] as string[],
          config = params[1] as {
            dataSlice: { offset: number; length: number };
          };
        const slice = config.dataSlice;
        const value = keys.map((key) => {
          const a = raw.get(key)!;
          return {
            owner: PUMP_UPGRADEABLE_LOADER,
            executable: a.executable,
            lamports: '1000000',
            space: String(a.bytes.length),
            data: [
              Buffer.from(
                a.bytes.slice(slice.offset, slice.offset + slice.length),
              ).toString('base64'),
              'base64',
            ],
          };
        });
        if (slice.offset >= 45 && slice.length > 45) {
          reads++;
          const lengths = value.map(
            (a) => Buffer.from(a.data[0], 'base64').length,
          );
          expect(Math.max(...lengths)).toBeLessThanOrEqual(720 * 1024);
          expect(lengths.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(
            1048576,
          );
        }
        return { context: { slot: '100' }, value };
      };
      const report = await collectPumpProgramIdentities(
        programs,
        100,
        new AbortController().signal,
        rpc,
        parallel,
      );
      for (const [i, p] of report.programs.entries()) {
        expect(p.codeBytes).toBe(sizes[i]);
        expect(p.codeSha256).toBe(
          Buffer.from(await crypto.subtle.digest('SHA-256', code[i])).toString(
            'hex',
          ),
        );
      }
      return { report, reads };
    };
    const serial = await run(1),
      parallel = await run(4);
    expect(parallel.report.programs).toEqual(serial.report.programs);
    expect(parallel.reads).toBe(5);
    expect(serial.reads).toBe(6);
  },
);
it('stops after one bounded four-slice batch when the provider rate limits code reads', async () => {
  const f = fixture('ok', true, 3 * 1024 * 1024),
    failure = new WalletRpcError(429);
  let slices = 0;
  const rpc: PumpLaunchRpc = async (method, params, signal) => {
    const config = params[1] as
      | { dataSlice?: { offset: number; length: number } }
      | undefined;
    if (
      method === 'getMultipleAccounts' &&
      config?.dataSlice &&
      config.dataSlice.offset >= 45 &&
      config.dataSlice.length > 45
    ) {
      slices++;
      throw failure;
    }
    return f.rpc(method, params, signal);
  };
  await expect(
    collectPumpProgramIdentities(
      [program],
      100,
      new AbortController().signal,
      rpc,
      4,
    ),
  ).rejects.toBe(failure);
  expect(slices).toBe(4);
});
it('advances declared stock slices past a straggler with at most four reads and ordered bytes', async () => {
  const f = fixture('binary', true, 3 * 1024 * 1024);
  let active = 0,
    maximum = 0;
  const slices: { offset: number; length: number }[] = [];
  let releaseFirst!: () => void;
  const firstHeld = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let fifthStarted!: () => void;
  const fifth = new Promise<void>((resolve) => {
    fifthStarted = resolve;
  });
  const rpc: PumpLaunchRpc = async (method, params, signal) => {
    const slice = (
      params[1] as
        | { dataSlice?: { offset: number; length: number } }
        | undefined
    )?.dataSlice;
    if (
      method !== 'getMultipleAccounts' ||
      !slice ||
      slice.offset < 45 ||
      slice.length <= 45
    )
      return f.rpc(method, params, signal);
    slices.push({ ...slice });
    active++;
    maximum = Math.max(maximum, active);
    if (slices.length === 5) fifthStarted();
    try {
      if (slice.offset === 45) await firstHeld;
      return await f.rpc(method, params, signal);
    } finally {
      active--;
    }
  };
  const pending = collectPumpProgramIdentities(
    [program],
    100,
    new AbortController().signal,
    rpc,
    4,
  );
  let fifthArrived = false;
  try {
    fifthArrived = await Promise.race([
      fifth.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 2000)),
    ]);
  } finally {
    releaseFirst();
  }
  expect(fifthArrived).toBe(true);
  const report = await pending;
  expect(maximum).toBeLessThanOrEqual(4);
  expect(slices).toEqual(
    [0, 1, 2, 3, 4].map((i) => ({
      offset: 45 + i * 720 * 1024,
      length: 720 * 1024,
    })),
  );
  expect(report.programs[0].codeSha256).toBe(
    Buffer.from(await crypto.subtle.digest('SHA-256', f.code)).toString('hex'),
  );
});
it.each(['ok', 'cancel', 'truncate'] as const)(
  'bounds parallel code slices and retains exact ordered bytes: %s',
  async (mode) => {
    const f = fixture('ok', true, 3 * 1024 * 1024),
      abort = new AbortController();
    let started = () => {};
    const batchStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const releases: (() => void)[] = [];
    let active = 0,
      maximum = 0,
      reads = 0;
    const rpc: PumpLaunchRpc = async (method, params, signal) => {
      const config = params[1] as
        | {
            minContextSlot: number;
            dataSlice: { offset: number; length: number };
          }
        | undefined;
      const code =
        method === 'getMultipleAccounts' &&
        config!.dataSlice.offset >= 45 &&
        config!.dataSlice.length > 45;
      let ordinal = 0;
      if (code) {
        ordinal = reads++;
        active++;
        maximum = Math.max(maximum, active);
        if (ordinal < 4)
          await new Promise<void>((resolve) => {
            releases.push(resolve);
            if (releases.length === 4) started();
          });
        active--;
      }
      const response = await f.rpc(method, params, signal);
      if (method === 'getMultipleAccounts') {
        const r = response as {
          context: { slot: string };
          value: { data: string[] }[];
        };
        r.context.slot = String(
          config!.minContextSlot + (code && ordinal < 4 ? ordinal : 0),
        );
        if (mode === 'truncate' && code && ordinal === 2)
          r.value[0].data[0] = Buffer.from(r.value[0].data[0], 'base64')
            .subarray(1)
            .toString('base64');
      }
      return response;
    };
    const pending = collectPumpProgramIdentities(
      [program],
      100,
      abort.signal,
      rpc,
      4,
    );
    await batchStarted;
    if (mode === 'cancel') abort.abort();
    for (const i of [3, 1, 2, 0]) releases[i]();
    if (mode === 'ok') {
      const result = await pending;
      expect(result.programs[0].codeSha256).toBe(
        Buffer.from(await crypto.subtle.digest('SHA-256', f.code)).toString(
          'hex',
        ),
      );
      expect(result.programs[0].codeBytes).toBe(f.code.length);
      expect(result.maximumSlot).toBe(103);
    } else
      await expect(pending).rejects.toThrow(
        mode === 'cancel' ? /cancelled|timed out/ : /Truncated/,
      );
    expect(maximum).toBe(4);
  },
);
it.each([true, false])(
  'hashes complete sliced code and upgrade authority with declared space %s',
  async (space) => {
    const f = fixture('ok', space);
    const report = await collectPumpProgramIdentities(
      [program, system],
      100,
      new AbortController().signal,
      f.rpc,
    );
    expect(report.programs[0]).toMatchObject({
      address: program,
      programData: dataKey,
      codeBytes: 300000,
      deploymentSlot: '90',
      upgradeAuthority: bs58.encode(new Uint8Array(32).fill(4)),
      identityKind: 'elf-code',
    });
    expect(report.programs[1].identityKind).toBe('native-system');
    expect(report.totalCodeBytes).toBe(300000);
    expect(report.semanticAuditEstablished).toBe(false);
    expect(report.signingAllowed).toBe(false);
    expect(matchesPumpProgramPolicy(report, null)).toBe(false);
    expect(
      matchesPumpProgramPolicy(report, {
        programs: report.programs,
        reviewReference: 'controlled fixture policy',
        policySha256: 'a'.repeat(64),
      }),
    ).toBe(true);
    expect(
      f.calls.every((method) =>
        ['getGenesisHash', 'getMultipleAccounts'].includes(method),
      ),
    ).toBe(true);
  },
);
it('keeps unknown-size code reads serial even in the parallel profile', async () => {
  const f = fixture('ok', false, 3 * 1024 * 1024);
  let active = 0,
    maximum = 0;
  const rpc: PumpLaunchRpc = async (method, params, signal) => {
    const config = params[1] as
      | { dataSlice?: { offset: number; length: number } }
      | undefined;
    const code =
      method === 'getMultipleAccounts' &&
      (config?.dataSlice?.offset ?? 0) >= 45;
    if (code) active++;
    maximum = Math.max(maximum, active);
    await Promise.resolve();
    const r = await f.rpc(method, params, signal);
    if (code) active--;
    return r;
  };
  const result = await collectPumpProgramIdentities(
    [program],
    100,
    new AbortController().signal,
    rpc,
    4,
  );
  expect(maximum).toBe(1);
  expect(result.programs[0].codeBytes).toBe(f.code.length);
  expect(result.programs[0].codeSha256).toBe(
    Buffer.from(await crypto.subtle.digest('SHA-256', f.code)).toString('hex'),
  );
});
it.each(['drift', 'authority', 'not-elf', 'truncated'])(
  'rejects %s code evidence',
  async (kind) => {
    const f = fixture(kind);
    await expect(
      collectPumpProgramIdentities(
        [program, system],
        100,
        new AbortController().signal,
        f.rpc,
      ),
    ).rejects.toThrow();
  },
);
it('rejects missing or repeated program scope and pre-aborted reads', async () => {
  const f = fixture();
  await expect(
    collectPumpProgramIdentities(
      [program, program],
      100,
      new AbortController().signal,
      f.rpc,
    ),
  ).rejects.toThrow('scope');
  const controller = new AbortController();
  controller.abort();
  await expect(
    collectPumpProgramIdentities([program], 100, controller.signal, f.rpc),
  ).rejects.toThrow();
  expect(f.calls).toHaveLength(0);
});
