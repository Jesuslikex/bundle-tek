import bs58 from 'bs58';
import { expect, it, vi } from 'vitest';
import {
  CPMM_MATCHED_SOURCE_IDENTITY,
  CPMM_INITIALIZE_V2_SOURCE_IDENTITY,
} from './jito-cpmm-source-identity';
import { PAIR_TRUSTED_PROGRAMS } from './pair-trusted-programs';
import {
  collectPumpProgramIdentities,
  type PumpProgramIdentity,
} from './pump-group-code-identity';
import {
  collectJitoCpmmResearchRuntimeEvidence,
  verifyJitoCpmmResearchRuntimeBracket,
  collectJitoRuntimeEvidence,
  verifyJitoRuntimeBracket,
  collectJitoCpmmV2SetupResearchRuntimeEvidence,
  verifyJitoCpmmSetupResearchRuntimeBracket,
  jitoRuntimePolicyRefusal,
  readJitoCpmmV2OpeningAccounts,
} from './jito-runtime-evidence';
import type { JitoBundleSimulationFrames } from './jito-bundle-simulation-frames';
import type { PumpLaunchRpc } from './pump-launch-simulation';
vi.mock('./pump-group-code-identity', () => ({
  collectPumpProgramIdentities: vi.fn(),
}));
const system = '11111111111111111111111111111111',
  token = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
function fixture() {
  const identities: PumpProgramIdentity[] = [system, token]
    .map((address) => {
      const p = PAIR_TRUSTED_PROGRAMS.find((p) => p.address === address)!;
      return {
        address,
        loader: p.loader,
        identityKind:
          address === system
            ? ('native-system' as const)
            : ('elf-code' as const),
        programData:
          address === system ? null : bs58.encode(new Uint8Array(32).fill(70)),
        deploymentSlot: address === system ? null : '1',
        upgradeAuthority: p.upgradeAuthority,
        codeSha256: p.codeSha256[0],
        codeBytes: address === system ? 21 : 108600,
      };
    })
    .concat([{ ...CPMM_MATCHED_SOURCE_IDENTITY }]);
  vi.mocked(collectPumpProgramIdentities).mockImplementation(
    async (selected) =>
      ({
        format: 'pump-program-code-identities-v1',
        network: 'mainnet',
        minimumSlot: 100,
        maximumSlot: 102,
        reads: 1,
        totalCodeBytes: identities.reduce((n, p) => n + p.codeBytes, 0),
        observedAt: new Date().toISOString(),
        codeIdentityVerified: true,
        semanticAuditEstablished: false,
        signingAllowed: false,
        executionAllowed: false,
        programs: structuredClone(
          identities.filter((p) => selected.includes(p.address)),
        ),
      }) as Awaited<ReturnType<typeof collectPumpProgramIdentities>>,
  );
  const keys = identities.map((p) => p.address);
  const accounts = identities.map((p) => {
    const data = p.programData
      ? Buffer.concat([
          Buffer.from([2, 0, 0, 0]),
          Buffer.from(bs58.decode(p.programData)),
        ])
      : Buffer.from('solana_system_program');
    return { owner: p.loader, lamports: '1', executable: true, data };
  });
  const rpc: PumpLaunchRpc = async (method, params) =>
    method === 'getGenesisHash'
      ? '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'
      : {
          context: { slot: '102' },
          value: (params[0] as string[]).map((k) => {
            const a = accounts[keys.indexOf(k)];
            return {
              owner: a.owner,
              lamports: a.lamports,
              executable: a.executable,
              data: [a.data.toString('base64'), 'base64'],
            };
          }),
        };
  // Isolate profile/capture/writable binding with a mocked scanner. This is not
  // a byte-scan or complete bundle simulation test; those run separately.
  const frames = {
    slot: 102,
    frames: [
      {
        keys,
        invokedProgramIndexes: [0, 1, 2],
        requestedWritable: [false, false, false],
        preAccounts: structuredClone(accounts),
        postAccounts: structuredClone(accounts),
      },
    ],
  } as unknown as JitoBundleSimulationFrames;
  return { identities, keys, rpc, frames, accounts };
}
const signal = () => new AbortController().signal;
it('issues the v2 profile separately and retains public identity diagnostics on refusal', async () => {
  const f = fixture(),
    ata = PAIR_TRUSTED_PROGRAMS.find(
      (p) => p.address === 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
    )!;
  Object.assign(f.identities[2], CPMM_INITIALIZE_V2_SOURCE_IDENTITY);
  f.identities.push({
    address: ata.address,
    loader: ata.loader,
    identityKind: 'elf-code',
    programData: null,
    deploymentSlot: null,
    upgradeAuthority: ata.upgradeAuthority,
    codeSha256: ata.codeSha256[0],
    codeBytes: 105032,
  });
  f.keys.push(ata.address);
  f.accounts.push({
    owner: ata.loader,
    lamports: '1',
    executable: true,
    data: Buffer.alloc(1),
  });
  const first = await collectJitoCpmmV2SetupResearchRuntimeEvidence(
    f.keys,
    100,
    100,
    signal(),
    f.rpc,
  );
  expect(first).toMatchObject({
    diagnosticProfile: 'cpmm-ata-v2-matched-source-research',
    signingAllowed: false,
    executionAllowed: false,
  });
  await expect(
    verifyJitoCpmmSetupResearchRuntimeBracket(first, first, f.frames, signal()),
  ).rejects.toThrow();
  f.identities[2].codeSha256 = '0'.repeat(64);
  try {
    await collectJitoCpmmV2SetupResearchRuntimeEvidence(
      f.keys,
      100,
      100,
      signal(),
      f.rpc,
    );
    throw Error('unexpected acceptance');
  } catch (error) {
    expect(jitoRuntimePolicyRefusal(error)).toMatchObject({
      reason: 'program-policy-refused',
      observedPrograms: expect.arrayContaining([
        expect.objectContaining({ codeSha256: '0'.repeat(64) }),
      ]),
      signingAllowed: false,
      executionAllowed: false,
    });
  }
});
it('binds research captures to two complete identical scans while the default profile still refuses CPMM', async () => {
  const f = fixture();
  const first = await collectJitoCpmmResearchRuntimeEvidence(
      f.keys,
      100,
      100,
      signal(),
      f.rpc,
    ),
    last = await collectJitoCpmmResearchRuntimeEvidence(
      f.keys,
      100,
      102,
      signal(),
      f.rpc,
    );
  expect(first).toMatchObject({
    diagnosticProfile: 'cpmm-matched-source-research',
    signingAllowed: false,
  });
  expect(
    await verifyJitoCpmmResearchRuntimeBracket(first, last, f.frames, signal()),
  ).toMatchObject({
    matchedSourceIdentityChecked: true,
    reviewedCodePolicyMatched: false,
    programApproved: false,
    runtimeAttested: false,
    signingAllowed: false,
  });
  expect(
    vi
      .mocked(collectPumpProgramIdentities)
      .mock.calls.every((c) => c[4] === 1 && c[5] === 100),
  ).toBe(true);
  await expect(
    verifyJitoRuntimeBracket(first, last, f.frames, signal()),
  ).rejects.toThrow();
  await expect(
    collectJitoRuntimeEvidence(f.keys, 100, 100, signal(), f.rpc),
  ).rejects.toThrow();
  await expect(
    verifyJitoCpmmResearchRuntimeBracket(
      { ...first },
      last,
      f.frames,
      signal(),
    ),
  ).rejects.toThrow();
  const ordinary = await collectJitoRuntimeEvidence(
    [system],
    100,
    100,
    signal(),
    f.rpc,
  );
  await expect(
    verifyJitoCpmmResearchRuntimeBracket(ordinary, last, f.frames, signal()),
  ).rejects.toThrow();
});
it('retains complete custody bytes at the actual opening slot, without exposing another profile or reader', async () => {
  const f = fixture(),
    ata = PAIR_TRUSTED_PROGRAMS.find(
      (p) => p.address === 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
    )!;
  Object.assign(f.identities[2], CPMM_INITIALIZE_V2_SOURCE_IDENTITY);
  f.identities.push({
    address: ata.address,
    loader: ata.loader,
    identityKind: 'elf-code',
    programData: null,
    deploymentSlot: null,
    upgradeAuthority: ata.upgradeAuthority,
    codeSha256: ata.codeSha256[0],
    codeBytes: 105032,
  });
  const custody = bs58.encode(new Uint8Array(32).fill(88));
  f.keys.push(ata.address, custody);
  f.accounts.push(
    {
      owner: ata.loader,
      lamports: '1',
      executable: true,
      data: Buffer.alloc(1),
    },
    {
      owner: token,
      lamports: '2000000',
      executable: false,
      data: Buffer.alloc(165, 8),
    },
  );
  const configs: unknown[] = [];
  const rpc: PumpLaunchRpc = async (method, params, s) => {
    const r = (await f.rpc(method, params, s)) as {
      context?: { slot: string };
    };
    if (method === 'getMultipleAccounts') {
      configs.push(params[1]);
      if ((params[1] as { minContextSlot: number }).minContextSlot === 104)
        r.context!.slot = '104';
    }
    return r;
  };
  const original = vi
    .mocked(collectPumpProgramIdentities)
    .getMockImplementation()!;
  vi.mocked(collectPumpProgramIdentities).mockImplementationOnce(
    async (...args) => {
      await args[3](
        'getMultipleAccounts',
        [
          [system],
          { encoding: 'base64', commitment: 'confirmed', minContextSlot: 104 },
        ],
        args[2],
      );
      return original(...args);
    },
  );
  const first = await collectJitoCpmmV2SetupResearchRuntimeEvidence(
    f.keys,
    100,
    100,
    signal(),
    rpc,
  );
  const opening = readJitoCpmmV2OpeningAccounts(first, rpc);
  expect(configs[0]).toMatchObject({ dataSlice: { offset: 0, length: 165 } });
  expect(first.maximumSlot).toBe(104);
  expect(opening.slot).toBe(102);
  const a = opening.accounts.at(-1) as { data: string[] };
  expect(Buffer.from(a.data[0], 'base64')).toHaveLength(165);
  a.data[0] = '';
  expect(
    (
      readJitoCpmmV2OpeningAccounts(first, rpc).accounts.at(-1) as {
        data: string[];
      }
    ).data[0],
  ).not.toBe('');
  expect(() => readJitoCpmmV2OpeningAccounts({ ...first }, rpc)).toThrow();
  expect(() => readJitoCpmmV2OpeningAccounts(first, f.rpc)).toThrow();
  const ordinary = await collectJitoRuntimeEvidence(
    [system],
    100,
    100,
    signal(),
    f.rpc,
  );
  expect(() => readJitoCpmmV2OpeningAccounts(ordinary, f.rpc)).toThrow();
});
it('retains reserved-write, exact account coverage and second-code-scan constraints', async () => {
  const f = fixture(),
    first = await collectJitoCpmmResearchRuntimeEvidence(
      f.keys,
      100,
      100,
      signal(),
      f.rpc,
    ),
    last = await collectJitoCpmmResearchRuntimeEvidence(
      f.keys,
      100,
      102,
      signal(),
      f.rpc,
    );
  const reserved = structuredClone(f.frames);
  reserved.frames[0].requestedWritable[0] = true;
  await expect(
    verifyJitoCpmmResearchRuntimeBracket(first, last, reserved, signal()),
  ).rejects.toThrow();
  const missing = structuredClone(f.frames);
  missing.frames[0].keys.pop();
  await expect(
    verifyJitoCpmmResearchRuntimeBracket(first, last, missing, signal()),
  ).rejects.toThrow();
  const malformed = structuredClone(f.frames);
  malformed.frames[0].postAccounts[2]!.data[4] ^= 1;
  await expect(
    verifyJitoCpmmResearchRuntimeBracket(first, last, malformed, signal()),
  ).rejects.toThrow();
  f.identities[2].codeSha256 = '0'.repeat(64);
  await expect(
    collectJitoCpmmResearchRuntimeEvidence(f.keys, 100, 102, signal(), f.rpc),
  ).rejects.toThrow();
});
