import { expect, it } from 'vitest';
import {
  address,
  blockhash,
  createNoopSigner,
  createTransactionMessage,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstructions,
  compileTransactionMessage,
  getCompiledTransactionMessageEncoder,
  getTransactionEncoder,
  type TransactionMessageBytes,
  type Instruction,
} from '@solana/kit';
import {
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from '@solana-program/token';
import bs58 from 'bs58';
import {
  inspectJitoCpmmAtaSetupPacket,
  inspectJitoCpmmAtaRentTransition,
} from './jito-cpmm-ata-setup';
import { inspectJitoCpmmUnsignedPacket } from './jito-cpmm-unsigned-packet';
const WSOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SYSTEM = '11111111111111111111111111111111';
const pub = (i: number) => bs58.encode(new Uint8Array(32).fill(i));
async function fixture(
  mint = USDC,
  mutate?: (ix: Instruction) => Instruction[],
) {
  const payer = createNoopSigner(address(pub(1))),
    hash = blockhash(pub(2));
  const [destination] = await findAssociatedTokenPda({
    owner: payer.address,
    mint: address(mint),
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  });
  const ix = getCreateAssociatedTokenIdempotentInstruction({
    payer,
    ata: destination,
    owner: payer.address,
    mint: address(mint),
  });
  const message = setTransactionMessageFeePayer(
    payer.address,
    createTransactionMessage({ version: 0 }),
  );
  const compiled = compileTransactionMessage(
    appendTransactionMessageInstructions(
      mutate ? mutate(ix) : [ix],
      setTransactionMessageLifetimeUsingBlockhash(
        { blockhash: hash, lastValidBlockHeight: 999n },
        message,
      ),
    ),
  );
  const bytes = getCompiledTransactionMessageEncoder().encode(
    compiled,
  ) as TransactionMessageBytes;
  const signatures = Object.fromEntries(
    compiled.staticAccounts
      .slice(0, compiled.header.numSignerAccounts)
      .map((k) => [k, null]),
  );
  const transaction = Buffer.from(
    getTransactionEncoder().encode({ messageBytes: bytes, signatures }),
  ).toString('base64');
  const raw = (data: Uint8Array, owner: string, lamports: string) => ({
    owner,
    executable: false,
    lamports,
    data: [Buffer.from(data).toString('base64'), 'base64'],
  });
  const rent = Buffer.alloc(17);
  rent.writeBigUInt64LE(5080n);
  rent.writeDoubleLE(1, 8);
  rent[16] = 50;
  const mintData = Buffer.alloc(82);
  mintData[44] = mint === WSOL ? 9 : 6;
  mintData[45] = 1;
  const token = Buffer.alloc(165);
  Buffer.from(bs58.decode(mint)).copy(token, 0);
  Buffer.from(bs58.decode(payer.address)).copy(token, 32);
  token[108] = 1;
  if (mint === WSOL) {
    token.writeUInt32LE(1, 109);
    token.writeBigUInt64LE(1488440n, 113);
  }
  return {
    packet: {
      transaction,
      expected: {
        payer: payer.address as string,
        mint,
        destination: destination as string,
        blockhash: hash as string,
      },
    },
    minimumSlot: 100,
    slot: 102,
    before: {
      payer: raw(Buffer.alloc(0), SYSTEM, '3000000'),
      destination: null as unknown,
    },
    after: {
      payer: raw(Buffer.alloc(0), SYSTEM, '1506560'),
      destination: raw(token, TOKEN_PROGRAM_ADDRESS, '1488440'),
    },
    rentAccount: raw(rent, 'Sysvar1111111111111111111111111111111111111', '1'),
    mintAccount: raw(mintData, TOKEN_PROGRAM_ADDRESS, '1066800'),
    feeLamports: '5000',
    maximumFeeLamports: '10000',
    reserveLamports: '0',
  };
}
it.each([USDC, WSOL])(
  'binds an independently SDK-built ATA packet and actual rent transition for %s',
  async (mint) => {
    const f = await fixture(mint);
    expect(await inspectJitoCpmmAtaSetupPacket(f.packet)).toMatchObject({
      instructionBoundToPacket: true,
      programApproved: false,
      packetVerified: false,
      automaticExecutionAllowed: false,
      signingAllowed: false,
    });
    expect(await inspectJitoCpmmAtaRentTransition(f)).toMatchObject({
      createdRentLamports: '1488440',
      requiredSystemRentLamports: '650240',
      exactPayerDebitChecked: true,
      emptyCanonicalAccountChecked: true,
      bankVerified: false,
      feeBankVerified: false,
      accountProvenanceVerified: false,
      programApproved: false,
      runtimePrivilegesVerified: false,
      signingAllowed: false,
    });
    await expect(
      inspectJitoCpmmUnsignedPacket({
        transaction: f.packet.transaction,
        expected: {
          payer: f.packet.expected.payer,
          inputMint: WSOL,
          outputMint: USDC,
          inputRaw: '1000000',
          minimumOutputRaw: '1',
        },
      }),
    ).rejects.toThrow();
  },
);

it.each([
  'create',
  'nested',
  'extra-data',
  'extra-instruction',
  'program',
  'owner',
  'token2022',
  'mint-writable',
])('refuses %s instruction substitution', async (kind) => {
  const f = await fixture(USDC, (ix) => {
    if (kind === 'extra-instruction') return [ix, ix];
    if (kind === 'create') return [{ ...ix, data: Uint8Array.of(0) }];
    if (kind === 'nested') return [{ ...ix, data: Uint8Array.of(2) }];
    if (kind === 'extra-data') return [{ ...ix, data: Uint8Array.of(1, 0) }];
    if (kind === 'program')
      return [{ ...ix, programAddress: TOKEN_PROGRAM_ADDRESS }];
    const accounts = ix.accounts!.map((a) => ({ ...a }));
    if (kind === 'owner')
      accounts[2] = { ...accounts[2], address: address(pub(9)) };
    if (kind === 'token2022')
      accounts[5] = {
        ...accounts[5],
        address: address('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'),
      };
    if (kind === 'mint-writable') accounts[3] = { ...accounts[3], role: 1 };
    return [{ ...ix, accounts }];
  });
  await expect(inspectJitoCpmmAtaSetupPacket(f.packet)).rejects.toThrow();
});

it('refuses a rebound noncanonical ATA, signatures, changed lifetime and unexpected binding fields', async () => {
  const rebound = await fixture(USDC, (ix) => [
    {
      ...ix,
      accounts: ix.accounts!.map((a, i) =>
        i === 1 ? { ...a, address: address(pub(9)) } : a,
      ),
    },
  ]);
  rebound.packet.expected.destination = pub(9);
  await expect(inspectJitoCpmmAtaSetupPacket(rebound.packet)).rejects.toThrow();
  const f = await fixture();
  const signed = structuredClone(f.packet),
    bytes = Buffer.from(signed.transaction, 'base64');
  bytes[1] = 1;
  signed.transaction = bytes.toString('base64');
  await expect(inspectJitoCpmmAtaSetupPacket(signed)).rejects.toThrow();
  const lifetime = structuredClone(f.packet);
  lifetime.expected.blockhash = pub(3);
  await expect(inspectJitoCpmmAtaSetupPacket(lifetime)).rejects.toThrow();
  Object.assign(f.packet.expected, { bypass: true });
  await expect(inspectJitoCpmmAtaSetupPacket(f.packet)).rejects.toThrow();
});

it.each([
  'existing',
  'amount',
  'delegate',
  'close',
  'frozen',
  'rent',
  'debit',
  'reserve',
  'mint-rent',
  'fee',
  'slot',
])('refuses %s rent/creation evidence', async (kind) => {
  const f = await fixture();
  if (kind === 'existing')
    f.before.destination = structuredClone(f.after.destination);
  if (['amount', 'delegate', 'close', 'frozen'].includes(kind)) {
    const b = Buffer.from(f.after.destination.data[0], 'base64');
    if (kind === 'amount') b.writeBigUInt64LE(1n, 64);
    if (kind === 'delegate') b.writeUInt32LE(1, 72);
    if (kind === 'close') b.writeUInt32LE(1, 129);
    if (kind === 'frozen') b[108] = 2;
    f.after.destination.data[0] = b.toString('base64');
  }
  if (kind === 'rent') f.after.destination.lamports = '1488439';
  if (kind === 'debit') f.before.payer.lamports = '3000001';
  if (kind === 'reserve') {
    f.after.payer.lamports = '650239';
    f.before.payer.lamports = String(650239 + 1488440 + 5000);
  }
  if (kind === 'mint-rent') f.mintAccount.lamports = '1066799';
  if (kind === 'fee') f.maximumFeeLamports = '4999';
  if (kind === 'slot') f.slot = 133;
  await expect(inspectJitoCpmmAtaRentTransition(f)).rejects.toThrow();
});
it('retains the 32-slot edge and snapshots evidence before asynchronous decoding', async () => {
  const f = await fixture();
  f.slot = 132;
  const pending = inspectJitoCpmmAtaRentTransition(f);
  f.after.destination.lamports = '0';
  f.packet.expected.mint = pub(9);
  expect(await pending).toMatchObject({
    slot: 132,
    createdRentLamports: '1488440',
  });
});

it('reserves the declared maximum fee up front, including the exact System rent boundary', async () => {
  const f = await fixture();
  f.before.payer.lamports = '2143680';
  f.after.payer.lamports = '650240';
  await expect(inspectJitoCpmmAtaRentTransition(f)).rejects.toThrow();
  f.maximumFeeLamports = '5000';
  expect(await inspectJitoCpmmAtaRentTransition(f)).toMatchObject({
    requiredSystemRentLamports: '650240',
  });
});

it('refuses a wire space field that contradicts the actual created account size', async () => {
  const f = await fixture();
  Object.assign(f.after.destination, { space: '164' });
  await expect(inspectJitoCpmmAtaRentTransition(f)).rejects.toThrow();
});
