import {
  getBase64Encoder,
  getBase64Decoder,
  getTransactionDecoder,
  getTransactionEncoder,
  getCompiledTransactionMessageDecoder,
  getCompiledTransactionMessageEncoder,
} from '@solana/kit';
import { reviewSwapInstructions } from './swap-instruction-review';
/** Canonical unsigned v0 packet inspection, independent of provider fee metadata. */
export async function reviewUnsignedSwapEnvelope(
  transaction: unknown,
  wallet: string,
) {
  const fail = () => {
    throw new Error('Unsupported unsigned swap order.');
  };
  if (
    typeof transaction !== 'string' ||
    transaction.length > 1644 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      transaction,
    )
  )
    fail();
  const bytes = getBase64Encoder().encode(transaction as string);
  if (
    !bytes.length ||
    bytes.length > 1232 ||
    getBase64Decoder().decode(bytes) !== transaction
  )
    fail();
  const tx = getTransactionDecoder().decode(bytes);
  const encoded = getTransactionEncoder().encode(tx);
  if (encoded.length !== bytes.length || encoded.some((v, i) => v !== bytes[i]))
    fail();
  const message = getCompiledTransactionMessageDecoder().decode(
    tx.messageBytes,
  );
  if (message.version !== 0)
    throw new Error('Unsupported unsigned swap version.');
  const canonicalMessage =
    getCompiledTransactionMessageEncoder().encode(message);
  if (
    canonicalMessage.length !== tx.messageBytes.length ||
    canonicalMessage.some((value, index) => value !== tx.messageBytes[index])
  )
    fail();
  if (
    message.header.numSignerAccounts !== 1 ||
    message.header.numReadonlySignerAccounts !== 0 ||
    message.header.numReadonlyNonSignerAccounts >
      message.staticAccounts.length - 1 ||
    new Set(message.staticAccounts).size !== message.staticAccounts.length ||
    message.staticAccounts[0] !== wallet ||
    !message.instructions.length ||
    Object.keys(tx.signatures).length !== 1 ||
    Object.values(tx.signatures).some(
      (sig) => sig !== null && new Uint8Array(sig).some((v) => v !== 0),
    )
  )
    fail();
  const lookups = message.addressTableLookups ?? [];
  const accountCount =
    message.staticAccounts.length +
    lookups.reduce(
      (n, l) => n + l.readonlyIndexes.length + l.writableIndexes.length,
      0,
    );
  if (
    accountCount > 256 ||
    message.instructions.some(
      (i) =>
        i.programAddressIndex >= accountCount ||
        i.accountIndices?.some((index) => index >= accountCount),
    )
  )
    fail();
  const digest = await crypto.subtle.digest(
    'SHA-256',
    Uint8Array.from(bytes).buffer,
  );
  return {
    executionAllowed: false as const,
    instructionsVerified: false as const,
    wallet,
    transaction: transaction as string,
    sha256: Array.from(new Uint8Array(digest), (b) =>
      b.toString(16).padStart(2, '0'),
    ).join(''),
    transactionBytes: bytes.length,
    version: 0 as const,
    instructionCount: message.instructions.length,
    lookupTableCount: lookups.length,
    accountCount,
    instructionReview: reviewSwapInstructions(message),
    limitations:
      'Unsigned provider transaction. Signer and envelope checked; swap instructions, lookup accounts, debit limits, blockhash validity and fee estimates require independent simulation and review before signing. No execution clearance.',
  };
}

export async function reviewUnsignedSwapOrder(
  data: Record<string, unknown>,
  wallet: string,
) {
  const fail = () => {
    throw new Error('Unsupported unsigned swap order.');
  };
  if (
    data.taker !== wallet ||
    data.gasless !== false ||
    data.transactionVersion !== 0
  )
    fail();
  const envelope = await reviewUnsignedSwapEnvelope(data.transaction, wallet);
  let fees = 0n;
  const estimates: Record<string, string> = {};
  for (const [field, payer] of [
    ['signatureFeeLamports', 'signatureFeePayer'],
    ['prioritizationFeeLamports', 'prioritizationFeePayer'],
    ['rentFeeLamports', 'rentFeePayer'],
  ]) {
    const fee = data[field];
    if (
      typeof fee !== 'number' ||
      !Number.isSafeInteger(fee) ||
      fee < 0 ||
      (fee > 0 && data[payer] !== wallet)
    )
      fail();
    estimates[field] = String(fee);
    fees += BigInt(fee as number);
  }
  if (
    typeof data.lastValidBlockHeight !== 'string' ||
    !/^[1-9]\d{0,19}$/.test(data.lastValidBlockHeight) ||
    BigInt(data.lastValidBlockHeight) > (1n << 64n) - 1n
  )
    fail();
  return {
    ...envelope,
    lastValidBlockHeight: data.lastValidBlockHeight as string,
    estimatedFeesLamports: fees.toString(),
    estimates,
  };
}
