import { describe, expect, it } from 'vitest';
import { address, getProgramDerivedAddress } from '@solana/kit';
import bs58 from 'bs58';
import { inspectJitoCpmmCandidateInstruction } from './jito-cpmm-candidate-instruction';

const PROGRAM = 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C';
const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const ATA = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const pub = (i: number) => bs58.encode(new Uint8Array(32).fill(i));
async function candidate() {
  const payer = pub(1),
    inputMint = pub(2),
    outputMint = pub(3);
  const [authority] = await getProgramDerivedAddress({
    programAddress: address(PROGRAM),
    seeds: [new TextEncoder().encode('vault_and_lp_mint_auth_seed')],
  });
  const [input] = await getProgramDerivedAddress({
    programAddress: address(ATA),
    seeds: [bs58.decode(payer), bs58.decode(TOKEN), bs58.decode(inputMint)],
  });
  const [output] = await getProgramDerivedAddress({
    programAddress: address(ATA),
    seeds: [bs58.decode(payer), bs58.decode(TOKEN), bs58.decode(outputMint)],
  });
  const accounts = [
    payer,
    authority,
    pub(4),
    pub(5),
    input,
    output,
    pub(6),
    pub(7),
    TOKEN,
    TOKEN,
    inputMint,
    outputMint,
    pub(8),
  ].map((address, i) => ({
    address,
    signer: i === 0,
    writable: [0, 3, 4, 5, 6, 7, 12].includes(i),
  }));
  const bytes = Buffer.alloc(24);
  Buffer.from('8fbe5adac41e33de', 'hex').copy(bytes);
  bytes.writeBigUInt64LE(123n, 8);
  bytes.writeBigUInt64LE(100n, 16);
  return {
    program: PROGRAM,
    dataHex: bytes.toString('hex'),
    accounts,
    expected: {
      payer,
      inputMint,
      outputMint,
      inputRaw: '123',
      minimumOutputRaw: '100',
    },
  };
}
describe('Raydium CPMM candidate instruction inspection', () => {
  it.each(Array.from({ length: 13 }, (_, i) => i))(
    'refuses the executable program in account role %s',
    async (i) => {
      const value = await candidate();
      value.accounts[i].address = PROGRAM;
      await expect(inspectJitoCpmmCandidateInstruction(value)).rejects.toThrow(
        'refused',
      );
    },
  );
  it('binds the exact amounts, payer, canonical ATAs and program authority without granting execution', async () => {
    const value = await inspectJitoCpmmCandidateInstruction(await candidate());
    expect(value).toMatchObject({
      inputRaw: '123',
      minimumOutputRaw: '100',
      instructionShapeChecked: true,
      sourceAuthenticated: false,
      programApproved: false,
      packetVerified: false,
      accountStateVerified: false,
      priceVerified: false,
      economicOutputVerified: false,
      providerQualified: false,
      signingAllowed: false,
      executionAllowed: false,
    });
  });
  it.each([
    [
      'program',
      (v: Awaited<ReturnType<typeof candidate>>) => {
        v.program = pub(9);
      },
    ],
    [
      'unknown discriminator',
      (v: Awaited<ReturnType<typeof candidate>>) => {
        v.dataHex = '00' + v.dataHex.slice(2);
      },
    ],
    [
      'extra instruction byte',
      (v: Awaited<ReturnType<typeof candidate>>) => {
        v.dataHex += '00';
      },
    ],
    [
      'uppercase/noncanonical hex',
      (v: Awaited<ReturnType<typeof candidate>>) => {
        v.dataHex = v.dataHex.toUpperCase();
      },
    ],
    [
      'missing account',
      (v: Awaited<ReturnType<typeof candidate>>) => {
        v.accounts.pop();
      },
    ],
    [
      'payer mismatch',
      (v: Awaited<ReturnType<typeof candidate>>) => {
        v.expected.payer = pub(9);
      },
    ],
    [
      'no signature',
      (v: Awaited<ReturnType<typeof candidate>>) => {
        v.accounts[0].signer = false;
      },
    ],
    [
      'unexpected signer',
      (v: Awaited<ReturnType<typeof candidate>>) => {
        v.accounts[2].signer = true;
      },
    ],
    [
      'read-only vault',
      (v: Awaited<ReturnType<typeof candidate>>) => {
        v.accounts[6].writable = false;
      },
    ],
    [
      'writable mint',
      (v: Awaited<ReturnType<typeof candidate>>) => {
        v.accounts[10].writable = true;
      },
    ],
    [
      'wrong authority PDA',
      (v: Awaited<ReturnType<typeof candidate>>) => {
        v.accounts[1].address = pub(9);
      },
    ],
    [
      'wrong source ATA',
      (v: Awaited<ReturnType<typeof candidate>>) => {
        v.accounts[4].address = pub(9);
      },
    ],
    [
      'wrong destination ATA',
      (v: Awaited<ReturnType<typeof candidate>>) => {
        v.accounts[5].address = pub(9);
      },
    ],
    [
      'repeated vault',
      (v: Awaited<ReturnType<typeof candidate>>) => {
        v.accounts[7].address = v.accounts[6].address;
      },
    ],
    [
      'unsupported token program',
      (v: Awaited<ReturnType<typeof candidate>>) => {
        v.accounts[9].address = pub(9);
      },
    ],
    [
      'swapped mint',
      (v: Awaited<ReturnType<typeof candidate>>) => {
        v.accounts[10].address = v.expected.outputMint;
      },
    ],
    [
      'different input',
      (v: Awaited<ReturnType<typeof candidate>>) => {
        v.expected.inputRaw = '124';
      },
    ],
    [
      'different minimum output',
      (v: Awaited<ReturnType<typeof candidate>>) => {
        v.expected.minimumOutputRaw = '101';
      },
    ],
    [
      'zero minimum',
      (v: Awaited<ReturnType<typeof candidate>>) => {
        v.expected.minimumOutputRaw = '0';
      },
    ],
    [
      'overflow',
      (v: Awaited<ReturnType<typeof candidate>>) => {
        v.expected.inputRaw = '18446744073709551616';
      },
    ],
    [
      'noncanonical amount',
      (v: Awaited<ReturnType<typeof candidate>>) => {
        v.expected.inputRaw = '0123';
      },
    ],
  ])('refuses %s', async (_name, alter) => {
    const value = await candidate();
    alter(value);
    await expect(inspectJitoCpmmCandidateInstruction(value)).rejects.toThrow(
      'refused',
    );
  });
  it('refuses getters without invoking them', async () => {
    const value = await candidate();
    let invoked = false;
    Object.defineProperty(value.expected, 'inputRaw', {
      enumerable: true,
      get() {
        invoked = true;
        return '123';
      },
    });
    await expect(inspectJitoCpmmCandidateInstruction(value)).rejects.toThrow();
    expect(invoked).toBe(false);
  });
  it('snapshots all input before an asynchronous PDA check', async () => {
    const value = await candidate();
    const pending = inspectJitoCpmmCandidateInstruction(value);
    value.expected.inputRaw = '999';
    value.accounts[4].address = pub(9);
    const result = await pending;
    expect(result.inputRaw).toBe('123');
    expect(result.signingAllowed).toBe(false);
  });
});

// Raw-wire fixture intentionally avoids using the production encoder.
it('binds candidate checks to canonical unsigned packet bytes and rejects packet mutations', async () => {
  const { inspectJitoCpmmUnsignedPacket } =
    await import('./jito-cpmm-unsigned-packet');
  const c = await candidate();
  const writable = c.accounts.filter((a) => a.writable).map((a) => a.address);
  const readonly = [
    ...new Set(c.accounts.filter((a) => !a.writable).map((a) => a.address)),
    PROGRAM,
  ];
  const keys = [...writable, ...readonly];
  const packet = Buffer.from([
    1,
    ...new Uint8Array(64),
    128,
    1,
    0,
    readonly.length,
    keys.length,
    ...keys.flatMap((k) => Array.from(bs58.decode(k))),
    ...new Uint8Array(32),
    1,
    keys.indexOf(PROGRAM),
    13,
    ...c.accounts.map((a) => keys.indexOf(a.address)),
    24,
    ...Buffer.from(c.dataHex, 'hex'),
    0,
  ]);
  const result = await inspectJitoCpmmUnsignedPacket({
    transaction: packet.toString('base64'),
    expected: c.expected,
  });
  expect(result.instructionBoundToPacket).toBe(true);
  expect(result.signingAllowed).toBe(false);
  expect(result.packetVerified).toBe(false);
  expect(result.transactionSha256).toMatch(/^[a-f0-9]{64}$/);
  for (const mutate of [
    (b: Uint8Array) => {
      b[1] = 1;
    },
    (b: Uint8Array) => {
      b[66] = 2;
    },
    (b: Uint8Array) => {
      b[67] = 1;
    },
  ]) {
    const bad = Uint8Array.from(packet);
    mutate(bad);
    await expect(
      inspectJitoCpmmUnsignedPacket({
        transaction: Buffer.from(bad).toString('base64'),
        expected: c.expected,
      }),
    ).rejects.toThrow();
  }
  await expect(
    inspectJitoCpmmUnsignedPacket({
      transaction: Buffer.concat([packet, Buffer.from([0])]).toString('base64'),
      expected: c.expected,
    }),
  ).rejects.toThrow();
  await expect(
    inspectJitoCpmmUnsignedPacket({
      transaction: packet.toString('base64'),
      expected: { ...c.expected, inputRaw: '124' },
    }),
  ).rejects.toThrow();
});
