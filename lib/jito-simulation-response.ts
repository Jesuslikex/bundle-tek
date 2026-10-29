import bs58 from 'bs58';
import {
  buildJitoBundleSimulationRequest,
  verifyJitoBundleSimulationFrames,
  type JitoBundleSimulationPacket,
} from './jito-bundle-simulation-frames';
import {
  readJitoSimulationPayload,
  inspectJitoSimulationDecimal,
} from './jito-simulation-json';

const U64 = (1n << 64n) - 1n;
const reasons = new WeakMap<object, string>();
const refuse = (reason: string): never => {
  const error = Error('Jito raw response: ' + reason + '.');
  reasons.set(error, reason);
  throw error;
};
function object(value: unknown): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    inspectJitoSimulationDecimal(value) !== null
  )
    return refuse('object required');
  return value as Record<string, unknown>;
}
function fields(
  value: Record<string, unknown>,
  required: string[],
  optional: string[] = [],
) {
  if (
    required.some((key) => !Object.hasOwn(value, key)) ||
    Object.keys(value).some(
      (key) => !required.includes(key) && !optional.includes(key),
    )
  )
    return refuse('unknown or missing field');
}
function uint(value: unknown, maximum = U64): bigint {
  if (typeof value !== 'bigint' || value < 0n || value > maximum)
    return refuse('wire integer type or range differs');
  return value;
}
function address(value: unknown): string {
  if (typeof value !== 'string' || value.length < 32 || value.length > 44)
    return refuse('address string required');
  try {
    const bytes = bs58.decode(value);
    if (bytes.length === 32 && bs58.encode(bytes) === value) return value;
  } catch {
    /* Refuse below. */
  }
  return refuse('noncanonical address');
}
function binary(value: unknown, maximum: number): Uint8Array {
  if (
    typeof value !== 'string' ||
    value.length > 4 * Math.ceil(maximum / 3) ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    )
  )
    return refuse('canonical base64 required');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length > maximum || bytes.toString('base64') !== value)
    return refuse('base64 data exceeds profile');
  return bytes;
}
type Account = {
  owner: string;
  lamports: string;
  executable: boolean;
  data: [string, 'base64'];
};
function account(value: unknown): Account | null {
  if (value === null) return null;
  const raw = object(value);
  fields(
    raw,
    ['owner', 'lamports', 'data', 'executable', 'rentEpoch'],
    ['space'],
  );
  if (
    typeof raw.executable !== 'boolean' ||
    !Array.isArray(raw.data) ||
    raw.data.length !== 2 ||
    raw.data[1] !== 'base64'
  )
    return refuse('raw account shape differs');
  const bytes = binary(raw.data[0], 524288);
  uint(raw.rentEpoch);
  if (
    Object.hasOwn(raw, 'space') &&
    raw.space !== null &&
    uint(raw.space) !== BigInt(bytes.length)
  )
    return refuse('raw account space differs');
  return {
    owner: address(raw.owner),
    lamports: uint(raw.lamports).toString(),
    executable: raw.executable,
    data: [raw.data[0] as string, 'base64'],
  };
}
function accounts(value: unknown, count: number) {
  if (!Array.isArray(value) || value.length !== count)
    return refuse('full raw account vector required');
  return value.map(account);
}
function balances(value: unknown, rows: (Account | null)[]) {
  if (value === null) return;
  if (!Array.isArray(value) || value.length !== rows.length)
    return refuse('balance metadata vector differs');
  value.forEach((amount, index) => {
    if (uint(amount) !== BigInt(rows[index]?.lamports ?? '0'))
      return refuse('balance metadata contradicts raw account');
  });
}
function tokenMetadata(
  value: unknown,
  rows: (Account | null)[],
  decimalsByMint: Map<string, bigint>,
) {
  if (value === null) return;
  if (!Array.isArray(value) || value.length > 256)
    return refuse('token metadata vector differs');
  const seen = new Set<number>();
  for (const valueRow of value) {
    const raw = object(valueRow);
    fields(
      raw,
      ['accountIndex', 'mint', 'uiTokenAmount'],
      ['owner', 'programId'],
    );
    const index = Number(uint(raw.accountIndex, 255n));
    if (index >= rows.length || seen.has(index))
      return refuse('token metadata index differs');
    seen.add(index);
    const row = rows[index],
      mint = address(raw.mint);
    if (
      !row ||
      row.executable ||
      ![
        'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
        'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
      ].includes(row.owner)
    )
      return refuse('token metadata has no matching raw token account');
    const bytes = Buffer.from(row.data[0], 'base64');
    if (
      bytes.length < 165 ||
      bytes.length > 16384 ||
      (row.owner === 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
        ? bytes.length !== 165
        : bytes.length !== 165 && bytes[165] !== 2) ||
      ![1, 2].includes(bytes[108]) ||
      bs58.encode(bytes.subarray(0, 32)) !== mint
    )
      return refuse('token metadata raw header differs');
    if (
      raw.owner != null &&
      address(raw.owner) !== bs58.encode(bytes.subarray(32, 64))
    )
      return refuse('token metadata owner differs');
    if (raw.programId != null && address(raw.programId) !== row.owner)
      return refuse('token metadata program differs');
    const units = object(raw.uiTokenAmount);
    fields(units, ['amount', 'decimals', 'uiAmount', 'uiAmountString']);
    if (
      typeof units.amount !== 'string' ||
      !/^(0|[1-9]\d{0,19})$/.test(units.amount) ||
      BigInt(units.amount) > U64 ||
      BigInt(units.amount) !== bytes.readBigUInt64LE(64)
    )
      return refuse('token metadata amount differs');
    const decimals = uint(units.decimals, 255n);
    if (decimalsByMint.has(mint) && decimalsByMint.get(mint) !== decimals)
      return refuse('token metadata precision is inconsistent');
    decimalsByMint.set(mint, decimals);
    // These are presentation fields, never raw units or economic inputs. Scaled
    // token displays may differ from base units; separate mint admission remains mandatory.
    if (
      typeof units.uiAmountString !== 'string' ||
      units.uiAmountString.length > 300 ||
      !/^(0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(units.uiAmountString) ||
      !Number.isFinite(Number(units.uiAmountString))
    )
      return refuse('token display string differs from profile');
    if (units.uiAmount !== null) {
      const decimal = inspectJitoSimulationDecimal(units.uiAmount);
      if (typeof units.uiAmount !== 'bigint' && decimal === null)
        return refuse('token display number type differs');
      const text =
        typeof units.uiAmount === 'bigint'
          ? units.uiAmount.toString()
          : decimal!;
      const number = Number(text);
      if (
        text.startsWith('-') ||
        !Number.isFinite(number) ||
        number < 0 ||
        number > Number(U64)
      )
        return refuse('token display number exceeds profile');
    }
  }
}
function metadata(
  raw: Record<string, unknown>,
  before: (Account | null)[],
  after: (Account | null)[],
  decimalsByMint: Map<string, bigint>,
) {
  for (const [name, rows] of [
    ['preBalances', before],
    ['postBalances', after],
  ] as const)
    if (Object.hasOwn(raw, name)) balances(raw[name], rows);
  for (const [name, rows] of [
    ['preTokenBalances', before],
    ['postTokenBalances', after],
  ] as const)
    if (Object.hasOwn(raw, name))
      tokenMetadata(raw[name], rows, decimalsByMint);
  if (raw.logs != null) {
    if (!Array.isArray(raw.logs) || raw.logs.length > 4096)
      return refuse('log metadata exceeds profile');
    let size = 0;
    for (const line of raw.logs) {
      if (typeof line !== 'string' || line.length > 16384)
        return refuse('log metadata exceeds profile');
      size += new TextEncoder().encode(line).length;
      if (size > 65536) return refuse('log metadata exceeds profile');
    }
  }
  if (raw.returnData != null) {
    const data = object(raw.returnData);
    fields(data, ['programId', 'data']);
    address(data.programId);
    if (
      !Array.isArray(data.data) ||
      data.data.length !== 2 ||
      data.data[1] !== 'base64'
    )
      return refuse('return metadata differs');
    binary(data.data[0], 1024);
  }
}
const authority = {
  signingAllowed: false as const,
  executionAllowed: false as const,
  automaticExecutionAllowed: false as const,
  providerQualified: false as const,
  sourceAuthenticated: false as const,
  altStateVerified: false as const,
  runtimePrivilegesVerified: false as const,
  signatureVerified: false as const,
  economicOutputVerified: false as const,
};
async function sha(bytes: Uint8Array) {
  return Buffer.from(
    await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes).buffer),
  ).toString('hex');
}

/** Server-internal, unmounted raw Rust-frame profile. No fetch, signing or broadcast.
 * Captures raw bytes before field-specific projection. Caller request/provider/fee/ALT
 * provenance is NOT authenticated. Raw capture is private evidence, never a public DTO.
 * Persist original rawBody/hash, not the bigint/opaque-token-bearing parsed value.
 * Invalid policy/pre-read cancellation throws and leaves the body with its caller;
 * after capture starts, failures return a refusal and the reader owns its cleanup. */
export async function readJitoSimulationResponse(input: {
  requestBankSelection?: 'confirmed';
  profile: 'jito-rust-raw-frames-v1';
  packets: JitoBundleSimulationPacket[];
  minimumSlot: number;
  simulationBankSlot: number;
  bankEncoding: 'slot-object' | 'numeric-slot';
  verifySignatures: boolean;
  rpcId: string;
  body: ReadableStream<Uint8Array> | null;
  signal: AbortSignal;
}) {
  // Top-level request primitives and the stream handle are captured before awaits.
  // The existing builder snapshots packets before its first await as well.
  const read = <K extends keyof typeof input>(key: K): (typeof input)[K] => {
    const d = Object.getOwnPropertyDescriptor(input, key);
    if (!d || !Object.hasOwn(d, 'value'))
      return refuse('request data property required');
    return d.value as (typeof input)[K];
  };
  const profile = read('profile'),
    minimumSlot = read('minimumSlot'),
    simulationBankSlot = read('simulationBankSlot'),
    rpcId = read('rpcId'),
    signal = read('signal') as AbortSignal,
    body = read('body') as ReadableStream<Uint8Array> | null;
  if (
    profile !== 'jito-rust-raw-frames-v1' ||
    typeof rpcId !== 'string' ||
    !/^[A-Za-z0-9._:-]{1,128}$/.test(rpcId) ||
    !Number.isSafeInteger(minimumSlot) ||
    minimumSlot < 0 ||
    !Number.isSafeInteger(simulationBankSlot) ||
    simulationBankSlot < minimumSlot ||
    simulationBankSlot - minimumSlot > 32
  )
    return refuse('request profile or bank bounds differ');
  const aborted = () =>
    Object.getOwnPropertyDescriptor(
      AbortSignal.prototype,
      'aborted',
    )!.get!.call(signal) as boolean;
  try {
    if (aborted()) return refuse('request interrupted');
  } catch {
    return refuse('request interrupted or signal invalid');
  }
  const request = await buildJitoBundleSimulationRequest(
    read('packets'),
    simulationBankSlot,
    {
      bankEncoding: read('bankEncoding'),
      verifySignatures: read('verifySignatures'),
    },
  );
  const selection = Object.getOwnPropertyDescriptor(input, 'requestBankSelection');
  if (selection && (!Object.hasOwn(selection, 'value') || selection.value !== 'confirmed'))
    return refuse('request bank selection differs');
  // Bind the actual commitment-selected wire request, never an unsent slot request.
  const params = selection ? structuredClone(request.params) : request.params;
  if (selection) (params[1] as unknown as Record<string, unknown>).simulationBank = { commitment: { commitment: 'confirmed' } };
  const requestBody = JSON.stringify({
    jsonrpc: '2.0',
    id: rpcId,
    method: request.method,
    params,
  });
  const requestEvidence = {
    ...(selection ? { requestBankSelection: 'confirmed' as const } : {}),
    profile,
    bankEncoding: request.bankEncoding,
    rpcId,
    body: requestBody,
    sha256: await sha(new TextEncoder().encode(requestBody)),
  };
  if (aborted()) return refuse('request interrupted');
  let capture: Awaited<ReturnType<typeof readJitoSimulationPayload>>;
  try {
    capture = await readJitoSimulationPayload(body, signal, 4194304, {
      allowDecimalTokens: true,
    });
  } catch {
    return {
      status: 'refused' as const,
      reason: 'raw response unavailable',
      request: requestEvidence,
      rawResponse: null,
      ...authority,
    };
  }
  const failed = (reason: string) => ({
    status: 'refused' as const,
    reason,
    request: requestEvidence,
    rawResponse: capture,
    ...authority,
  });
  try {
    const envelope = object(capture.value);
    fields(envelope, ['jsonrpc', 'id'], ['result', 'error']);
    if (
      envelope.jsonrpc !== '2.0' ||
      envelope.id !== rpcId ||
      Object.hasOwn(envelope, 'result') === Object.hasOwn(envelope, 'error')
    )
      return refuse('RPC envelope or exact string id differs');
    if (Object.hasOwn(envelope, 'error')) {
      const error = object(envelope.error);
      fields(error, ['code', 'message'], ['data']);
      if (
        typeof error.code !== 'bigint' ||
        error.code < -2147483648n ||
        error.code > 2147483647n ||
        typeof error.message !== 'string' ||
        error.message.length > 4096
      )
        return refuse('RPC error shape differs');
      return failed('provider RPC refusal');
    }
    const result = object(envelope.result);
    fields(result, ['context', 'value']);
    const context = object(result.context),
      value = object(result.value);
    fields(context, ['slot'], ['apiVersion']);
    if (
      context.apiVersion !== undefined &&
      (typeof context.apiVersion !== 'string' ||
        !/^[A-Za-z0-9.+-]{1,64}$/.test(context.apiVersion))
    )
      return refuse('context metadata differs');
    const slot = Number(uint(context.slot, BigInt(Number.MAX_SAFE_INTEGER)));
    if (slot !== simulationBankSlot) return refuse('returned bank differs');
    fields(value, ['summary', 'transactionResults']);
    if (
      value.summary !== 'succeeded' ||
      !Array.isArray(value.transactionResults) ||
      value.transactionResults.length !== request.packetBindings.length
    )
      return refuse('failed or partial raw result');
    const decimalsByMint = new Map<string, bigint>();
    const normalizedFrames = value.transactionResults.map((item, index) => {
      const raw = object(item);
      fields(
        raw,
        [
          'err',
          'fee',
          'unitsConsumed',
          'loadedAccountsDataSize',
          'preExecutionAccounts',
          'postExecutionAccounts',
          'loadedAddresses',
        ],
        [
          'logs',
          'returnData',
          'replacementBlockhash',
          'preBalances',
          'postBalances',
          'preTokenBalances',
          'postTokenBalances',
          'transaction',
        ],
      );
      if (
        raw.err !== null ||
        (Object.hasOwn(raw, 'replacementBlockhash') &&
          raw.replacementBlockhash !== null)
      )
        return refuse('failed or replaced raw frame');
      const keys =
        request.params[1].preExecutionAccountsConfigs[index].addresses;
      const before = accounts(raw.preExecutionAccounts, keys.length),
        after = accounts(raw.postExecutionAccounts, keys.length);
      metadata(raw, before, after, decimalsByMint);
      const loaded = object(raw.loadedAddresses);
      fields(loaded, ['writable', 'readonly']);
      const vector = (v: unknown) => {
        if (!Array.isArray(v) || v.length > 256)
          return refuse('raw loaded address vector differs');
        return v.map(address);
      };
      if (
        raw.transaction !== undefined &&
        (typeof raw.transaction !== 'string' ||
          raw.transaction !== request.packetBindings[index].transaction)
      )
        return refuse('transaction echo differs');
      return {
        err: null,
        fee: uint(raw.fee).toString(),
        unitsConsumed: Number(uint(raw.unitsConsumed, 1400000n)),
        loadedAccountsDataSize: uint(
          raw.loadedAccountsDataSize,
          67108864n,
        ).toString(),
        loadedAddresses: {
          writable: vector(loaded.writable),
          readonly: vector(loaded.readonly),
        },
        preExecutionAccounts: before,
        postExecutionAccounts: after,
      };
    });
    const normalizedResult = {
      context: { slot },
      value: { summary: 'succeeded', transactionResults: normalizedFrames },
    };
    let frames;
    try {
      frames = await verifyJitoBundleSimulationFrames({
        packets: request.packetBindings,
        minimumSlot,
        simulationBankSlot,
        result: normalizedResult,
      });
    } catch {
      return failed('normalized frame checks refused');
    }
    if (aborted()) return failed('request interrupted');
    return {
      status: 'admitted' as const,
      request: requestEvidence,
      rawResponse: capture,
      normalizedResult,
      frames,
      frameIntegrityVerified: true as const,
      metadataScope:
        'Shape, integer types and observed balance/token headers checked; display values are discarded, mint precision/source/runtime remain unqualified.',
      ...authority,
    };
  } catch (error) {
    return failed(
      error && typeof error === 'object'
        ? (reasons.get(error) ?? 'raw schema unavailable')
        : 'raw schema unavailable',
    );
  }
}
