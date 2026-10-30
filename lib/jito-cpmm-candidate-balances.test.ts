import { describe, expect, it } from 'vitest';
import { address, getProgramDerivedAddress } from '@solana/kit';
import bs58 from 'bs58';
import { inspectJitoCpmmCandidateBalanceTransition } from './jito-cpmm-candidate-balances';
const PROGRAM = 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C';
const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const ATA = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const WSOL = 'So11111111111111111111111111111111111111112';
const pub = (i: number) => bs58.encode(new Uint8Array(32).fill(i));
async function fixture(native = false) {
  const payer = pub(1),
    inputMint = native ? WSOL : pub(2),
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
  const data = Buffer.alloc(24);
  Buffer.from('8fbe5adac41e33de', 'hex').copy(data);
  data.writeBigUInt64LE(123n, 8);
  data.writeBigUInt64LE(100n, 16);
  const instruction = {
    program: PROGRAM,
    dataHex: data.toString('hex'),
    accounts,
    expected: {
      payer,
      inputMint,
      outputMint,
      inputRaw: '123',
      minimumOutputRaw: '100',
    },
  };
  function account(id: string, mint: string, owner: string, amount: bigint) {
    const data = Buffer.alloc(165);
    Buffer.from(bs58.decode(mint)).copy(data, 0);
    Buffer.from(bs58.decode(owner)).copy(data, 32);
    data.writeBigUInt64LE(amount, 64);
    data[108] = 1;
    const isNative = mint === WSOL;
    if (isNative) {
      data.writeUInt32LE(1, 109);
      data.writeBigUInt64LE(2000n, 113);
    }
    return {
      address: id,
      owner: TOKEN,
      dataBase64: data.toString('base64'),
      lamports: (isNative ? amount + 2000n : 2000n).toString(),
      executable: false,
    };
  }
  const create = (values: bigint[]) => [
    account(input, inputMint, payer, values[0]),
    account(output, outputMint, payer, values[1]),
    account(pub(6), inputMint, authority, values[2]),
    account(pub(7), outputMint, authority, values[3]),
  ];
  return {
    instruction,
    before: create([500n, 5n, 10000n, 10000n]),
    after: create([377n, 115n, 10123n, 9890n]),
  };
}
type Case = Awaited<ReturnType<typeof fixture>>;
function mutate(
  a: Case['before'][number],
  fn: (bytes: ReturnType<typeof Buffer.from>) => void,
) {
  const bytes = Buffer.from(a.dataBase64, 'base64');
  fn(bytes);
  a.dataBase64 = bytes.toString('base64');
}
describe('CPMM candidate SPL balance transition', () => {
  it.each([false, true])(
    'checks exact token conservation including native=%s without granting authority',
    async (native) => {
      const result = await inspectJitoCpmmCandidateBalanceTransition(
        await fixture(native),
      );
      expect(result).toMatchObject({
        inputRaw: '123',
        outputRaw: '110',
        sourceAuthenticated: false,
        programApproved: false,
        packetVerified: false,
        accountProvenanceVerified: false,
        priceVerified: false,
        bankVerified: false,
        economicOutputVerified: false,
        providerQualified: false,
        signingAllowed: false,
        executionAllowed: false,
      });
    },
  );
  it.each([
    [
      'source over-debit',
      (v: Case) => mutate(v.after[0], (b) => b.writeBigUInt64LE(376n, 64)),
    ],
    [
      'vault under-credit',
      (v: Case) => mutate(v.after[2], (b) => b.writeBigUInt64LE(10122n, 64)),
    ],
    [
      'output below minimum',
      (v: Case) => {
        mutate(v.after[1], (b) => b.writeBigUInt64LE(104n, 64));
        mutate(v.after[3], (b) => b.writeBigUInt64LE(9901n, 64));
      },
    ],
    [
      'output vault differs',
      (v: Case) => mutate(v.after[3], (b) => b.writeBigUInt64LE(9891n, 64)),
    ],
    [
      'wrong vault mint',
      (v: Case) =>
        mutate(v.before[2], (b) => Buffer.from(bs58.decode(pub(9))).copy(b, 0)),
    ],
    [
      'wrong vault authority',
      (v: Case) =>
        mutate(v.before[2], (b) =>
          Buffer.from(bs58.decode(pub(9))).copy(b, 32),
        ),
    ],
    [
      'frozen account',
      (v: Case) =>
        mutate(v.before[0], (b) => {
          b[108] = 2;
        }),
    ],
    [
      'delegate',
      (v: Case) => mutate(v.before[0], (b) => b.writeUInt32LE(1, 72)),
    ],
    [
      'changed owner in post state',
      (v: Case) =>
        mutate(v.after[1], (b) => Buffer.from(bs58.decode(pub(9))).copy(b, 32)),
    ],
    [
      'non-native lamport drift',
      (v: Case) => {
        v.after[0].lamports = '2001';
      },
    ],
    [
      'wrong token program',
      (v: Case) => {
        v.before[0].owner = pub(9);
      },
    ],
    [
      'executable token account',
      (v: Case) => {
        v.before[0].executable = true;
      },
    ],
    [
      'noncanonical base64',
      (v: Case) => {
        v.before[0].dataBase64 += '=';
      },
    ],
    [
      'wrong account order',
      (v: Case) => {
        [v.before[0], v.before[1]] = [v.before[1], v.before[0]];
      },
    ],
    [
      'missing account',
      (v: Case) => {
        v.after.pop();
      },
    ],
  ])('refuses %s', async (_name, alter) => {
    const value = await fixture();
    alter(value);
    await expect(
      inspectJitoCpmmCandidateBalanceTransition(value),
    ).rejects.toThrow('refused');
  });
  it('refuses mismatched native reserve and lamports', async () => {
    const value = await fixture(true);
    value.after[0].lamports = '1';
    await expect(
      inspectJitoCpmmCandidateBalanceTransition(value),
    ).rejects.toThrow('refused');
  });
  it('snapshots both instruction and account states before asynchronous work', async () => {
    const value = await fixture();
    const pending = inspectJitoCpmmCandidateBalanceTransition(value);
    value.after[0].lamports = '1';
    value.instruction.expected.minimumOutputRaw = '999';
    expect((await pending).outputRaw).toBe('110');
  });
});
