import bs58 from 'bs58';
import { z } from 'zod';
import {
  address,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  getTransactionEncoder,
} from '@solana/kit';
import { verifySolanaSignature } from './solana-signature';
import { SOLANA_MAINNET_GENESIS } from './wallet-balances';
import { exchangeOrderAuthority } from './exchange-order-review';
import { exchangePayoutSignature } from './exchange-payout-signature';

const SYSTEM = '11111111111111111111111111111111';
export class ExchangePayoutError extends Error {
  constructor(
    message: string,
    readonly status = 409,
  ) {
    super(message);
  }
}
const fail = (
  message = 'Finalized exchange payout evidence differs.',
  status = 409,
): never => {
  throw new ExchangePayoutError(message, status);
};
const key = (value: unknown) => {
  if (typeof value !== 'string' || value.length < 32 || value.length > 44)
    return fail();
  try {
    const bytes = bs58.decode(value);
    if (bytes.length === 32 && bs58.encode(bytes) === value) return value;
  } catch {
    /* Refuse malformed public evidence. */
  }
  return fail();
};
const raw = (value: unknown) => {
  const text =
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
      ? String(value)
      : value;
  if (
    typeof text !== 'string' ||
    !/^(0|[1-9]\d{0,19})$/.test(text) ||
    BigInt(text) > (1n << 64n) - 1n
  )
    return fail('Exact integer payout evidence is required.');
  return BigInt(text);
};
const integer = (value: unknown) => {
  const n = Number(raw(value));
  return Number.isSafeInteger(n) ? n : fail();
};
const index = (value: unknown, count: number) => {
  const n = integer(value);
  return n < count ? n : fail('Payout account index differs.');
};
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : fail();
const stamp = z
  .string()
  .refine(
    (v) => Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v,
  );
const expectationSchema = z
  .object({
    reviewId: z.uuid(),
    orderSha256: z.string().regex(/^[a-f0-9]{64}$/),
    signature: z.string(),
    recipient: z.string(),
    amountRaw: z.string(),
    notBefore: stamp,
  })
  .strict();
export type ExchangePayoutExpectation = z.infer<typeof expectationSchema>;
function expectation(value: unknown) {
  const parsed = expectationSchema.safeParse(value);
  if (!parsed.success)
    return fail('Choose the retained owned payout context.', 400);
  const v = parsed.data;
  exchangePayoutSignature(v.signature);
  key(v.recipient);
  if (v.recipient === SYSTEM || raw(v.amountRaw) === 0n)
    return fail('An ordinary funder and positive payout are required.');
  return v;
}
const hash = async (bytes: Uint8Array) =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes)),
    ),
    (b) => b.toString(16).padStart(2, '0'),
  ).join('');
type Evidence = {
  genesisBefore: unknown;
  genesisAfter: unknown;
  status: unknown;
  transaction: unknown;
  finalizedSlot: unknown;
};

/** Historical native credit only. This never admits a carrier program for signing/execution. */
export async function decodeExchangePayoutReceipt(
  supplied: unknown,
  suppliedEvidence: Evidence,
  checkedAt: number,
) {
  const expected = expectation(structuredClone(supplied)),
    evidence = structuredClone(suppliedEvidence);
  if (
    !Number.isSafeInteger(checkedAt) ||
    evidence.genesisBefore !== SOLANA_MAINNET_GENESIS ||
    evidence.genesisAfter !== SOLANA_MAINNET_GENESIS
  )
    return fail('Payout RPC network differs.');
  const statusResponse = object(evidence.status);
  if (
    !Array.isArray(statusResponse.value) ||
    statusResponse.value.length !== 1 ||
    !statusResponse.value[0]
  )
    return fail('Payout signature is not finalized or is unavailable.', 404);
  const status = object(statusResponse.value[0]),
    statusContextSlot = integer(object(statusResponse.context).slot);
  if (
    status.err !== null ||
    status.confirmationStatus !== 'finalized' ||
    status.confirmations !== null
  )
    return fail('Payout signature is not successfully rooted.');
  const result = object(evidence.transaction),
    meta = object(result.meta),
    slot = integer(result.slot),
    finalizedSlot = integer(evidence.finalizedSlot);
  const blockTime = integer(result.blockTime);
  if (
    meta.err !== null ||
    integer(status.slot) !== slot ||
    statusContextSlot < slot ||
    finalizedSlot < slot ||
    blockTime > Math.floor(Number.MAX_SAFE_INTEGER / 1000) ||
    blockTime * 1000 < Date.parse(expected.notBefore) ||
    blockTime * 1000 > checkedAt
  )
    return fail('Payout finality, time or success differs.');
  if (
    !Array.isArray(result.transaction) ||
    result.transaction.length !== 2 ||
    result.transaction[1] !== 'base64'
  )
    return fail('Exact payout transaction bytes are required.');
  const encoded: unknown = result.transaction[0];
  if (
    typeof encoded !== 'string' ||
    encoded.length > 1644 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      encoded,
    )
  )
    return fail('Payout transaction encoding differs.');
  const bytes = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0));
  if (bytes.length > 1232 || btoa(atob(encoded)) !== encoded)
    return fail('Payout transaction size or encoding differs.');
  const tx = getTransactionDecoder().decode(bytes),
    message = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
  if (
    btoa(String.fromCharCode(...getTransactionEncoder().encode(tx))) !==
      encoded ||
    (message.version !== 'legacy' && message.version !== 0) ||
    (message.version === 'legacy'
      ? result.version !== 'legacy'
      : result.version !== 0 && result.version !== '0')
  )
    return fail('Payout packet/version differs.');
  const {
    numSignerAccounts: signed,
    numReadonlySignerAccounts: readonlySigned,
    numReadonlyNonSignerAccounts: readonlyUnsigned,
  } = message.header;
  if (
    signed < 1 ||
    signed > message.staticAccounts.length ||
    readonlySigned >= signed ||
    readonlyUnsigned > message.staticAccounts.length - signed
  )
    return fail('Payout signer header differs.');
  const accounts = message.staticAccounts.map((a, i) => ({
    address: key(a),
    signer: i < signed,
    writable:
      i < signed
        ? i < signed - readonlySigned
        : i < message.staticAccounts.length - readonlyUnsigned,
  }));
  const required = accounts.slice(0, signed).map((a) => a.address);
  if (
    Object.keys(tx.signatures).sort().join(',') !==
    [...required].sort().join(',')
  )
    return fail('Payout signer coverage differs.');
  for (const signer of required) {
    const signature = tx.signatures[address(signer)];
    if (
      !signature ||
      !verifySolanaSignature(
        Uint8Array.from(tx.messageBytes),
        Uint8Array.from(signature),
        bs58.decode(signer),
      )
    )
      return fail('Payout transaction signature verification failed.');
  }
  const primary = tx.signatures[address(required[0])];
  if (!primary || bs58.encode(primary) !== expected.signature)
    return fail(
      'Payout transaction signature differs from the retained reference.',
    );
  const tables =
    message.version === 0 ? (message.addressTableLookups ?? []) : [];
  const loaded =
    meta.loadedAddresses === undefined
      ? { writable: [], readonly: [] }
      : object(meta.loadedAddresses);
  for (const kind of ['writable', 'readonly'] as const) {
    const values = loaded[kind],
      count = tables.reduce(
        (n, t) =>
          n +
          (kind === 'writable' ? t.writableIndexes : t.readonlyIndexes).length,
        0,
      );
    if (!Array.isArray(values) || values.length !== count)
      return fail('Payout lookup address coverage differs.');
    for (const value of values)
      accounts.push({
        address: key(value),
        signer: false,
        writable: kind === 'writable',
      });
  }
  if (
    accounts.length > 256 ||
    new Set(accounts.map((a) => a.address)).size !== accounts.length
  )
    return fail('Payout account identities differ.');
  const recipientIndex = accounts.findIndex(
    (a) => a.address === expected.recipient,
  );
  if (
    recipientIndex < 1 ||
    accounts[recipientIndex].signer ||
    !accounts[recipientIndex].writable
  )
    return fail(
      'Payout recipient must be writable and cannot authorize or pay for this transaction.',
    );
  if (
    !Array.isArray(meta.preBalances) ||
    !Array.isArray(meta.postBalances) ||
    meta.preBalances.length !== accounts.length ||
    meta.postBalances.length !== accounts.length
  )
    return fail('Payout native balance coverage differs.');
  const before = meta.preBalances.map(raw),
    after = meta.postBalances.map(raw),
    fee = raw(meta.fee),
    amount = raw(expected.amountRaw);
  if (
    after[recipientIndex] - before[recipientIndex] !== amount ||
    after.reduce((n, v, i) => n + v - before[i], 0n) !== -fee
  )
    return fail('Payout credit or native conservation differs.');
  let incoming = 0n,
    transferCount = 0,
    innerTransferCount = 0;
  const visit = async (
    programIndex: unknown,
    selected: unknown[],
    data: Uint8Array,
    inner: boolean,
  ) => {
    const program = accounts[index(programIndex, accounts.length)],
      indices = selected.map((v) => index(v, accounts.length));
    if (program.address === expected.recipient)
      return fail('Payout recipient cannot be an invoked program.');
    if (program.address !== SYSTEM || !indices.includes(recipientIndex)) return;
    if (data.length < 4 || data.length > 84)
      return fail(
        'Unsupported System instruction touches the payout recipient.',
      );
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength),
      opcode = view.getUint32(0, true);
    let from: number, to: number;
    if (opcode === 2 && data.length === 12 && indices.length === 2) {
      [from, to] = indices;
      if (!inner && !accounts[from].signer)
        return fail('Direct payout source is not a signer.');
    } else if (opcode === 11 && data.length >= 52 && indices.length === 3) {
      [from, , to] = indices;
      const size = view.getBigUint64(12, true);
      if (
        size > 32n ||
        data.length !== 52 + Number(size) ||
        (!inner && !accounts[indices[1]].signer)
      )
        return fail('Seeded payout transfer differs.');
      const seed = data.subarray(20, 20 + Number(size)),
        owner = data.subarray(20 + Number(size));
      new TextDecoder('utf-8', { fatal: true }).decode(seed);
      const source = await crypto.subtle.digest(
        'SHA-256',
        Uint8Array.from([
          ...bs58.decode(accounts[indices[1]].address),
          ...seed,
          ...owner,
        ]),
      );
      if (bs58.encode(new Uint8Array(source)) !== accounts[from].address)
        return fail('Seeded payout source differs.');
    } else
      return fail(
        'Unsupported System instruction touches the payout recipient.',
      );
    if (
      from === recipientIndex ||
      to !== recipientIndex ||
      from === to ||
      !accounts[from].writable ||
      !accounts[to].writable
    )
      return fail(
        'Payout contains recipient spending or a changed transfer target.',
      );
    incoming += view.getBigUint64(4, true);
    transferCount++;
    if (inner) innerTransferCount++;
  };
  if (!message.instructions.length || message.instructions.length > 256)
    return fail('Payout instructions are unavailable.');
  for (const ix of message.instructions)
    await visit(
      ix.programAddressIndex,
      Array.from(ix.accountIndices ?? []),
      Uint8Array.from(ix.data ?? []),
      false,
    );
  if (
    !Array.isArray(meta.innerInstructions) ||
    meta.innerInstructions.length > message.instructions.length
  )
    return fail('Payout inner-instruction evidence is unavailable.');
  const groups = new Set<number>();
  let innerCount = 0,
    innerChars = 0;
  for (const value of meta.innerInstructions) {
    const group = object(value),
      groupIndex = index(group.index, message.instructions.length);
    if (
      groups.has(groupIndex) ||
      !Array.isArray(group.instructions) ||
      group.instructions.length > 1024
    )
      return fail('Payout inner-instruction coverage differs.');
    groups.add(groupIndex);
    for (const instruction of group.instructions) {
      const ix = object(instruction),
        programIndex = index(ix.programIdIndex, accounts.length);
      if (
        ++innerCount > 1024 ||
        !Array.isArray(ix.accounts) ||
        ix.accounts.length > 256 ||
        typeof ix.data !== 'string' ||
        !/^[1-9A-HJ-NP-Za-km-z]*$/.test(ix.data) ||
        ix.data.length > 16384 ||
        (innerChars += ix.data.length) > 1048576
      )
        return fail('Payout inner-instruction resources differ.');
      const selected = ix.accounts.map((v) => index(v, accounts.length));
      if (accounts[programIndex].address === expected.recipient)
        return fail('Payout recipient cannot be an invoked program.');
      if (
        accounts[programIndex].address === SYSTEM &&
        selected.includes(recipientIndex)
      ) {
        if (ix.data.length > 116)
          return fail('Unsupported System payout data.');
        await visit(programIndex, selected, bs58.decode(ix.data), true);
      }
    }
  }
  if (incoming !== amount || transferCount < 1)
    return fail(
      'Decoded incoming System transfers do not equal the exact expected payout.',
    );
  return {
    format: 'exchange-payout-receipt-v1' as const,
    reviewId: expected.reviewId,
    orderSha256: expected.orderSha256,
    network: 'solana-mainnet' as const,
    signature: expected.signature,
    recipient: expected.recipient,
    amountRaw: expected.amountRaw,
    slot,
    finalizedSlot,
    statusContextSlot,
    blockTime,
    networkFeeLamports: String(fee),
    recipientBeforeLamports: String(before[recipientIndex]),
    recipientAfterLamports: String(after[recipientIndex]),
    packetSha256: await hash(bytes),
    transferCount,
    innerTransferCount,
    transactionVersion: message.version,
    lookupResolution: tables.length
      ? ('finalized-rpc-metadata' as const)
      : ('not-used' as const),
    signatureVerified: true as const,
    payoutVerified: true as const,
    finalityEvidence: 'rpc-attestation' as const,
    accountEffects: 'recipient-native-credit-only' as const,
    currentSpendabilityVerified: false as const,
    observedAt: new Date(checkedAt).toISOString(),
    ...exchangeOrderAuthority,
  };
}
export type ExchangePayoutReceipt = Awaited<
  ReturnType<typeof decodeExchangePayoutReceipt>
>;
export type ExchangePayoutRpc = (
  method: string,
  params: unknown[],
  signal: AbortSignal,
) => Promise<unknown>;
/** Explicit read-only collector; supplied RPC must be server-owned. No default endpoint or retries. */
export async function collectExchangePayoutReceipt(
  value: unknown,
  caller: AbortSignal,
  rpc: ExchangePayoutRpc,
  now = Date.now,
): Promise<ExchangePayoutReceipt> {
  const expected = expectation(structuredClone(value)),
    signal = AbortSignal.any([caller, AbortSignal.timeout(25000)]);
  const read = async (method: string, params: unknown[]) => {
    signal.throwIfAborted();
    return rpc(method, params, signal);
  };
  try {
    const genesisBefore = await read('getGenesisHash', []);
    if (genesisBefore !== SOLANA_MAINNET_GENESIS)
      return fail('Payout RPC network differs.');
    const status = await read('getSignatureStatuses', [
      [expected.signature],
      { searchTransactionHistory: true },
    ]);
    const s = object(status);
    if (!Array.isArray(s.value) || s.value.length !== 1 || s.value[0] === null)
      return fail('Payout signature is not finalized or is unavailable.', 404);
    if (object(s.value[0]).confirmationStatus !== 'finalized')
      return fail('Payout signature is not rooted yet.', 404);
    const transaction = await read('getTransaction', [
      expected.signature,
      {
        encoding: 'base64',
        commitment: 'finalized',
        maxSupportedTransactionVersion: 0,
      },
    ]);
    if (transaction === null)
      return fail('Finalized payout transaction is unavailable.', 404);
    const finalizedSlot = await read('getSlot', [
      {
        commitment: 'finalized',
        minContextSlot: integer(object(transaction).slot),
      },
    ]);
    const genesisAfter = await read('getGenesisHash', []);
    const receipt = await decodeExchangePayoutReceipt(
      expected,
      { genesisBefore, genesisAfter, status, transaction, finalizedSlot },
      now(),
    );
    signal.throwIfAborted();
    return receipt;
  } catch (error) {
    if (error instanceof ExchangePayoutError) throw error;
    if (
      error &&
      typeof error === 'object' &&
      'status' in error &&
      error.status === 429
    )
      return fail(
        'Payout RPC rate limit reached. Wait before retrying verification.',
        429,
      );
    return fail(
      'Payout verification unavailable. No funds or holds changed.',
      503,
    );
  }
}
