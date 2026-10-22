import bs58 from 'bs58';
import {
  getTransactionDecoder,
  getTransactionEncoder,
  getCompiledTransactionMessageDecoder,
  getCompiledTransactionMessageEncoder,
} from '@solana/kit';
import {
  validSolanaSigningKey,
  verifySolanaSignature,
} from './solana-signature';
const SYSTEM = '11111111111111111111111111111111';
const COMPUTE = 'ComputeBudget111111111111111111111111111111';
const MAX = (1n << 64n) - 1n;
type Row = Record<string, unknown>;
const object = (value: unknown): Row => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw Error();
  return value as Row;
};
const uint = (value: unknown): bigint => {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) throw Error();
    return BigInt(value);
  }
  if (
    typeof value !== 'string' ||
    !/^(0|[1-9]\d{0,19})$/.test(value) ||
    BigInt(value) > MAX
  )
    throw Error();
  return BigInt(value);
};
const integer = (value: unknown) => {
  const n = uint(value);
  if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw Error();
  return Number(n);
};
const equal = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((byte, i) => byte === b[i]);
export type FundingOriginReason =
  | 'no-returned-history'
  | 'unavailable-oldest-evidence'
  | 'unsupported-native-transaction'
  | 'not-zero-to-positive-funding';
export type WalletFundingOrigin = {
  format: 'wallet-funding-origin-v1';
  network: 'mainnet';
  scope: 'oldest-provider-reported-transaction';
  wallet: string;
  observedAt: string;
  historyComplete: false;
  executionAllowed: false;
  signingAllowed: false;
  funding: null | {
    signature: string;
    slot: number;
    transactionIndex: number;
    blockTime: number;
    recipientChangeRaw: string;
    funders: string[];
  };
  reason: FundingOriginReason | null;
  ledgerMetadata: 'provider-reported';
};
/** Provider-reported history metadata plus locally authenticated native bytes.
 * No first-ever funding, archive completeness or independent finality proof.
 * Caller must establish mainnet and issue the unfiltered ascending limit-one read,
 * then fetch this exact signature in base64 with maxSupportedTransactionVersion:0.
 */
export function decodeWalletFundingOrigin(
  wallet: string,
  history: unknown,
  receipt: unknown,
  now = Date.now(),
): WalletFundingOrigin {
  try {
    if (
      typeof wallet !== 'string' ||
      wallet.length > 44 ||
      !Number.isSafeInteger(now) ||
      now < 0 ||
      now > 8640000000000000 ||
      !validSolanaSigningKey(bs58.decode(wallet))
    )
      throw Error();
  } catch {
    throw Error('Funding origin context is invalid.');
  }
  const base = {
    format: 'wallet-funding-origin-v1',
    network: 'mainnet',
    scope: 'oldest-provider-reported-transaction',
    wallet,
    observedAt: new Date(now).toISOString(),
    ledgerMetadata: 'provider-reported',
    historyComplete: false,
    executionAllowed: false,
    signingAllowed: false,
  } as const;
  const unknown = (reason: FundingOriginReason): WalletFundingOrigin => ({
    ...base,
    funding: null,
    reason,
  });
  let signature: string,
    slot: number,
    transactionIndex: number,
    blockTime: number;
  let raw: Row, meta: Row;
  try {
    const page = object(history);
    if (
      !Array.isArray(page.data) ||
      page.data.length > 1 ||
      !(
        page.paginationToken === null ||
        page.paginationToken === undefined ||
        (typeof page.paginationToken === 'string' &&
          page.paginationToken.length <= 4096)
      )
    )
      throw Error();
    if (!page.data.length) return unknown('no-returned-history');
    const first = object(page.data[0]);
    if (
      first.err !== null ||
      first.confirmationStatus !== 'finalized' ||
      typeof first.signature !== 'string' ||
      first.signature.length > 90 ||
      bs58.decode(first.signature).length !== 64
    )
      throw Error();
    signature = first.signature;
    slot = integer(first.slot);
    transactionIndex = integer(first.transactionIndex);
    blockTime = integer(first.blockTime);
    if (blockTime * 1000 > now) throw Error();
    raw = object(receipt);
    meta = object(raw.meta);
    if (
      integer(raw.slot) !== slot ||
      integer(raw.blockTime) !== blockTime ||
      meta.err !== null
    )
      throw Error();
  } catch {
    return unknown('unavailable-oldest-evidence');
  }
  try {
    if (
      !Array.isArray(raw.transaction) ||
      raw.transaction.length !== 2 ||
      raw.transaction[1] !== 'base64' ||
      typeof raw.transaction[0] !== 'string' ||
      raw.transaction[0].length > 1644 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        raw.transaction[0],
      )
    )
      throw Error();
    const packet = Uint8Array.from(atob(raw.transaction[0]), (c) =>
      c.charCodeAt(0),
    );
    if (
      packet.length > 1232 ||
      btoa(String.fromCharCode(...packet)) !== raw.transaction[0]
    )
      throw Error();
    const transaction = getTransactionDecoder().decode(packet);
    if (
      !equal(
        Uint8Array.from(getTransactionEncoder().encode(transaction)),
        packet,
      )
    )
      throw Error();
    const message = getCompiledTransactionMessageDecoder().decode(
      transaction.messageBytes,
    );
    if (
      !equal(
        Uint8Array.from(getCompiledTransactionMessageEncoder().encode(message)),
        Uint8Array.from(transaction.messageBytes),
      )
    )
      throw Error();
    if (
      (message.version !== 'legacy' && message.version !== 0) ||
      String(raw.version) !== String(message.version) ||
      (message.version === 0 && message.addressTableLookups?.length)
    )
      return unknown('unsupported-native-transaction');
    const keys = message.staticAccounts.map(String);
    const {
      numSignerAccounts: signers,
      numReadonlySignerAccounts: readonlySigners,
      numReadonlyNonSignerAccounts: readonlyOthers,
    } = message.header;
    if (
      keys.length < 3 ||
      keys.length > 64 ||
      new Set(keys).size !== keys.length ||
      signers < 1 ||
      signers > keys.length ||
      readonlySigners >= signers ||
      readonlyOthers > keys.length - signers ||
      Object.keys(transaction.signatures).length !== signers ||
      message.instructions.length < 1 ||
      message.instructions.length > 32
    )
      throw Error();
    const writable = (i: number) =>
      i < signers
        ? i < signers - readonlySigners
        : i < keys.length - readonlyOthers;
    for (let i = 0; i < signers; i++) {
      const sig =
        transaction.signatures[keys[i] as keyof typeof transaction.signatures];
      if (
        !sig ||
        !verifySolanaSignature(
          Uint8Array.from(transaction.messageBytes),
          Uint8Array.from(sig),
          bs58.decode(keys[i]),
        ) ||
        (i === 0 && bs58.encode(Uint8Array.from(sig)) !== signature)
      )
        throw Error();
    }
    if (
      !Object.hasOwn(meta, 'innerInstructions') ||
      (meta.innerInstructions !== null &&
        (!Array.isArray(meta.innerInstructions) ||
          meta.innerInstructions.length)) ||
      ['preTokenBalances', 'postTokenBalances', 'rewards'].some(
        (key) =>
          meta[key] !== undefined &&
          (!Array.isArray(meta[key]) || meta[key].length),
      )
    )
      return unknown('unsupported-native-transaction');
    if (meta.loadedAddresses !== undefined) {
      const loaded = object(meta.loadedAddresses);
      if (
        !Array.isArray(loaded.writable) ||
        loaded.writable.length ||
        !Array.isArray(loaded.readonly) ||
        loaded.readonly.length
      )
        return unknown('unsupported-native-transaction');
    }
    if (
      !Array.isArray(meta.preBalances) ||
      !Array.isArray(meta.postBalances) ||
      meta.preBalances.length !== keys.length ||
      meta.postBalances.length !== keys.length
    )
      throw Error();
    const before = meta.preBalances.map(uint),
      after = meta.postBalances.map(uint),
      current = [...before],
      fee = uint(meta.fee);
    const target = keys.indexOf(wallet);
    if (target < 0) return unknown('unavailable-oldest-evidence');
    if (target < signers) return unknown('unsupported-native-transaction');
    if (current[0] < fee) throw Error();
    current[0] -= fee;
    const funders = new Set<string>();
    const compute = new Set<number>();
    let decodedNativeTransfers = 0;
    for (const ix of message.instructions) {
      const program = keys[ix.programAddressIndex];
      const data = Uint8Array.from(ix.data ?? []),
        accounts = ix.accountIndices ?? [];
      const view = new DataView(data.buffer);
      if (
        !Number.isSafeInteger(ix.programAddressIndex) ||
        ix.programAddressIndex < 0 ||
        ix.programAddressIndex >= keys.length ||
        writable(ix.programAddressIndex)
      )
        throw Error();
      if (program === COMPUTE) {
        const tag = data[0];
        if (
          accounts.length ||
          compute.has(tag) ||
          !(
            (tag === 2 && data.length === 5 && view.getUint32(1, true) > 0) ||
            (tag === 3 && data.length === 9)
          )
        )
          return unknown('unsupported-native-transaction');
        if (tag === 3) view.getBigUint64(1, true);
        compute.add(tag);
        continue;
      }
      if (
        program !== SYSTEM ||
        data.length !== 12 ||
        view.getUint32(0, true) !== 2 ||
        accounts.length !== 2
      )
        return unknown('unsupported-native-transaction');
      const [from, to] = accounts;
      if (
        accounts.some(
          (i) =>
            !Number.isInteger(i) || i < 0 || i >= keys.length || !writable(i),
        ) ||
        from >= signers ||
        from === to ||
        [SYSTEM, COMPUTE].includes(keys[to])
      )
        throw Error();
      const amount = view.getBigUint64(4, true);
      if (amount <= 0n || current[from] < amount || current[to] + amount > MAX)
        throw Error();
      decodedNativeTransfers++;
      current[from] -= amount;
      current[to] += amount;
      if (to === target) funders.add(keys[from]);
    }
    // Missing recording is admitted only after the COMPLETE authenticated
    // message proves legacy native Transfer-only semantics, which cannot CPI.
    // New supported instruction branches cannot silently inherit this policy.
    const legacyNativeNoCpi =
      message.version === 'legacy' &&
      decodedNativeTransfers === message.instructions.length;
    if (meta.innerInstructions === null && !legacyNativeNoCpi)
      return unknown('unsupported-native-transaction');
    if (
      meta.innerInstructions === null &&
      meta.logMessages !== undefined &&
      meta.logMessages !== null
    ) {
      if (
        !Array.isArray(meta.logMessages) ||
        meta.logMessages.length > 256 ||
        meta.logMessages.some((line) => {
          if (typeof line !== 'string' || line.length > 2048) return true;
          const invoke = /^Program (\w+) invoke \[(\d+)\]$/.exec(line);
          return invoke !== null && (invoke[1] !== SYSTEM || invoke[2] !== '1');
        })
      )
        return unknown('unavailable-oldest-evidence');
    }
    if (current.some((amount, i) => amount !== after[i])) throw Error();
    if (before[target] !== 0n || after[target] <= 0n)
      return unknown('not-zero-to-positive-funding');
    if (!funders.size) throw Error();
    return {
      ...base,
      funding: {
        signature,
        slot,
        transactionIndex,
        blockTime,
        recipientChangeRaw: after[target].toString(),
        funders: [...funders].sort(),
      },
      reason: null,
    };
  } catch {
    return unknown('unavailable-oldest-evidence');
  }
}
