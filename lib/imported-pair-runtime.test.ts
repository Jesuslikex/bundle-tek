import { afterEach, expect, it } from 'vitest';
import bs58 from 'bs58';
import { address } from '@solana/kit';
import { pairRuntimeFixture } from '../test/pair-runtime-fixture';
import { pairIntermediate } from '../test/pair-intermediate-fixture';
import { SWAP_TOKEN } from './swap-token-program-evidence';
import { WalletRpcError } from './wallet-balances';
import { pairRentAccount } from '../test/pair-rent-fixture';
import {
  importedPairRuntimeRequest,
  previewOwnedImportedPairRuntime,
} from './imported-pair-runtime';
let f: Awaited<ReturnType<typeof pairRuntimeFixture>> | undefined;
afterEach(() => {
  f?.close();
  f = undefined;
});
const run = (
  v: NonNullable<typeof f>,
  owner = 'alice',
  signal = new AbortController().signal,
) =>
  previewOwnedImportedPairRuntime(
    v.db,
    owner,
    v.runtimeRequest,
    signal,
    v.runtimeDependencies,
  );
it('rejects a one-raw-unit worse order before any executable scan or simulation', async () => {
  const v = (f = await pairRuntimeFixture()),
    prepare = v.prepare.getMockImplementation()!;
  let codeReads = 0;
  const codeRpc = v.runtimeDependencies.programRpc!;
  v.runtimeDependencies.programRpc = async (...args) => {
    codeReads++;
    return codeRpc(...args);
  };
  v.prepare.mockImplementation(async (...args) => {
    const order = await prepare(...args);
    return {
      ...order,
      minimumOutAmount: (BigInt(order.minimumOutAmount) - 1n).toString(),
    };
  });
  await expect(run(v)).rejects.toMatchObject({
    status: 409,
    message: expect.stringContaining('original minimum output'),
  });
  expect(codeReads).toBe(0);
  expect(
    v.rpc.mock.calls.some(([method]) =>
      ['getBlockHeight', 'getFeeForMessage', 'simulateTransaction'].includes(
        method,
      ),
    ),
  ).toBe(false);
});
it.each([false, true])(
  'binds every block-height read to its current slot floor, lagging=%s',
  async (lagging) => {
    const v = (f = await pairRuntimeFixture()),
      original = v.rpc.getMockImplementation()!;
    const floors: number[] = [];
    v.rpc.mockImplementation(async (method, params) => {
      if (method === 'getBlockHeight') {
        const config = params[0] as {
          commitment: string;
          minContextSlot: number;
        };
        expect(config.commitment).toBe('confirmed');
        expect(config.minContextSlot).toBeGreaterThanOrEqual(100);
        floors.push(config.minContextSlot);
        if (lagging && floors.length === 3)
          throw Error('Minimum context slot has not been reached');
      }
      return original(method, params);
    });
    if (lagging) await expect(run(v)).rejects.toMatchObject({ status: 502 });
    else expect((await run(v)).signingAllowed).toBe(false);
    expect(floors).toHaveLength(3);
    expect(floors).toEqual([...floors].sort((a, b) => a - b));
  },
);
it('does not retry a rate-limited code read or publish a runtime review', async () => {
  const v = (f = await pairRuntimeFixture());
  let calls = 0;
  v.runtimeDependencies.programRpc = async () => {
    calls++;
    throw new WalletRpcError(429);
  };
  await expect(run(v)).rejects.toMatchObject({
    status: 429,
    message: 'Pair runtime provider reads are unavailable.',
  });
  // The initial code stage starts two independent reads. Neither is retried.
  expect(calls).toBe(2);
  expect(
    v.rpc.mock.calls.some(([method]) => method === 'simulateTransaction'),
  ).toBe(false);
});
it('refuses a changed Rent profile after the simulation during final code reads', async () => {
  const v = (f = await pairRuntimeFixture());
  v.runtimeState.onTrace = (trace) => {
    v.runtimeState.onCodeRead = () => {
      v.state.rentAccount = pairRentAccount(11n);
    };
    return trace;
  };
  await expect(run(v)).rejects.toMatchObject({ status: 409 });
});
it.each([false, true])(
  'protects intermediate custody across the final runtime code observation, lateChange=%s',
  async (lateChange) => {
    const v = (f = await pairRuntimeFixture()),
      { prior, key } = await pairIntermediate(v);
    const program = structuredClone([...v.programs.values()][0]);
    v.programs.set(SWAP_TOKEN, program);
    let simulations = 0;
    v.orderState.onSimulation = () => {
      if (++simulations === 1 && lateChange)
        v.runtimeState.onCodeRead = () => {
          prior.lamports = '20000001';
        };
    };
    if (lateChange) await expect(run(v)).rejects.toMatchObject({ status: 409 });
    else {
      const result = await run(v);
      expect(
        result.candidate.review.assessment.auxiliaryAccounts[0].address,
      ).toBe(key);
      expect(result.runtime.codeIdentityObserved).toBe(true);
      expect(result.signingAllowed).toBe(false);
    }
  },
);
function extraAccount(
  fixture: NonNullable<typeof f>,
  key: string,
  writable: boolean,
) {
  fixture.orderState.transform = (m) => {
    if (!writable) {
      m.staticAccounts.push(address(key));
      m.header.numReadonlyNonSignerAccounts++;
      return m;
    }
    m.staticAccounts.splice(3, 0, address(key));
    m.instructions = m.instructions.map((ix) => ({
      ...ix,
      programAddressIndex:
        ix.programAddressIndex >= 3
          ? ix.programAddressIndex + 1
          : ix.programAddressIndex,
      accountIndices: ix.accountIndices?.map((i) => (i >= 3 ? i + 1 : i)),
    }));
    return m;
  };
}
it('binds complete reachable program identities around a fresh traced economic simulation, without trust or signing', async () => {
  f = await pairRuntimeFixture();
  let traced = false,
    before = 0,
    after = 0;
  f.runtimeState.onCodeRead = () => {
    if (traced) after++;
    else before++;
  };
  f.runtimeState.onTrace = (trace) => {
    expect(before).toBeGreaterThan(0);
    traced = true;
    return trace;
  };
  const result = await run(f);
  expect(result).toMatchObject({
    format: 'imported-pair-runtime-preview-v1',
    approvalCreated: false,
    reservationCreated: false,
    signingAllowed: false,
    executionAllowed: false,
    runtime: {
      codeIdentityObserved: true,
      programCodeAttested: false,
      trustedProgramPolicyEstablished: false,
      innerInstructionPolicyVerified: false,
      semanticAuditEstablished: false,
    },
  });
  expect(result.runtime.programs).toHaveLength(f.programs.size);
  expect(
    result.runtime.programs.every(
      (p) => p.codeBytes === 256 && p.identityKind === 'elf-code',
    ),
  ).toBe(true);
  expect(result.runtime.reviewSha256).toBe(result.candidate.review.sha256);
  expect(result.runtime.traceSha256).toBe(
    result.candidate.review.runtimeTrace?.sha256,
  );
  expect(result.candidate.review.runtimeTrace).toMatchObject({
    parsedInstructionCount: 1,
    rawInstructionCoverageComplete: false,
  });
  expect(result.runtime.sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(f.prepare).toHaveBeenCalledOnce();
  expect(
    f.rpc.mock.calls.filter(([method]) => method === 'simulateTransaction'),
  ).toHaveLength(1);
  expect(before).toBeGreaterThan(0);
  expect(after).toBeGreaterThan(0);
  expect(
    result.runtime.maximumSlot - result.runtime.minimumSlot,
  ).toBeLessThanOrEqual(32);
  expect(
    f.sqlite
      .prepare('SELECT count(*) AS n FROM imported_token_project_events')
      .get(),
  ).toMatchObject({ n: 0 });
});
it('retains the 32-slot limit before attempting the sole runtime simulation', async () => {
  const v = (f = await pairRuntimeFixture()),
    rpc = v.runtimeDependencies.programRpc!;
  v.runtimeDependencies.programRpc = async (method, params) => {
    const r = await rpc(method, params);
    if (method === 'getMultipleAccounts')
      (r as { context: { slot: string } }).context.slot = String(
        (params[1] as { minContextSlot: number }).minContextSlot + 33,
      );
    return r;
  };
  await expect(run(v)).rejects.toMatchObject({ status: 409 });
  expect(
    v.rpc.mock.calls.some(([method]) => method === 'simulateTransaction'),
  ).toBe(false);
});
it.each(['foreign', 'revision', 'missing-intent', 'extra-field'] as const)(
  'rejects %s before any wallet-bound runtime preparation',
  async (mode) => {
    const fixture = (f = await pairRuntimeFixture());
    if (mode === 'revision') fixture.runtimeRequest.revision++;
    if (mode === 'missing-intent')
      expect(() =>
        importedPairRuntimeRequest({
          ...fixture.runtimeRequest,
          inspectRuntime: false,
        }),
      ).toThrow();
    else if (mode === 'extra-field')
      expect(() =>
        importedPairRuntimeRequest({ ...fixture.runtimeRequest, programs: [] }),
      ).toThrow();
    else
      await expect(
        run(fixture, mode === 'foreign' ? 'bob' : 'alice'),
      ).rejects.toMatchObject({ status: mode === 'foreign' ? 404 : 409 });
    expect(fixture.prepare).not.toHaveBeenCalled();
  },
);
it.each([
  'changed-code',
  'missing-program',
  'not-executable',
  'not-elf',
  'wrong-loader',
] as const)('rejects %s executable evidence', async (mode) => {
  const fixture = (f = await pairRuntimeFixture()),
    key = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
  const program = fixture.programs.get(key)!;
  if (mode === 'missing-program') fixture.programs.delete(key);
  if (mode === 'not-executable') program.executable = false;
  if (mode === 'not-elf')
    program.data[0] = Buffer.from(new Uint8Array(256)).toString('base64');
  if (mode === 'wrong-loader')
    program.owner = '11111111111111111111111111111111';
  if (mode === 'changed-code')
    fixture.runtimeState.onTrace = (trace) => {
      const bytes = Buffer.from(program.data[0], 'base64');
      bytes[8] ^= 1;
      program.data[0] = bytes.toString('base64');
      return trace;
    };
  await expect(run(fixture)).rejects.toMatchObject({ status: 409 });
});
it.each(['nonce', 'stake', 'loader', 'executable'] as const)(
  'rejects unmodeled writable %s exposure',
  async (mode) => {
    const fixture = (f = await pairRuntimeFixture());
    const key = bs58.encode(new Uint8Array(32).fill(33));
    extraAccount(fixture, key, true);
    fixture.orderState.otherAccounts.set(key, {
      owner:
        mode === 'nonce'
          ? '11111111111111111111111111111111'
          : mode === 'stake'
            ? 'Stake11111111111111111111111111111111111111'
            : 'BPFLoaderUpgradeab1e11111111111111111111111',
      executable: mode === 'executable',
      lamports: '1000000',
      data: [Buffer.from(new Uint8Array(80)).toString('base64'), 'base64'],
    });
    await expect(run(fixture)).rejects.toMatchObject({ status: 409 });
  },
);
it.each(['before-inventory', 'simulation-post-state'] as const)(
  'preserves a private account/phase diagnostic through the public 409: %s',
  async (phase) => {
    const fixture = (f = await pairRuntimeFixture());
    const key = bs58.encode(new Uint8Array(32).fill(33));
    extraAccount(fixture, key, true);
    const safe = {
      owner: '11111111111111111111111111111111',
      executable: false,
      lamports: '1000000',
      data: ['', 'base64'],
    };
    const blocked = {
      ...safe,
      owner: 'Stake11111111111111111111111111111111111111',
    };
    fixture.orderState.otherAccounts.set(
      key,
      phase === 'before-inventory' ? blocked : safe,
    );
    if (phase === 'simulation-post-state')
      fixture.orderState.onSimulation = (response, addresses) => {
        response.value.accounts[addresses.indexOf(key)] = blocked;
      };
    let caught: unknown;
    try {
      await run(fixture);
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ status: 409 });
    expect(JSON.stringify(caught)).not.toContain(key);
    const diagnostics: unknown[] = [];
    for (let depth = 0; caught && depth < 8; depth++) {
      const current = caught as { cause?: unknown; pairDiagnostic?: unknown };
      if (current.pairDiagnostic) diagnostics.push(current.pairDiagnostic);
      caught = current.cause;
    }
    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        check: 'writable-runtime-state',
        accountAddress: key,
        observationPhase: phase,
        accountOwner: blocked.owner,
        packetScopeEvidence: 'available',
        compiledAccountSource: 'static',
        compiledAccountIndex: 3,
        declaredWritable: true,
        declaredSigner: false,
        rpcAccountCount: expect.any(Number),
        rpcAccountPosition: expect.any(Number),
        packetSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    );
  },
);
it('rechecks saved ownership context after the complete code observations', async () => {
  const fixture = (f = await pairRuntimeFixture());
  fixture.runtimeState.onTrace = (trace) => {
    fixture.sqlite.exec('UPDATE workspace_wallets SET revision=revision+1');
    return trace;
  };
  await expect(run(fixture)).rejects.toMatchObject({ status: 409 });
});
it('rejects missing inner trace', async () => {
  const fixture = (f = await pairRuntimeFixture());
  fixture.runtimeState.onTrace = () => [];
  await expect(run(fixture)).rejects.toMatchObject({ status: 409 });
});
it('covers unused reachable executables rather than only programs seen in simulation', async () => {
  const fixture = (f = await pairRuntimeFixture()),
    key = bs58.encode(new Uint8Array(32).fill(34));
  fixture.addExecutable(key);
  extraAccount(fixture, key, false);
  const result = await run(fixture);
  expect(result.runtime.programs.some((p) => p.address === key)).toBe(true);
  expect(result.candidate.review.runtimeTrace?.programs).not.toContain(key);
});
it('observes the native compute-budget marker without calling it ELF code or an audit', async () => {
  const fixture = (f = await pairRuntimeFixture()),
    key = 'ComputeBudget111111111111111111111111111111';
  const bytes = Buffer.from('compute_budget_program');
  fixture.programs.set(key, {
    owner: 'NativeLoader1111111111111111111111111111111',
    executable: true,
    lamports: '1000000',
    space: String(bytes.length),
    data: [bytes.toString('base64'), 'base64'],
  });
  fixture.orderState.transform = (m) => {
    const index = m.staticAccounts.length;
    m.staticAccounts.push(address(key));
    m.header.numReadonlyNonSignerAccounts++;
    const data = new Uint8Array(5);
    data[0] = 2;
    new DataView(data.buffer).setUint32(1, 200000, true);
    m.instructions.unshift({
      programAddressIndex: index,
      accountIndices: [],
      data,
    });
    return m;
  };
  expect(
    (await run(fixture)).runtime.programs.find((p) => p.address === key),
  ).toMatchObject({ identityKind: 'native-marker', codeBytes: bytes.length });
});
it('rejects code-scan expiry and sanitizes a failed code provider', async () => {
  const fixture = (f = await pairRuntimeFixture());
  fixture.runtimeDependencies.programRpc = async () => {
    throw Error('private-code-endpoint');
  };
  await expect(run(fixture)).rejects.toMatchObject({
    status: 502,
    message: 'Pair runtime provider reads are unavailable.',
  });
});
it('rejects quote expiry reached while collecting runtime code', async () => {
  const fixture = (f = await pairRuntimeFixture());
  fixture.runtimeState.onCodeRead = () => {
    fixture.clock.now += 30001;
  };
  await expect(run(fixture)).rejects.toMatchObject({ status: 409 });
});
it('checks final balances after the second code collection', async () => {
  const fixture = (f = await pairRuntimeFixture());
  let traced = false;
  fixture.runtimeState.onTrace = (trace) => {
    traced = true;
    return trace;
  };
  fixture.runtimeState.onCodeRead = () => {
    if (traced) fixture.state.walletAccount!.lamports = '999999999';
  };
  await expect(run(fixture)).rejects.toMatchObject({ status: 409 });
});
it.each(['nonce', 'stake', 'loader', 'executable'] as const)(
  'rejects newly created %s custody in simulated post-state',
  async (mode) => {
    const fixture = (f = await pairRuntimeFixture()),
      key = bs58.encode(new Uint8Array(32).fill(35));
    extraAccount(fixture, key, true);
    let simulations = 0;
    fixture.orderState.onSimulation = (response, keys) => {
      if (++simulations !== 1) return;
      response.value.accounts[keys.indexOf(key)] = {
        owner:
          mode === 'nonce'
            ? '11111111111111111111111111111111'
            : mode === 'stake'
              ? 'Stake11111111111111111111111111111111111111'
              : 'BPFLoaderUpgradeab1e11111111111111111111111',
        executable: mode === 'executable',
        lamports: '1000000',
        data: [Buffer.from(new Uint8Array(80)).toString('base64'), 'base64'],
      };
    };
    await expect(run(fixture)).rejects.toMatchObject({ status: 409 });
    expect(simulations).toBe(1);
  },
);
it('cancels a stalled code read without storing approval or exposing provider secrets', async () => {
  const fixture = (f = await pairRuntimeFixture());
  let start = () => {};
  const started = new Promise<void>((resolve) => {
    start = resolve;
  });
  fixture.runtimeDependencies.programRpc = () => {
    start();
    return new Promise(() => {});
  };
  const controller = new AbortController(),
    pending = run(fixture, 'alice', controller.signal);
  await Promise.race([
    started,
    pending.then(() => {
      throw Error('Runtime completed before the intended stalled read.');
    }),
  ]);
  controller.abort();
  await expect(pending).rejects.toMatchObject({ status: 408 });
});
