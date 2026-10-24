import {
  getCompiledTransactionMessageDecoder,
  getCompiledTransactionMessageEncoder,
  getTransactionDecoder,
  getTransactionEncoder,
} from '@solana/kit';
import bs58 from 'bs58';

const SYSTEM = '11111111111111111111111111111111';
const U64 = (1n << 64n) - 1n;
const MAX_WRAPPER = 4 * 1024 * 1024;
const MAX_DATA = 2 * 1024 * 1024;
const MAX_ACCOUNT = 512 * 1024;
type LoadedAddresses = { writable: string[]; readonly: string[] };
export type JitoSimulationAccount = {
  owner: string;
  lamports: string;
  data: Uint8Array;
  executable: boolean;
};
export type JitoBundleSimulationFrame = {
  packet: number;
  transaction: string;
  transactionSha256: string;
  messageSha256: string;
  keys: string[];
  signers: boolean[];
  requestedWritable: boolean[];
  requestedReadonly: boolean[];
  invokedProgramIndexes: number[];
  loadedAddresses: LoadedAddresses;
  maximumFeeLamports: string;
  expectedFeeLamports: string;
  feeLamports: string;
  unitsConsumed: number;
  loadedAccountsDataSize: string;
  preAccounts: (JitoSimulationAccount | null)[];
  postAccounts: (JitoSimulationAccount | null)[];
};
export type JitoBundleSimulationFrames = {
  format: 'jito-bundle-simulation-frames-v1';
  slot: number;
  frames: JitoBundleSimulationFrame[];
  signingAllowed: false;
  executionAllowed: false;
  automaticExecutionAllowed: false;
  economicOutputVerified: false;
  providerQualified: false;
  signatureVerified: false;
  altStateVerified: false;
  runtimePrivilegesVerified: false;
};
const fail = (reason: string): never => {
  throw Error(`Bundle simulation frames: ${reason}.`);
};
function object(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v))
    return fail('expected object');
  return v as Record<string, unknown>;
}
function exact(v: Record<string, unknown>, keys: string[]) {
  const names = Object.keys(v);
  if (
    names.length !== keys.length ||
    names.some((name) => !keys.includes(name))
  )
    fail('unexpected fields');
}
function integer(v: unknown, max = U64): bigint {
  const raw =
    typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? String(v) : v;
  if (typeof raw !== 'string' || !/^(0|[1-9]\d{0,19})$/.test(raw))
    return fail('invalid integer');
  const n = BigInt(raw);
  if (n > max) return fail('integer outside bound');
  return n;
}
function key(v: unknown): string {
  if (typeof v !== 'string' || v.length < 32 || v.length > 44)
    return fail('invalid address');
  try {
    const b = bs58.decode(v);
    if (b.length === 32 && bs58.encode(b) === v) return v;
  } catch {
    /* Refuse below. */
  }
  return fail('noncanonical address');
}
function base64(v: unknown, max: number): Uint8Array {
  if (
    typeof v !== 'string' ||
    v.length > 4 * Math.ceil(max / 3) ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(v)
  )
    return fail('invalid base64');
  let binary: string;
  try {
    binary = atob(v);
  } catch {
    return fail('invalid base64');
  }
  if (binary.length > max || btoa(binary) !== v)
    return fail('noncanonical base64');
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}
const equalBytes = (a: ArrayLike<number>, b: ArrayLike<number>) =>
  a.length === b.length && Array.from(a).every((n, i) => n === b[i]);
async function sha(bytes: Uint8Array) {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    Uint8Array.from(bytes).buffer,
  );
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
}
/** Snapshot only bounded JSON data. Callers must bound transport bytes before parsing.
 * Own accessors, custom serialization and sparse arrays are refused here.
 * This is not a detector for caller-created Proxy traps. */
function snapshot(value: unknown): unknown {
  let nodes = 0,
    stringBytes = 0;
  const utf8 = new TextEncoder();
  function copy(v: unknown, depth: number): unknown {
    if (++nodes > 20000 || depth > 24) return fail('wrapper complexity bound');
    if (v === null || typeof v === 'boolean') return v;
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) return fail('invalid number');
      return v;
    }
    if (typeof v === 'string') {
      if (v.length > MAX_WRAPPER) return fail('wrapper byte bound');
      stringBytes += utf8.encode(JSON.stringify(v)).length;
      if (stringBytes > MAX_WRAPPER) return fail('wrapper byte bound');
      return v;
    }
    if (!v || typeof v !== 'object') return fail('non-JSON value');
    const array = Array.isArray(v);
    if (
      !array &&
      Object.getPrototypeOf(v) !== Object.prototype &&
      Object.getPrototypeOf(v) !== null
    )
      return fail('non-JSON object');
    if (array && v.length > 20000) return fail('invalid array');
    const ownNames = Object.getOwnPropertyNames(v);
    if (ownNames.length > 20001) return fail('wrapper complexity bound');
    if (Object.getOwnPropertySymbols(v).length) return fail('non-JSON key');
    const names = ownNames.filter((k) => !(array && k === 'length'));
    if (
      array &&
      (v.length > 20000 ||
        names.length !== v.length ||
        names.some((n, i) => n !== String(i)))
    )
      return fail('invalid array');
    const out: Record<string, unknown> | unknown[] = array
      ? []
      : Object.create(null);
    for (const name of names) {
      const descriptor = Object.getOwnPropertyDescriptor(v, name)!;
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value'))
        return fail('non-JSON property');
      stringBytes += utf8.encode(JSON.stringify(name)).length;
      if (stringBytes > MAX_WRAPPER) return fail('wrapper byte bound');
      Object.defineProperty(out, name, {
        value: copy(descriptor.value, depth + 1),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return out;
  }
  const copied = copy(value, 0);
  if (utf8.encode(JSON.stringify(copied)).length > MAX_WRAPPER)
    return fail('wrapper byte bound');
  return copied;
}
function loaded(
  value: unknown,
  writableCount: number,
  readonlyCount: number,
): LoadedAddresses {
  if (value == null) {
    if (writableCount || readonlyCount) return fail('missing loaded addresses');
    return { writable: [], readonly: [] };
  }
  const v = object(value);
  exact(v, ['writable', 'readonly']);
  const read = (which: 'writable' | 'readonly', count: number) => {
    const a = v[which];
    if (!Array.isArray(a) || a.length !== count)
      return fail('loaded address cardinality');
    return a.map(key);
  };
  return {
    writable: read('writable', writableCount),
    readonly: read('readonly', readonlyCount),
  };
}
function account(
  value: unknown,
  budget: { raw: number },
): JitoSimulationAccount | null {
  if (value === null) return null;
  const v = object(value);
  exact(v, ['owner', 'lamports', 'data', 'executable']);
  if (
    !Array.isArray(v.data) ||
    v.data.length !== 2 ||
    v.data[1] !== 'base64' ||
    typeof v.executable !== 'boolean'
  )
    return fail('invalid raw account');
  const data = base64(v.data[0], MAX_ACCOUNT);
  budget.raw += data.length;
  if (budget.raw > MAX_DATA) return fail('raw account data bound');
  return {
    owner: key(v.owner),
    lamports: integer(v.lamports).toString(),
    data,
    executable: v.executable,
  };
}
function equalAccount(
  a: JitoSimulationAccount | null,
  b: JitoSimulationAccount | null,
) {
  return a === null || b === null
    ? a === b
    : a.owner === b.owner &&
        a.lamports === b.lamports &&
        a.executable === b.executable &&
        equalBytes(a.data, b.data);
}

export type JitoBundleSimulationPacket = {
  transaction: string;
  loadedAddresses: LoadedAddresses | null;
  maximumFeeLamports: string;
  /** Fresh caller-observed same-bank getFeeForMessage value; not proved here. */
  expectedFeeLamports: string;
};
async function decodePacket(value: unknown, packet: number) {
  const p = object(value);
  exact(p, [
    'transaction',
    'loadedAddresses',
    'maximumFeeLamports',
    'expectedFeeLamports',
  ]);
  const maximumFee = integer(p.maximumFeeLamports),
    expectedFee = integer(p.expectedFeeLamports);
  if (expectedFee < 1n || expectedFee > maximumFee)
    return fail('expected fee outside cap');
  const bytes = base64(p.transaction, 1232);
  if (!bytes.length) return fail('empty packet');
  const tx = getTransactionDecoder().decode(bytes);
  if (!equalBytes(getTransactionEncoder().encode(tx), bytes))
    return fail('noncanonical packet');
  const message = getCompiledTransactionMessageDecoder().decode(
    tx.messageBytes,
  );
  if (
    !equalBytes(
      getCompiledTransactionMessageEncoder().encode(message),
      tx.messageBytes,
    )
  )
    return fail('noncanonical message');
  if (message.version !== 0 && message.version !== 'legacy')
    return fail('transaction version is not admitted');
  const staticKeys = message.staticAccounts.map(key),
    header = message.header;
  const count = staticKeys.length,
    signerCount = header.numSignerAccounts;
  if (
    count < 1 ||
    count > 256 ||
    !Number.isInteger(signerCount) ||
    !Number.isInteger(header.numReadonlySignerAccounts) ||
    !Number.isInteger(header.numReadonlyNonSignerAccounts) ||
    signerCount < 1 ||
    signerCount > count ||
    header.numReadonlySignerAccounts < 0 ||
    header.numReadonlySignerAccounts >= signerCount ||
    header.numReadonlyNonSignerAccounts < 0 ||
    header.numReadonlyNonSignerAccounts > count - signerCount
  )
    return fail('invalid privileges');
  const signatures = Object.keys(tx.signatures);
  if (
    signatures.length !== signerCount ||
    signatures.some((s, i) => s !== staticKeys[i])
  )
    return fail('signature vector');
  const tables =
    message.version === 0 ? (message.addressTableLookups ?? []) : [];
  if (
    tables.length > 32 ||
    new Set(tables.map((t) => key(t.lookupTableAddress))).size !== tables.length
  )
    return fail('duplicate lookup tables');
  for (const table of tables) {
    const indexes = [...table.writableIndexes, ...table.readonlyIndexes];
    if (
      indexes.length === 0 ||
      new Set(indexes).size !== indexes.length ||
      indexes.some((i) => !Number.isInteger(i) || i < 0 || i > 255)
    )
      return fail('invalid lookup indexes');
  }
  const resolved = loaded(
    p.loadedAddresses,
    tables.reduce((n, t) => n + t.writableIndexes.length, 0),
    tables.reduce((n, t) => n + t.readonlyIndexes.length, 0),
  );
  const keys = [...staticKeys, ...resolved.writable, ...resolved.readonly];
  if (keys.length > 256 || new Set(keys).size !== keys.length)
    return fail('duplicate or excessive keys');
  const signers = keys.map((_, i) => i < signerCount);
  const writable = keys.map((_, i) =>
    i < count
      ? i < signerCount
        ? i < signerCount - header.numReadonlySignerAccounts
        : i < count - header.numReadonlyNonSignerAccounts
      : i < count + resolved.writable.length,
  );
  for (const instruction of message.instructions) {
    if (
      !Number.isInteger(instruction.programAddressIndex) ||
      instruction.programAddressIndex < 1 ||
      instruction.programAddressIndex >= count
    )
      return fail('program index must reference nonpayer static account');
    if (writable[instruction.programAddressIndex])
      return fail('invoked program requested writable');
    if (
      !(instruction.accountIndices ?? []).every(
        (i) => Number.isInteger(i) && i >= 0 && i < keys.length,
      )
    )
      return fail('instruction index');
  }

  return {
    packet,
    transaction: String(p.transaction),
    transactionSha256: await sha(bytes),
    messageSha256: await sha(Uint8Array.from(tx.messageBytes)),
    keys,
    signers,
    requestedWritable: writable,
    requestedReadonly: writable.map((v) => !v),
    invokedProgramIndexes: [
      ...new Set(message.instructions.map((i) => i.programAddressIndex)),
    ],
    loadedAddresses: resolved,
    maximumFeeLamports: maximumFee.toString(),
    expectedFeeLamports: expectedFee.toString(),
  };
}
async function decodePackets(packets: unknown) {
  if (!Array.isArray(packets) || packets.length < 2 || packets.length > 5)
    return fail('packet cardinality');
  const decoded = [];
  const seenPackets = new Set<string>(),
    seenMessages = new Set<string>();
  for (let i = 0; i < packets.length; i++) {
    const packet = await decodePacket(packets[i], i);
    if (
      seenPackets.has(packet.transactionSha256) ||
      seenMessages.has(packet.messageSha256)
    )
      return fail('duplicate packet or message');
    seenPackets.add(packet.transactionSha256);
    seenMessages.add(packet.messageSha256);
    decoded.push(packet);
  }
  return decoded;
}

/** Unmounted contract only. The caller must independently admit runtime privilege
 * downgrades (including reserved accounts); requested masks are header privileges,
 * not fully derived runtime privileges or a full runtime canonicality claim. */
export async function buildJitoBundleSimulationRequest(
  packets: JitoBundleSimulationPacket[],
  simulationBankSlot: number | string,
  options: {
    verifySignatures: boolean;
    bankEncoding: 'slot-object' | 'numeric-slot';
  },
) {
  const input = object(snapshot({ packets, simulationBankSlot, options }));
  const config = object(input.options);
  exact(config, ['verifySignatures', 'bankEncoding']);
  if (typeof config.verifySignatures !== 'boolean')
    return fail('signature verification mode required');
  if (
    config.bankEncoding !== 'slot-object' &&
    config.bankEncoding !== 'numeric-slot'
  )
    return fail('explicit bank wire encoding required');
  const slot = Number(
    integer(input.simulationBankSlot, BigInt(Number.MAX_SAFE_INTEGER)),
  );
  const decoded = await decodePackets(input.packets);
  return {
    profile: 'jito-sequential-account-frames-v1' as const,
    bankEncoding: config.bankEncoding as 'slot-object' | 'numeric-slot',
    method: 'simulateBundle' as const,
    params: [
      { encodedTransactions: decoded.map((p) => p.transaction) },
      {
        transactionEncoding: 'base64' as const,
        // Pinned Rust enum and TypeScript SDK disagree on this wire encoding.
        // Callers must choose explicitly; returned bank equality never changes.
        simulationBank: config.bankEncoding === 'slot-object' ? { slot } : slot,
        skipSigVerify: !config.verifySignatures,
        replaceRecentBlockhash: false as const,
        preExecutionAccountsConfigs: decoded.map((p) => ({
          encoding: 'base64' as const,
          addresses: [...p.keys],
        })),
        postExecutionAccountsConfigs: decoded.map((p) => ({
          encoding: 'base64' as const,
          addresses: [...p.keys],
        })),
      },
    ] as const,
    runtimePrivilegesVerified: false as const,
    providerQualified: false as const,
    signingAllowed: false as const,
    executionAllowed: false as const,
    automaticExecutionAllowed: false as const,
  };
}

/** Pure frame integrity only. Positional results rely on the caller's exact-request transport
 * contract; this does not authenticate a provider, ALT state, network or economic outcome.
 * Same-bank fee observations and runtime privilege downgrades require independent caller
 * admission. This verifier derives requested privileges, not complete runtime canonicality. */
export async function verifyJitoBundleSimulationFrames(input: {
  packets: JitoBundleSimulationPacket[];
  minimumSlot: number | string;
  simulationBankSlot: number | string;
  result: unknown;
}): Promise<JitoBundleSimulationFrames> {
  const safe = object(snapshot(input));
  exact(safe, ['packets', 'minimumSlot', 'simulationBankSlot', 'result']);
  if (
    !Array.isArray(safe.packets) ||
    safe.packets.length < 2 ||
    safe.packets.length > 5
  )
    return fail('packet cardinality');
  const minimumSlot = Number(
    integer(safe.minimumSlot, BigInt(Number.MAX_SAFE_INTEGER)),
  );
  const result = object(safe.result),
    context = object(result.context),
    value = object(result.value);
  exact(result, ['context', 'value']);
  exact(context, ['slot']);
  exact(value, ['summary', 'transactionResults']);
  const slot = Number(integer(context.slot, BigInt(Number.MAX_SAFE_INTEGER)));
  const bankSlot = Number(
    integer(safe.simulationBankSlot, BigInt(Number.MAX_SAFE_INTEGER)),
  );
  if (slot !== bankSlot) return fail('simulation bank differs');
  if (slot < minimumSlot || slot - minimumSlot > 32) return fail('slot span');
  if (
    value.summary !== 'succeeded' ||
    !Array.isArray(value.transactionResults) ||
    value.transactionResults.length !== safe.packets.length
  )
    return fail('failed or partial result');
  const packets = await decodePackets(safe.packets);
  const frames: JitoBundleSimulationFrame[] = [];
  const previous = new Map<string, JitoSimulationAccount | null>(),
    budget = { raw: 0 };
  for (let packet = 0; packet < packets.length; packet++) {
    const decoded = packets[packet];
    const {
      keys,
      loadedAddresses: resolved,
      requestedWritable: writable,
    } = decoded;
    const raw = object(value.transactionResults[packet]);
    const required = [
      'err',
      'preExecutionAccounts',
      'postExecutionAccounts',
      'fee',
      'unitsConsumed',
      'loadedAccountsDataSize',
    ];
    if (
      required.some((k) => !Object.hasOwn(raw, k)) ||
      Object.keys(raw).some(
        (k) =>
          ![
            ...required,
            'loadedAddresses',
            'replacementBlockhash',
            'transaction',
          ].includes(k),
      ) ||
      raw.err !== null ||
      (Object.hasOwn(raw, 'replacementBlockhash') &&
        raw.replacementBlockhash !== null) ||
      (Object.hasOwn(raw, 'transaction') &&
        raw.transaction !== decoded.transaction)
    )
      return fail('failed, replaced or mismatched frame');
    const returnedLoaded = loaded(
      raw.loadedAddresses,
      resolved.writable.length,
      resolved.readonly.length,
    );
    if (JSON.stringify(returnedLoaded) !== JSON.stringify(resolved))
      return fail('loaded addresses differ');
    const readAccounts = (v: unknown) => {
      if (!Array.isArray(v) || v.length !== keys.length)
        return fail('full account vector required');
      return v.map((a) => account(a, budget));
    };
    const preAccounts = readAccounts(raw.preExecutionAccounts),
      postAccounts = readAccounts(raw.postExecutionAccounts);
    if (
      decoded.invokedProgramIndexes.some(
        (i) =>
          preAccounts[i]?.executable !== true ||
          postAccounts[i]?.executable !== true,
      )
    )
      return fail('invoked program must exist and remain executable');
    const maximumFee = BigInt(decoded.maximumFeeLamports),
      fee = integer(raw.fee);
    if (
      fee < 1n ||
      fee > maximumFee ||
      fee !== BigInt(decoded.expectedFeeLamports)
    )
      return fail('fee outside cap');
    const unitsConsumed = Number(integer(raw.unitsConsumed, 1400000n));
    if (unitsConsumed < 1) return fail('compute outside bound');
    const loadedAccountsDataSize = integer(
      raw.loadedAccountsDataSize,
      64n * 1024n * 1024n,
    ).toString();
    const ordinaryPayer = (a: JitoSimulationAccount | null) =>
      a !== null && a.owner === SYSTEM && !a.executable && a.data.length === 0;
    if (
      !ordinaryPayer(preAccounts[0]) ||
      !ordinaryPayer(postAccounts[0]) ||
      !writable[0]
    )
      return fail('payer must remain ordinary System');
    let before = 0n,
      after = 0n;
    for (let i = 0; i < keys.length; i++) {
      const pre = preAccounts[i],
        post = postAccounts[i];
      if (
        (!writable[i] || pre?.executable || post?.executable) &&
        !equalAccount(pre, post)
      )
        return fail('readonly or executable account changed');
      if (previous.has(keys[i]) && !equalAccount(previous.get(keys[i])!, pre))
        return fail('cross-frame continuity');
      before += BigInt(pre?.lamports ?? '0');
      after += BigInt(post?.lamports ?? '0');
      previous.set(keys[i], post);
    }
    if (before - after !== fee) return fail('native conservation');
    frames.push({
      ...decoded,
      feeLamports: fee.toString(),
      unitsConsumed,
      loadedAccountsDataSize,
      preAccounts,
      postAccounts,
    });
  }
  return {
    format: 'jito-bundle-simulation-frames-v1',
    slot,
    frames,
    signingAllowed: false,
    executionAllowed: false,
    automaticExecutionAllowed: false,
    economicOutputVerified: false,
    providerQualified: false,
    signatureVerified: false,
    altStateVerified: false,
    runtimePrivilegesVerified: false,
  };
}
