import {
  address,
  getProgramDerivedAddress,
  getTransactionDecoder,
  getTransactionEncoder,
  getCompiledTransactionMessageDecoder,
  getCompiledTransactionMessageEncoder,
} from '@solana/kit';
import bs58 from 'bs58';
import { snapshotJitoEvidence, jitoEvidenceSha256 } from './jito-evidence-json';
import {
  inspectPairRentAccount,
  pairRentMinimumRaw,
} from './pair-rent-evidence';
import { inspectSwapMintAccount } from './swap-token-program-evidence';
const SYSTEM = '11111111111111111111111111111111';
const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const ATA = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const WSOL = 'So11111111111111111111111111111111111111112';
const flags = {
  sourceAuthenticated: false as const,
  bankVerified: false as const,
  providerQualified: false as const,
  programApproved: false as const,
  packetVerified: false as const,
  economicOutputVerified: false as const,
  runtimePrivilegesVerified: false as const,
  automaticExecutionAllowed: false as const,
  signingAllowed: false as const,
  executionAllowed: false as const,
};
const fail = (): never => {
  throw Error('CPMM ATA setup packet or rent transition refused.');
};
type Packet = {
  transaction: string;
  expected: {
    payer: string;
    mint: string;
    destination: string;
    blockhash: string;
  };
};
function exact(
  v: unknown,
  fields: string[],
): asserts v is Record<string, unknown> {
  if (
    !v ||
    typeof v !== 'object' ||
    Array.isArray(v) ||
    Object.keys(v).length !== fields.length ||
    fields.some((k) => !Object.hasOwn(v, k))
  )
    return fail();
}
function uint(v: unknown) {
  if (
    typeof v !== 'string' ||
    !/^(0|[1-9]\d{0,19})$/.test(v) ||
    BigInt(v) > (1n << 64n) - 1n
  )
    return fail();
  return BigInt(v);
}

/** Separate, unsigned setup transaction. Does not broaden the swap-only parser.
 * Only CreateIdempotent with payer=owner, classic Token and no extra instruction. */
export async function inspectJitoCpmmAtaSetupPacket(input: Packet) {
  const value = snapshotJitoEvidence(input, 16384);
  exact(value, ['transaction', 'expected']);
  exact(value.expected, ['payer', 'mint', 'destination', 'blockhash']);
  if (typeof value.transaction !== 'string' || value.transaction.length > 1644)
    return fail();
  const bytes = Buffer.from(value.transaction, 'base64');
  if (
    !bytes.length ||
    bytes.length > 1232 ||
    bytes.toString('base64') !== value.transaction
  )
    return fail();
  const tx = getTransactionDecoder().decode(bytes);
  if (!Buffer.from(getTransactionEncoder().encode(tx)).equals(bytes))
    return fail();
  const m = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
  if (
    m.version !== 0 ||
    !Buffer.from(getCompiledTransactionMessageEncoder().encode(m)).equals(
      Buffer.from(tx.messageBytes),
    ) ||
    m.addressTableLookups?.length ||
    m.instructions.length !== 1 ||
    m.header.numSignerAccounts !== 1 ||
    m.header.numReadonlySignerAccounts !== 0 ||
    m.header.numReadonlyNonSignerAccounts !== 4 ||
    m.staticAccounts.length !== 6 ||
    String(m.lifetimeToken) !== value.expected.blockhash
  )
    return fail();
  const keys = m.staticAccounts.map(String);
  const expectedKeys = [
    value.expected.payer,
    value.expected.destination,
    value.expected.mint,
    SYSTEM,
    TOKEN,
    ATA,
  ];
  if (
    new Set(keys).size !== 6 ||
    new Set(expectedKeys).size !== 6 ||
    keys[0] !== value.expected.payer ||
    keys[1] !== value.expected.destination ||
    keys.some((k) => !expectedKeys.includes(k))
  )
    return fail();
  const sig = Object.entries(tx.signatures);
  if (
    sig.length !== 1 ||
    sig[0][0] !== keys[0] ||
    (sig[0][1] && Array.from(sig[0][1]).some((b) => b !== 0))
  )
    return fail();
  const ix = m.instructions[0];
  if (
    ix.programAddressIndex !== keys.indexOf(ATA) ||
    Buffer.from(ix.data ?? []).toString('hex') !== '01' ||
    JSON.stringify(Array.from(ix.accountIndices ?? [])) !==
      JSON.stringify([
        0,
        1,
        0,
        keys.indexOf(value.expected.mint),
        keys.indexOf(SYSTEM),
        keys.indexOf(TOKEN),
      ])
  )
    return fail();
  const [derived] = await getProgramDerivedAddress({
    programAddress: address(ATA),
    seeds: [
      bs58.decode(value.expected.payer),
      bs58.decode(TOKEN),
      bs58.decode(value.expected.mint),
    ],
  });
  if (derived !== value.expected.destination) return fail();
  return {
    format: 'jito-cpmm-ata-setup-packet-v1' as const,
    ...value.expected,
    transactionSha256: await jitoEvidenceSha256(bytes),
    messageSha256: await jitoEvidenceSha256(Uint8Array.from(tx.messageBytes)),
    instructionBoundToPacket: true as const,
    ...flags,
  };
}

function raw(v: unknown) {
  const a = v as {
    owner?: unknown;
    executable?: unknown;
    lamports?: unknown;
    data?: unknown;
    space?: unknown;
  } | null;
  if (
    !a ||
    typeof a.owner !== 'string' ||
    a.executable !== false ||
    !Array.isArray(a.data) ||
    a.data.length !== 2 ||
    typeof a.data[0] !== 'string' ||
    a.data[1] !== 'base64' ||
    a.data[0].length > 256
  )
    return fail();
  const bytes = Buffer.from(a.data[0], 'base64');
  if (
    bytes.toString('base64') !== a.data[0] ||
    (a.space !== undefined && a.space !== String(bytes.length))
  )
    return fail();
  return { owner: a.owner, lamports: uint(a.lamports), bytes };
}

/** Supplied pre/post images only. The future bundle verifier must bind the
 * complete frame, unchanged readonly accounts, program scans and real transport. */
export async function inspectJitoCpmmAtaRentTransition(input: {
  packet: Packet;
  minimumSlot: number;
  slot: number;
  before: { payer: unknown; destination: unknown };
  after: { payer: unknown; destination: unknown };
  mintAccount: unknown;
  rentAccount: unknown;
  feeLamports: string;
  maximumFeeLamports: string;
  reserveLamports: string;
}) {
  const value = snapshotJitoEvidence(input, 32768);
  exact(value, [
    'packet',
    'minimumSlot',
    'slot',
    'before',
    'after',
    'mintAccount',
    'rentAccount',
    'feeLamports',
    'maximumFeeLamports',
    'reserveLamports',
  ]);
  exact(value.before, ['payer', 'destination']);
  exact(value.after, ['payer', 'destination']);
  if (
    !Number.isSafeInteger(value.minimumSlot) ||
    value.minimumSlot < 0 ||
    !Number.isSafeInteger(value.slot) ||
    value.slot < value.minimumSlot ||
    value.slot - value.minimumSlot > 32 ||
    value.before.destination !== null
  )
    return fail();
  const bound = await inspectJitoCpmmAtaSetupPacket(value.packet);
  const rent = inspectPairRentAccount(value.rentAccount);
  const minimum = BigInt(pairRentMinimumRaw(rent, 165)),
    systemMinimum = BigInt(pairRentMinimumRaw(rent, 0));
  const mint = await inspectSwapMintAccount(value.mintAccount, bound.mint);
  const mintRaw = raw(value.mintAccount);
  if (
    mint.program !== TOKEN ||
    mintRaw.bytes.length !== 82 ||
    mintRaw.lamports < BigInt(pairRentMinimumRaw(rent, 82))
  )
    return fail();
  const before = raw(value.before.payer),
    after = raw(value.after.payer),
    destination = raw(value.after.destination);
  const fee = uint(value.feeLamports),
    maximumFee = uint(value.maximumFeeLamports),
    reserve = uint(value.reserveLamports);
  if (
    before.owner !== SYSTEM ||
    after.owner !== SYSTEM ||
    before.bytes.length ||
    after.bytes.length ||
    !fee ||
    fee > maximumFee ||
    maximumFee > 10000000n ||
    before.lamports <
      minimum +
        maximumFee +
        (reserve > systemMinimum ? reserve : systemMinimum) ||
    after.lamports < (reserve > systemMinimum ? reserve : systemMinimum) ||
    before.lamports - after.lamports !== fee + minimum ||
    destination.owner !== TOKEN ||
    destination.bytes.length !== 165 ||
    destination.lamports !== minimum
  )
    return fail();
  const expected = Buffer.alloc(165);
  Buffer.from(bs58.decode(bound.mint)).copy(expected, 0);
  Buffer.from(bs58.decode(bound.payer)).copy(expected, 32);
  expected[108] = 1;
  if (bound.mint === WSOL) {
    expected.writeUInt32LE(1, 109);
    expected.writeBigUInt64LE(minimum, 113);
  }
  if (!destination.bytes.equals(expected)) return fail();
  return {
    format: 'jito-cpmm-ata-setup-rent-v1' as const,
    slot: value.slot,
    transactionSha256: bound.transactionSha256,
    destination: bound.destination,
    payer: bound.payer,
    mint: bound.mint,
    mintPolicySha256: mint.policySha256,
    requiredMintRentLamports: pairRentMinimumRaw(rent, 82),
    createdAccountBytes: 165 as const,
    createdRentLamports: minimum.toString(),
    feeLamports: fee.toString(),
    maximumFeeLamports: maximumFee.toString(),
    reserveLamports: reserve.toString(),
    remainingLamports: after.lamports.toString(),
    requiredSystemRentLamports: systemMinimum.toString(),
    exactPayerDebitChecked: true as const,
    emptyCanonicalAccountChecked: true as const,
    feeBankVerified: false as const,
    accountProvenanceVerified: false as const,
    ...flags,
  };
}
