import bs58 from 'bs58';
import { snapshotJitoEvidence } from './jito-evidence-json';
import { inspectJitoCpmmCandidateInstruction } from './jito-cpmm-candidate-instruction';

const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const WSOL = 'So11111111111111111111111111111111111111112';
const U64 = (1n << 64n) - 1n;
type RawAccount = {
  address: string;
  owner: string;
  dataBase64: string;
  lamports: string;
  executable: boolean;
};
type InspectionInput = Parameters<
  typeof inspectJitoCpmmCandidateInstruction
>[0];
const fail = (): never => {
  throw Error('CPMM candidate balance transition refused.');
};
const integer = (v: unknown) => {
  if (typeof v !== 'string' || !/^(0|[1-9]\d{0,19})$/.test(v)) return fail();
  const n = BigInt(v);
  if (n > U64) return fail();
  return n;
};
function decode(
  raw: RawAccount,
  expected: { address: string; mint: string; authority: string },
) {
  if (
    !raw ||
    typeof raw !== 'object' ||
    Array.isArray(raw) ||
    Object.keys(raw).length !== 5 ||
    !['address', 'owner', 'dataBase64', 'lamports', 'executable'].every((k) =>
      Object.hasOwn(raw, k),
    ) ||
    raw.address !== expected.address ||
    raw.owner !== TOKEN ||
    raw.executable !== false ||
    typeof raw.dataBase64 !== 'string' ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      raw.dataBase64,
    )
  )
    return fail();
  const bytes = Buffer.from(raw.dataBase64, 'base64');
  if (
    bytes.length !== 165 ||
    bytes.toString('base64') !== raw.dataBase64 ||
    bs58.encode(bytes.subarray(0, 32)) !== expected.mint ||
    bs58.encode(bytes.subarray(32, 64)) !== expected.authority ||
    bytes.readUInt32LE(72) !== 0 ||
    bytes[108] !== 1 ||
    bytes.readBigUInt64LE(121) !== 0n ||
    bytes.readUInt32LE(129) !== 0
  )
    return fail();
  const balance: bigint = bytes.readBigUInt64LE(64),
    lamports = integer(raw.lamports),
    native = bytes.readUInt32LE(109);
  if (expected.mint === WSOL) {
    if (native !== 1 || bytes.readBigUInt64LE(113) + balance !== lamports)
      return fail();
  } else if (native !== 0) return fail();
  return { bytes, balance, lamports, native };
}
/** Diagnostic over supplied data only; no evidence of provenance or bank identity. */
export async function inspectJitoCpmmCandidateBalanceTransition(input: {
  instruction: InspectionInput;
  before: RawAccount[];
  after: RawAccount[];
}) {
  // Snapshot both inputs before awaiting PDA derivation.
  const copied = snapshotJitoEvidence(input, 16384);
  if (
    !copied ||
    typeof copied !== 'object' ||
    Object.keys(copied).length !== 3 ||
    !['instruction', 'before', 'after'].every((k) =>
      Object.hasOwn(copied, k),
    ) ||
    !Array.isArray(copied.before) ||
    !Array.isArray(copied.after) ||
    copied.before.length !== 4 ||
    copied.after.length !== 4
  )
    return fail();
  const instruction = await inspectJitoCpmmCandidateInstruction(
    copied.instruction,
  );
  const expected = [
    {
      address: instruction.source,
      mint: instruction.inputMint,
      authority: instruction.payer,
    },
    {
      address: instruction.destination,
      mint: instruction.outputMint,
      authority: instruction.payer,
    },
    {
      address: instruction.inputVault,
      mint: instruction.inputMint,
      authority: instruction.authority,
    },
    {
      address: instruction.outputVault,
      mint: instruction.outputMint,
      authority: instruction.authority,
    },
  ];
  const pre = expected.map((e, i) => decode(copied.before[i], e));
  const post = expected.map((e, i) => decode(copied.after[i], e));
  for (let i = 0; i < 4; i++) {
    if (
      !pre[i].bytes.subarray(0, 64).equals(post[i].bytes.subarray(0, 64)) ||
      !pre[i].bytes.subarray(72).equals(post[i].bytes.subarray(72)) ||
      (!pre[i].native && pre[i].lamports !== post[i].lamports)
    )
      return fail();
  }
  const inputRaw = BigInt(instruction.inputRaw),
    output = post[1].balance - pre[1].balance;
  if (
    pre[0].balance - post[0].balance !== inputRaw ||
    post[2].balance - pre[2].balance !== inputRaw ||
    output < BigInt(instruction.minimumOutputRaw) ||
    pre[3].balance - post[3].balance !== output
  )
    return fail();
  return {
    format: 'jito-cpmm-candidate-balances-v1' as const,
    inputRaw: inputRaw.toString(),
    outputRaw: output.toString(),
    sourceAuthenticated: false as const,
    programApproved: false as const,
    packetVerified: false as const,
    accountProvenanceVerified: false as const,
    priceVerified: false as const,
    bankVerified: false as const,
    economicOutputVerified: false as const,
    providerQualified: false as const,
    signingAllowed: false as const,
    executionAllowed: false as const,
  };
}
