import { expect, it } from 'vitest';
import bs58 from 'bs58';
import {
  buildJitoCpmmBankAnchor,
  inspectJitoCpmmBankAnchor,
} from './jito-cpmm-bank-anchor';
import { verifyJitoBundleSimulationFrames } from './jito-bundle-simulation-frames';
import { solanaTransferMessage } from './solana-transfer-message';
const payer = bs58.encode(new Uint8Array(32).fill(1)),
  tip = bs58.encode(new Uint8Array(32).fill(2)),
  blockhash = bs58.encode(new Uint8Array(32).fill(3));
async function fixture() {
  const raw = (
    data: Buffer,
    owner = '11111111111111111111111111111111',
    lamports = '10000000',
    executable = false,
  ) => ({
    owner,
    lamports,
    executable,
    data: [Buffer.from(data).toString('base64'), 'base64'],
  });
  const clock = Buffer.alloc(40);
  clock.writeBigUInt64LE(101n);
  clock.writeBigInt64LE(BigInt(Math.floor(Date.now() / 1000)), 32);
  const rent = Buffer.alloc(17);
  rent.writeBigUInt64LE(3480n);
  rent.writeDoubleLE(2, 8);
  rent[16] = 50;
  const pre = [
    raw(Buffer.alloc(0)),
    raw(Buffer.alloc(0)),
    raw(
      Buffer.from('system_program'),
      'NativeLoader1111111111111111111111111111111',
      '1',
      true,
    ),
    raw(clock, 'Sysvar1111111111111111111111111111111111111', '1'),
    raw(rent, 'Sysvar1111111111111111111111111111111111111', '1'),
  ];
  const post = structuredClone(pre);
  post[0].lamports = '9995000';
  const second = structuredClone(post.slice(0, 3)),
    ending = structuredClone(second);
  ending[0].lamports = '9989000';
  ending[1].lamports = '10001000';
  const transactions = [
    buildJitoCpmmBankAnchor(payer, tip, blockhash),
    Buffer.concat([
      Buffer.from([1]),
      Buffer.alloc(64),
      Buffer.from(solanaTransferMessage(payer, tip, blockhash, 1000n)),
    ]).toString('base64'),
  ];
  const row = (
    preExecutionAccounts: typeof pre,
    postExecutionAccounts: typeof pre,
  ) => ({
    err: null,
    preExecutionAccounts,
    postExecutionAccounts,
    fee: '5000',
    unitsConsumed: 150,
    loadedAccountsDataSize: '1000',
  });
  const frames = await verifyJitoBundleSimulationFrames({
    minimumSlot: 100,
    simulationBankSlot: 101,
    packets: transactions.map((transaction) => ({
      transaction,
      loadedAddresses: null,
      expectedFeeLamports: '5000',
      maximumFeeLamports: '20000',
    })),
    result: {
      context: { slot: 101 },
      value: {
        summary: 'succeeded',
        transactionResults: [row(pre, post), row(second, ending)],
      },
    },
  });
  return frames.frames[0];
}
it('checks a canonical unsigned zero transfer and exposes actually returned bank sysvars', async () => {
  const frame = await fixture();
  const result = inspectJitoCpmmBankAnchor(
    frame,
    { payer, tip, blockhash },
    101,
  );
  expect(result.slot).toBe(101);
  expect(result.before).toEqual(result.after);
  expect(result.before.map((x) => x.dataBase64)).toEqual(
    frame.preAccounts
      .slice(3)
      .map((x) => Buffer.from(x!.data).toString('base64')),
  );
});
for (const kind of [
  'context',
  'clock-ahead',
  'rent',
  'tip-credit',
  'payer-debit',
  'packet',
  'readonly',
  'post-clock',
] as const) {
  it(`refuses changed ${kind} anchor evidence`, async () => {
    const f = await fixture();
    let slot = 101;
    if (kind === 'context') slot = 102;
    if (kind === 'clock-ahead') {
      const c = Buffer.from(f.preAccounts[3]!.data);
      c.writeBigUInt64LE(102n);
      f.preAccounts[3]!.data = c;
      f.postAccounts[3]!.data = c;
    }
    if (kind === 'rent') {
      f.preAccounts[4]!.data = new Uint8Array(17);
      f.postAccounts[4]!.data = new Uint8Array(17);
    }
    if (kind === 'tip-credit') f.postAccounts[1]!.lamports = '10000001';
    if (kind === 'payer-debit') f.postAccounts[0]!.lamports = '9994999';
    if (kind === 'packet') {
      const bytes = Buffer.from(f.transaction, 'base64');
      bytes[1] = 1;
      f.transaction = bytes.toString('base64');
    }
    if (kind === 'readonly') f.requestedWritable[3] = true;
    if (kind === 'post-clock') f.postAccounts[3]!.lamports = '2';
    expect(() =>
      inspectJitoCpmmBankAnchor(f, { payer, tip, blockhash }, slot),
    ).toThrow();
  });
}
