import { afterEach, expect, it } from 'vitest';
import bs58 from 'bs58';
import { address } from '@solana/kit';
import { pairRuntimeFixture } from '../test/pair-runtime-fixture';
import { pairIntermediate } from '../test/pair-intermediate-fixture';
import { SWAP_TOKEN } from './swap-token-program-evidence';
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
it.each([false, true])(
  'protects intermediate custody across the final runtime code observation, lateChange=%s',
  async (lateChange) => {
    const v = (f = await pairRuntimeFixture()),
      { prior, key } = await pairIntermediate(v);
    const program = structuredClone([...v.programs.values()][0]);
    v.programs.set(SWAP_TOKEN, program);
    let simulations = 0;
    v.orderState.onSimulation = () => {
      if (++simulations === 2 && lateChange)
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
    f.sqlite
      .prepare('SELECT count(*) AS n FROM imported_token_project_events')
      .get(),
  ).toMatchObject({ n: 0 });
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
      if (++simulations !== 2) return;
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
    expect(simulations).toBe(2);
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
