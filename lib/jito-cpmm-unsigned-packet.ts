import {
  getTransactionDecoder,
  getTransactionEncoder,
  getCompiledTransactionMessageDecoder,
  getCompiledTransactionMessageEncoder,
} from '@solana/kit';
import { snapshotJitoEvidence, jitoEvidenceSha256 } from './jito-evidence-json';
import { inspectJitoCpmmCandidateInstruction } from './jito-cpmm-candidate-instruction';
const fail = (): never => {
  throw Error('CPMM unsigned packet refused.');
};
/** Narrow packet profile: one unsigned v0 swap, existing ATAs, no lookups or auxiliary instructions. */
export async function inspectJitoCpmmUnsignedPacket(input: {
  transaction: string;
  expected: Parameters<
    typeof inspectJitoCpmmCandidateInstruction
  >[0]['expected'];
}) {
  const value = snapshotJitoEvidence(input, 16384);
  if (
    !value ||
    Object.keys(value).length !== 2 ||
    !Object.hasOwn(value, 'expected') ||
    typeof value.transaction !== 'string' ||
    value.transaction.length > 1644
  )
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
  const message = getCompiledTransactionMessageDecoder().decode(
    tx.messageBytes,
  );
  if (
    message.version !== 0 ||
    !Buffer.from(getCompiledTransactionMessageEncoder().encode(message)).equals(
      Buffer.from(tx.messageBytes),
    ) ||
    message.addressTableLookups?.length ||
    message.instructions.length !== 1
  )
    return fail();
  const keys = message.staticAccounts.map(String),
    h = message.header;
  if (
    h.numSignerAccounts !== 1 ||
    h.numReadonlySignerAccounts !== 0 ||
    h.numReadonlyNonSignerAccounts < 1 ||
    h.numReadonlyNonSignerAccounts > keys.length - 1 ||
    new Set(keys).size !== keys.length ||
    keys[0] !== value.expected.payer
  )
    return fail();
  const signatures = Object.entries(tx.signatures);
  if (
    signatures.length !== 1 ||
    signatures[0][0] !== keys[0] ||
    (signatures[0][1] && Array.from(signatures[0][1]).some((b) => b !== 0))
  )
    return fail();
  const ix = message.instructions[0],
    indices = Array.from(ix.accountIndices ?? []);
  const writable = (i: number) =>
    i < keys.length - h.numReadonlyNonSignerAccounts;
  if (
    ix.programAddressIndex < 1 ||
    ix.programAddressIndex >= keys.length ||
    writable(ix.programAddressIndex) ||
    indices.some((i) => i < 0 || i >= keys.length) ||
    new Set([ix.programAddressIndex, ...indices]).size !== keys.length
  )
    return fail();
  const inspected = await inspectJitoCpmmCandidateInstruction({
    program: keys[ix.programAddressIndex],
    dataHex: Buffer.from(ix.data ?? []).toString('hex'),
    accounts: indices.map((i) => ({
      address: keys[i],
      signer: i === 0,
      writable: writable(i),
    })),
    expected: value.expected,
  });
  return {
    ...inspected,
    format: 'jito-cpmm-unsigned-packet-v1' as const,
    transactionSha256: await jitoEvidenceSha256(bytes),
    messageSha256: await jitoEvidenceSha256(Uint8Array.from(tx.messageBytes)),
    blockhash: String(message.lifetimeToken),
    instructionBoundToPacket: true as const,
  };
}
