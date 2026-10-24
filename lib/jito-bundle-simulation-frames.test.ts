import {
  address,
  getBase64Decoder,
  getCompiledTransactionMessageEncoder,
  getTransactionEncoder,
  type TransactionMessageBytes,
} from '@solana/kit';
import bs58 from 'bs58';
import { expect, it, vi } from 'vitest';
import {
  buildJitoBundleSimulationRequest,
  verifyJitoBundleSimulationFrames,
} from './jito-bundle-simulation-frames';
const key = (n: number) => bs58.encode(new Uint8Array(32).fill(n));
const SYSTEM = '11111111111111111111111111111111';
const payer = key(1),
  signer = key(2),
  recipient = key(3),
  readonly = key(4),
  tip = key(5),
  table = key(6),
  loader = key(7);
const account = (
  lamports: string,
  data = '',
  owner = SYSTEM,
  executable = false,
) => ({ lamports, data: [data, 'base64'], owner, executable });
const executable = () => account('1', '', loader, true);
function serialized(
  version: 'legacy' | 0 | 1,
  options: {
    invalidIndex?: boolean;
    duplicateLookup?: boolean;
    readonlyPayer?: boolean;
    duplicateStatic?: boolean;
    blockhash?: number;
    programIndex?: number;
    emptyLookup?: boolean;
    writableProgram?: boolean;
  } = {},
) {
  const first = version !== 'legacy';
  const staticAccounts = (
    first
      ? version === 0
        ? [payer, signer, SYSTEM]
        : [payer, signer, recipient, readonly, SYSTEM]
      : [payer, tip, SYSTEM]
  ).map(address);
  if (options.duplicateStatic) staticAccounts[1] = staticAccounts[0];
  const header = {
    numSignerAccounts: first ? 2 : 1,
    numReadonlySignerAccounts: options.readonlyPayer ? 2 : first ? 1 : 0,
    numReadonlyNonSignerAccounts: options.writableProgram
      ? 0
      : version === 1
        ? 2
        : 1,
  };
  const index = version === 0 ? 3 : version === 1 ? 2 : 1;
  const message =
    version === 1
      ? {
          version: 1 as const,
          header,
          lifetimeToken: address(key(options.blockhash ?? 8)),
          configMask: 0,
          configValues: [],
          numInstructions: 1,
          numStaticAccounts: staticAccounts.length,
          staticAccounts,
          instructionHeaders: [
            {
              programAccountIndex: 4,
              numInstructionAccounts: 2,
              numInstructionDataBytes: 1,
            },
          ],
          instructionPayloads: [
            {
              instructionAccountIndices: [0, options.invalidIndex ? 99 : index],
              instructionData: new Uint8Array([1]),
            },
          ],
        }
      : {
          version,
          header,
          lifetimeToken: address(key(options.blockhash ?? 8)),
          staticAccounts,
          instructions: [
            {
              programAddressIndex: options.programIndex ?? 2,
              accountIndices: [0, options.invalidIndex ? 99 : index],
              data: new Uint8Array([1]),
            },
          ],
          ...(version === 0
            ? {
                addressTableLookups: [
                  {
                    lookupTableAddress: address(table),
                    writableIndexes: options.emptyLookup ? [] : [0],
                    readonlyIndexes: options.emptyLookup
                      ? []
                      : [options.duplicateLookup ? 0 : 1],
                  },
                ],
              }
            : {}),
        };
  const messageBytes = getCompiledTransactionMessageEncoder().encode(
    message,
  ) as TransactionMessageBytes;
  return getBase64Decoder().decode(
    getTransactionEncoder().encode({
      messageBytes,
      signatures: Object.fromEntries(
        staticAccounts.slice(0, header.numSignerAccounts).map((k) => [k, null]),
      ),
    }),
  );
}
function fixture(version: 0 | 1 = 0) {
  const transaction = serialized(version),
    tipTransaction = serialized('legacy');
  const loadedAddresses =
    version === 0 ? { writable: [recipient], readonly: [readonly] } : null;
  const pre =
    version === 0
      ? [account('100000'), account('400'), executable(), null, account('50')]
      : [account('100000'), account('400'), null, account('50'), executable()];
  const post = structuredClone(pre);
  post[0] = account('89000');
  post[version === 0 ? 3 : 2] = account('1000');
  return {
    packets: [
      {
        transaction,
        loadedAddresses,
        maximumFeeLamports: '10000',
        expectedFeeLamports: '10000',
      },
      {
        transaction: tipTransaction,
        loadedAddresses: null,
        maximumFeeLamports: '5000',
        expectedFeeLamports: '5000',
      },
    ],
    minimumSlot: 100,
    simulationBankSlot: 101,
    result: {
      context: { slot: 101 },
      value: {
        summary: 'succeeded',
        transactionResults: [
          {
            err: null,
            preExecutionAccounts: pre,
            postExecutionAccounts: post,
            ...(loadedAddresses ? { loadedAddresses } : {}),
            fee: '10000',
            unitsConsumed: 1000,
            loadedAccountsDataSize: '100',
          },
          {
            err: null,
            preExecutionAccounts: [account('89000'), null, executable()],
            postExecutionAccounts: [
              account('83000'),
              account('1000'),
              executable(),
            ],
            fee: '5000',
            unitsConsumed: 100,
            loadedAccountsDataSize: '0',
          },
        ],
      },
    },
  };
}
type Fixture = ReturnType<typeof fixture>;
const reject = async (mutate: (f: Fixture) => void, message?: string) => {
  const f = fixture();
  mutate(f);
  await expect(verifyJitoBundleSimulationFrames(f)).rejects.toThrow(message);
};
it('admits synthetic kit-encoded v0+ALT and legacy tip full frames with requested privileges and no authority', async () => {
  const f = fixture(),
    fetcher = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(Error('network forbidden'));
  try {
    const admitted = await verifyJitoBundleSimulationFrames(f);
    expect(admitted.slot).toBe(101);
    expect(admitted.frames).toHaveLength(2);
    expect(admitted.frames[0]).toMatchObject({
      keys: [payer, signer, SYSTEM, recipient, readonly],
      signers: [true, true, false, false, false],
      requestedWritable: [true, false, false, true, false],
      requestedReadonly: [false, true, true, false, true],
      feeLamports: '10000',
      loadedAccountsDataSize: '100',
    });
    expect(admitted.frames[0].postAccounts[3]?.data).toBeInstanceOf(Uint8Array);
    expect(admitted.frames[1].preAccounts[0]).toEqual(
      admitted.frames[0].postAccounts[0],
    );
    expect(admitted).toMatchObject({
      signingAllowed: false,
      executionAllowed: false,
      automaticExecutionAllowed: false,
      economicOutputVerified: false,
      providerQualified: false,
      signatureVerified: false,
      altStateVerified: false,
    });
    expect(fetcher).not.toHaveBeenCalled();
    f.result.value.transactionResults[0].postExecutionAccounts[0]!.lamports =
      '1';
    expect(admitted.frames[0].postAccounts[0]?.lamports).toBe('89000');
  } finally {
    fetcher.mockRestore();
  }
});
it('refuses version1 until its runtime contract is independently admitted', async () => {
  await expect(verifyJitoBundleSimulationFrames(fixture(1))).rejects.toThrow(
    'transaction version is not admitted',
  );
});
it('admits boundary slot32 and normalized safe integer strings/numbers', async () => {
  const f = fixture();
  f.result.context.slot = 132;
  f.simulationBankSlot = 132;
  const result = f.result as unknown as {
    context: { slot: unknown };
    value: { transactionResults: Record<string, unknown>[] };
  };
  result.context.slot = '132';
  result.value.transactionResults[0].fee = 10000;
  result.value.transactionResults[0].unitsConsumed = '1400000';
  result.value.transactionResults[0].loadedAccountsDataSize = 67108864;
  expect(
    (await verifyJitoBundleSimulationFrames(f)).frames[0].unitsConsumed,
  ).toBe(1400000);
});
for (const slot of [99, 133, -1, Number.MAX_SAFE_INTEGER + 1, NaN])
  it(`refuses unsafe or out-of-span slot ${slot}`, async () =>
    reject((f) => {
      f.result.context.slot = slot;
      f.simulationBankSlot = slot;
    }));
for (const variant of [
  'summary',
  'err',
  'partial',
  'extra',
  'pre-short',
  'post-short',
  'replacement',
  'echo',
  'fee0',
  'fee-cap',
  'compute0',
  'compute-high',
  'datasize',
  'readonly',
  'executable',
  'payer-owner',
  'payer-data',
  'payer-executable',
  'conservation',
  'continuity',
])
  it(`refuses ${variant}`, async () =>
    reject((f) => {
      const a = f.result.value.transactionResults[0],
        b = f.result.value.transactionResults[1];
      if (variant === 'summary') f.result.value.summary = 'failed';
      if (variant === 'err')
        Object.assign(a, { err: { InstructionError: [0, 'failed'] } });
      if (variant === 'partial') f.result.value.transactionResults.pop();
      if (variant === 'extra') f.result.value.transactionResults.push(b);
      if (variant === 'pre-short') a.preExecutionAccounts.pop();
      if (variant === 'post-short') a.postExecutionAccounts.pop();
      if (variant === 'replacement')
        Object.assign(a, { replacementBlockhash: { blockhash: key(10) } });
      if (variant === 'echo')
        Object.assign(a, { transaction: f.packets[1].transaction });
      if (variant === 'fee0') a.fee = '0';
      if (variant === 'fee-cap') a.fee = '10001';
      if (variant === 'compute0') a.unitsConsumed = 0;
      if (variant === 'compute-high') a.unitsConsumed = 1400001;
      if (variant === 'datasize') a.loadedAccountsDataSize = '67108865';
      if (variant === 'readonly')
        a.postExecutionAccounts[1]!.data = ['AQ==', 'base64'];
      if (variant === 'executable')
        a.postExecutionAccounts[2]!.data = ['AQ==', 'base64'];
      if (variant === 'payer-owner') a.preExecutionAccounts[0]!.owner = loader;
      if (variant === 'payer-data')
        a.postExecutionAccounts[0]!.data = ['AQ==', 'base64'];
      if (variant === 'payer-executable')
        a.preExecutionAccounts[0]!.executable = true;
      if (variant === 'conservation')
        a.postExecutionAccounts[0]!.lamports = '88999';
      if (variant === 'continuity') {
        b.preExecutionAccounts[0]!.lamports = '89001';
        b.postExecutionAccounts[0]!.lamports = '83001';
      }
    }));
for (const which of [
  'missing',
  'wrong',
  'duplicate',
  'cardinality',
  'inputmissing',
  'inputduplicate',
])
  it(`refuses ALT ${which}`, async () =>
    reject((f) => {
      const a = f.result.value.transactionResults[0];
      if (which === 'missing') delete a.loadedAddresses;
      if (which === 'wrong')
        a.loadedAddresses = { writable: [tip], readonly: [readonly] };
      if (which === 'duplicate')
        a.loadedAddresses = { writable: [recipient], readonly: [recipient] };
      if (which === 'cardinality')
        a.loadedAddresses = { writable: [], readonly: [readonly] };
      if (which === 'inputmissing') f.packets[0].loadedAddresses = null;
      if (which === 'inputduplicate') {
        f.packets[0].loadedAddresses = {
          writable: [payer],
          readonly: [readonly],
        };
        a.loadedAddresses = f.packets[0].loadedAddresses;
      }
    }));
for (const which of [
  'bad-index',
  'duplicate-lookup',
  'readonly-payer',
  'duplicate-static',
  'duplicate-packet',
  'noncanonical-base64',
  'oversized-packet',
  'trailing-packet',
  'reordered',
])
  it(`refuses packet ${which}`, async () =>
    reject((f) => {
      if (which === 'bad-index')
        f.packets[0].transaction = serialized(0, { invalidIndex: true });
      if (which === 'duplicate-lookup')
        f.packets[0].transaction = serialized(0, { duplicateLookup: true });
      if (which === 'readonly-payer')
        f.packets[0].transaction = serialized(0, { readonlyPayer: true });
      if (which === 'duplicate-static')
        f.packets[0].transaction = serialized(0, { duplicateStatic: true });
      if (which === 'duplicate-packet') f.packets[1] = { ...f.packets[0] };
      if (which === 'noncanonical-base64') f.packets[0].transaction += '\n';
      if (which === 'oversized-packet')
        f.packets[0].transaction = Buffer.alloc(1233).toString('base64');
      if (which === 'trailing-packet')
        f.packets[0].transaction = Buffer.concat([
          Buffer.from(f.packets[0].transaction, 'base64'),
          Buffer.from([0]),
        ]).toString('base64');
      if (which === 'reordered') f.result.value.transactionResults.reverse();
    }));
for (const which of [
  'owner',
  'negative',
  'unsafe-number',
  'u64-over',
  'leading-zero',
  'badbase64',
  'pad-bits',
  'encoding',
  'bool',
  'extra-field',
  'missing',
  'oversized-data',
])
  it(`refuses raw account ${which}`, async () =>
    reject((f) => {
      const a = f.result.value.transactionResults[0].postExecutionAccounts[3]!;
      if (which === 'owner') a.owner = 'bad';
      if (which === 'negative') a.lamports = '-1';
      if (which === 'unsafe-number')
        Object.assign(a, { lamports: 9007199254740992 });
      if (which === 'u64-over') a.lamports = '18446744073709551616';
      if (which === 'leading-zero') a.lamports = '01000';
      if (which === 'badbase64') a.data = ['!', 'base64'];
      if (which === 'pad-bits') a.data = ['AB==', 'base64'];
      if (which === 'encoding') a.data = ['AQ==', 'base58'];
      if (which === 'bool') Object.assign(a, { executable: 0 });
      if (which === 'extra-field') Object.assign(a, { rentEpoch: '0' });
      if (which === 'missing') delete (a as { owner?: string }).owner;
      if (which === 'oversized-data')
        a.data = [Buffer.alloc(512 * 1024 + 1).toString('base64'), 'base64'];
    }));
it('refuses wrapper bytes, raw total bytes, getters and sparse arrays', async () => {
  await reject(
    (f) => Object.assign(f.result, { padding: 'x'.repeat(4 * 1024 * 1024) }),
    'wrapper byte',
  );
  await reject((f) => {
    const blob = Buffer.alloc(512 * 1024).toString('base64');
    for (const frame of f.result.value.transactionResults)
      for (const accounts of [
        frame.preExecutionAccounts,
        frame.postExecutionAccounts,
      ])
        for (let i = 1; i < accounts.length; i++)
          if (accounts[i]) accounts[i]!.data = [blob, 'base64'];
  });
  await reject(
    (f) =>
      Object.defineProperty(f.result.context, 'slot', {
        get() {
          throw Error('getter executed');
        },
        enumerable: true,
      }),
    'non-JSON property',
  );
  await reject((f) => {
    f.result.value.transactionResults[0].preExecutionAccounts = Object.assign(
      [],
      { length: 5 },
    );
  }, 'invalid array');
});
it('refuses any provided no-ALT loaded mismatch but accepts absent or null vectors', async () => {
  await reject((f) =>
    Object.assign(f.result.value.transactionResults[1], {
      loadedAddresses: { writable: [tip], readonly: [] },
    }),
  );
  const f = fixture();
  Object.assign(f.result.value.transactionResults[1], {
    loadedAddresses: null,
  });
  expect(
    (await verifyJitoBundleSimulationFrames(f)).frames[1].loadedAddresses,
  ).toEqual({ writable: [], readonly: [] });
});
it('tracks null-account continuity across later frames', async () => {
  const f = fixture();
  // The first recipient is created. A later reference cannot claim it was absent.
  f.packets[1].transaction = serialized('legacy', { blockhash: 9 });
  const bytes = Buffer.from(f.packets[1].transaction, 'base64');
  // Replace the recipient static key while retaining an otherwise canonical packet.
  const tipBytes = Buffer.from(bs58.decode(tip));
  const at = bytes.indexOf(tipBytes);
  bytes.set(bs58.decode(recipient), at);
  f.packets[1].transaction = bytes.toString('base64');
  await expect(verifyJitoBundleSimulationFrames(f)).rejects.toThrow(
    'continuity',
  );
});

for (const verifySignatures of [true, false])
  for (const bankEncoding of ['slot-object', 'numeric-slot'] as const)
    it(`builds exact ordered all-key request with explicit signature verification ${verifySignatures} and ${bankEncoding}`, async () => {
      const f = fixture();
      const before = structuredClone(f.packets);
      const request = await buildJitoBundleSimulationRequest(f.packets, '101', {
        verifySignatures,
        bankEncoding,
      });
      expect(request.profile).toBe('jito-sequential-account-frames-v1');
      expect(request.method).toBe('simulateBundle');
      expect(request.params[0]).toEqual({
        encodedTransactions: f.packets.map((p) => p.transaction),
      });
      expect(request.params[1]).toEqual({
        transactionEncoding: 'base64',
        simulationBank: bankEncoding === 'slot-object' ? { slot: 101 } : 101,
        skipSigVerify: !verifySignatures,
        replaceRecentBlockhash: false,
        preExecutionAccountsConfigs: [
          {
            encoding: 'base64',
            addresses: [payer, signer, SYSTEM, recipient, readonly],
          },
          { encoding: 'base64', addresses: [payer, tip, SYSTEM] },
        ],
        postExecutionAccountsConfigs: [
          {
            encoding: 'base64',
            addresses: [payer, signer, SYSTEM, recipient, readonly],
          },
          { encoding: 'base64', addresses: [payer, tip, SYSTEM] },
        ],
      });
      expect(f.packets).toEqual(before);
      expect(request.bankEncoding).toBe(bankEncoding);
      expect(request.packetBindings).toEqual(
        before.map((packet) => ({
          ...packet,
          loadedAddresses: packet.loadedAddresses ?? {
            writable: [],
            readonly: [],
          },
        })),
      );
      expect(request).toMatchObject({
        providerQualified: false,
        signingAllowed: false,
        executionAllowed: false,
        automaticExecutionAllowed: false,
      });
      f.packets.reverse();
      expect(request.params[0].encodedTransactions).toEqual(
        before.map((p) => p.transaction),
      );
      expect(request.packetBindings.map((p) => p.transaction)).toEqual(
        before.map((p) => p.transaction),
      );
    });
it('request builder shares packet refusal rules and never substitutes missing ALT or implicit modes', async () => {
  const f = fixture();
  for (const packets of [
    [],
    [f.packets[0]],
    Array.from({ length: 6 }, () => f.packets[0]),
    [f.packets[0], f.packets[0]],
    [{ ...f.packets[0], loadedAddresses: null }, f.packets[1]],
    [
      { ...f.packets[0], transaction: serialized(0, { invalidIndex: true }) },
      f.packets[1],
    ],
  ])
    await expect(
      buildJitoBundleSimulationRequest(packets, 100, {
        verifySignatures: false,
        bankEncoding: 'slot-object',
      }),
    ).rejects.toThrow();
  for (const slot of [
    -1,
    NaN,
    Number.MAX_SAFE_INTEGER + 1,
    '0100',
    'tip',
    'confirmed',
    '1e2',
    '101.0',
    { slot: 101 },
  ])
    await expect(
      buildJitoBundleSimulationRequest(f.packets, slot as number | string, {
        verifySignatures: false,
        bankEncoding: 'slot-object',
      }),
    ).rejects.toThrow();
  await expect(
    buildJitoBundleSimulationRequest(f.packets, 100, {
      verifySignatures: 'false',
      bankEncoding: 'slot-object',
    } as unknown as Parameters<typeof buildJitoBundleSimulationRequest>[2]),
  ).rejects.toThrow();
});
it('preserves exact numeric bank boundaries on the wire without profile fallback', async () => {
  const f = fixture();
  for (const slot of [0, Number.MAX_SAFE_INTEGER]) {
    const request = await buildJitoBundleSimulationRequest(f.packets, slot, {
      verifySignatures: false,
      bankEncoding: 'numeric-slot',
    });
    const wire = JSON.parse(JSON.stringify(request.params)) as [
      unknown,
      { simulationBank: unknown; replaceRecentBlockhash: boolean },
    ];
    expect(wire[1].simulationBank).toBe(slot);
    expect(typeof wire[1].simulationBank).toBe('number');
    expect(wire[1].replaceRecentBlockhash).toBe(false);
    expect(request.providerQualified).toBe(false);
  }
});
for (const bankEncoding of [
  undefined,
  null,
  'tip',
  'confirmed',
  'automatic',
  {},
  1,
])
  it(`requires an explicit supported bank wire encoding: ${JSON.stringify(bankEncoding)}`, async () => {
    const f = fixture();
    const options = {
      verifySignatures: false,
      ...(bankEncoding === undefined ? {} : { bankEncoding }),
    };
    await expect(
      buildJitoBundleSimulationRequest(
        f.packets,
        101,
        options as Parameters<typeof buildJitoBundleSimulationRequest>[2],
      ),
    ).rejects.toThrow();
  });
it('admits exact optional transaction echoes and refuses a changed echoed order', async () => {
  const f = fixture();
  for (let i = 0; i < 2; i++)
    Object.assign(f.result.value.transactionResults[i], {
      transaction: f.packets[i].transaction,
    });
  expect((await verifyJitoBundleSimulationFrames(f)).frames).toHaveLength(2);
  Object.assign(f.result.value.transactionResults[0], {
    transaction: f.packets[1].transaction,
  });
  await expect(verifyJitoBundleSimulationFrames(f)).rejects.toThrow(
    'mismatched',
  );
});
it('enforces the aggregate raw bound independently of each-account and wrapper bounds', async () => {
  const f = fixture();
  const blob = Buffer.alloc(512 * 1024).toString('base64');
  // Five read-only raw snapshots are individually valid and under the wrapper limit.
  for (const accounts of [
    f.result.value.transactionResults[0].preExecutionAccounts,
    f.result.value.transactionResults[0].postExecutionAccounts,
  ]) {
    accounts[1]!.data = [blob, 'base64'];
    accounts[4]!.data = [blob, 'base64'];
  }
  f.result.value.transactionResults[1].preExecutionAccounts[1] = account(
    '0',
    Buffer.alloc(1).toString('base64'),
  );
  await expect(verifyJitoBundleSimulationFrames(f)).rejects.toThrow(
    'raw account data bound',
  );
});

for (const options of [
  { programIndex: 0 },
  { programIndex: 3 },
  { emptyLookup: true },
  { writableProgram: true },
])
  it(`refuses unsanitized program/lookup request ${JSON.stringify(options)}`, async () => {
    const f = fixture();
    f.packets[0].transaction = serialized(0, options);
    const reason =
      'emptyLookup' in options
        ? 'invalid lookup indexes'
        : 'writableProgram' in options
          ? 'invoked program requested writable'
          : 'program index must reference nonpayer static account';
    await expect(verifyJitoBundleSimulationFrames(f)).rejects.toThrow(reason);
    await expect(
      buildJitoBundleSimulationRequest(f.packets, 101, {
        verifySignatures: false,
        bankEncoding: 'slot-object',
      }),
    ).rejects.toThrow(reason);
  });
it('requires the exact requested simulation bank even when another slot is within the floor span', async () => {
  const f = fixture();
  f.simulationBankSlot = 102;
  await expect(verifyJitoBundleSimulationFrames(f)).rejects.toThrow(
    'simulation bank differs',
  );
  f.simulationBankSlot = 101;
  f.result.context.slot = 102;
  await expect(verifyJitoBundleSimulationFrames(f)).rejects.toThrow(
    'simulation bank differs',
  );
  Object.assign(f, { simulationBankSlot: undefined });
  await expect(verifyJitoBundleSimulationFrames(f)).rejects.toThrow();
});
it('refuses an understated fee even when native conservation agrees with that understatement', async () => {
  const f = fixture();
  const [first, last] = f.result.value.transactionResults;
  first.fee = '5000';
  first.postExecutionAccounts[0]!.lamports = '94000';
  last.preExecutionAccounts[0]!.lamports = '94000';
  last.postExecutionAccounts[0]!.lamports = '88000';
  await expect(verifyJitoBundleSimulationFrames(f)).rejects.toThrow(
    'fee outside cap',
  );
});
for (const fee of ['0', '10001', '010000'])
  it(`refuses inadmissible caller fee ${fee}`, async () => {
    const f = fixture();
    f.packets[0].expectedFeeLamports = fee;
    await expect(verifyJitoBundleSimulationFrames(f)).rejects.toThrow();
    await expect(
      buildJitoBundleSimulationRequest(f.packets, 101, {
        verifySignatures: false,
        bankEncoding: 'slot-object',
      }),
    ).rejects.toThrow();
  });
it('refuses missing same-bank fee observations without inferring a signature-count fee formula', async () => {
  const f = fixture();
  Reflect.deleteProperty(f.packets[0], 'expectedFeeLamports');
  await expect(verifyJitoBundleSimulationFrames(f)).rejects.toThrow();
});
it('reports requested privileges only and retains false runtime privilege authority', async () => {
  const f = fixture();
  const admitted = await verifyJitoBundleSimulationFrames(f);
  expect(admitted.runtimePrivilegesVerified).toBe(false);
  expect(admitted.frames[0]).toMatchObject({
    requestedWritable: [true, false, false, true, false],
    requestedReadonly: [false, true, true, false, true],
    expectedFeeLamports: '10000',
  });
  expect(admitted.frames[0]).not.toHaveProperty('writable');
  expect(admitted.frames[0]).not.toHaveProperty('readonly');
  expect(
    (
      await buildJitoBundleSimulationRequest(f.packets, 101, {
        verifySignatures: false,
        bankEncoding: 'slot-object',
      })
    ).runtimePrivilegesVerified,
  ).toBe(false);
});
it('rejects enormous sparse arrays and excessive own-property counts before descriptor traversal', async () => {
  const f = fixture();
  Object.assign(f.result, {
    padding: Object.assign([], { length: 0xffffffff }),
  });
  await expect(verifyJitoBundleSimulationFrames(f)).rejects.toThrow(
    'invalid array',
  );
  const g = fixture();
  Object.assign(g.result, {
    padding: Object.fromEntries(
      Array.from({ length: 20002 }, (_, i) => [String(i), null]),
    ),
  });
  await expect(verifyJitoBundleSimulationFrames(g)).rejects.toThrow(
    'wrapper complexity bound',
  );
});

it('rejects comma-joined field-name collisions before account decoding', async () => {
  const f = fixture();
  const a = f.result.value.transactionResults[0].preExecutionAccounts[0]!;
  Reflect.deleteProperty(a, 'lamports');
  Reflect.deleteProperty(a, 'owner');
  Object.assign(a, { 'lamports,owner': 'not two fields' });
  await expect(verifyJitoBundleSimulationFrames(f)).rejects.toThrow(
    'unexpected fields',
  );
});
for (const absent of [true, false])
  it(
    'refuses success frames with a ' +
      (absent ? 'missing' : 'nonexecutable') +
      ' invoked program',
    async () => {
      const f = fixture();
      f.result.value.transactionResults[0].preExecutionAccounts[2] = absent
        ? null
        : account('1');
      f.result.value.transactionResults[0].postExecutionAccounts[2] = absent
        ? null
        : account('1');
      await expect(verifyJitoBundleSimulationFrames(f)).rejects.toThrow(
        'invoked program must exist and remain executable',
      );
    },
  );
