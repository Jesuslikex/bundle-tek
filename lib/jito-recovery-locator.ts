import { JITO_RECOVERY_FILE_MAX_BYTES } from './jito-packet-recovery';
import { readJitoSimulationJson } from './jito-simulation-json';
import { UUID } from './wallet-operation';

export type JitoRecoveryLocator = Readonly<{
  projectId: string;
  sessionId: string;
  bundleId: string;
  sha256: string;
  packet: number;
}>;

const fields = [
  'format',
  'projectId',
  'sessionId',
  'bundleId',
  'sha256',
  'packet',
  'signature',
  'transaction',
] as const;
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const lengthOf = (input: Uint8Array) =>
  Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength')!.get!.call(
    input,
  ) as number;
const offsetOf = (input: Uint8Array) =>
  Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteOffset')!.get!.call(
    input,
  ) as number;
const bufferOf = (input: Uint8Array) =>
  Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer')!.get!.call(
    input,
  ) as unknown;
const tagOf = (input: Uint8Array) =>
  Object.getOwnPropertyDescriptor(
    typedArrayPrototype,
    Symbol.toStringTag,
  )!.get!.call(input) as unknown;
const fail = (): never => {
  throw new Error('Recovery file is unavailable or invalid.');
};

/** Extract only non-secret lookup hints from one local byte snapshot.
 * This does not verify a signature, authenticate an owner, find a record,
 * or authorize signing, registration or submission. The caller must fetch the
 * exact owned record and cryptographically verify the same private file.
 * Parsing is not caller-cancellable; the consumer must fence its context after
 * awaiting this bounded local operation. No secure memory erasure is claimed. */
export async function readJitoRecoveryLocator(
  input: Uint8Array,
): Promise<JitoRecoveryLocator> {
  try {
    // Reject proxies without triggering their getPrototypeOf or get traps.
    // The intrinsic typed-array brand also excludes DataView and other views.
    if (!ArrayBuffer.isView(input) || tagOf(input) !== 'Uint8Array')
      return fail();
    const length = lengthOf(input);
    const offset = offsetOf(input);
    const buffer = bufferOf(input);
    if (
      !Number.isSafeInteger(length) ||
      length < 1 ||
      length > JITO_RECOVERY_FILE_MAX_BYTES ||
      !Number.isSafeInteger(offset) ||
      !(buffer instanceof ArrayBuffer)
    )
      return fail();
    // Copy before the first await so caller mutation cannot change parsed bytes.
    const bytes = new Uint8Array(length);
    bytes.set(new Uint8Array(buffer, offset, length));
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
    const parsed = await readJitoSimulationJson(
      stream,
      new AbortController().signal,
      JITO_RECOVERY_FILE_MAX_BYTES,
    );
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed) ||
      Object.getPrototypeOf(parsed) !== null
    )
      return fail();
    const names = Reflect.ownKeys(parsed);
    if (
      names.length !== fields.length ||
      names.some(
        (name) =>
          typeof name !== 'string' ||
          !fields.includes(name as (typeof fields)[number]),
      )
    )
      return fail();
    const data = Object.create(null) as Record<string, unknown>;
    for (const name of fields) {
      const descriptor = Object.getOwnPropertyDescriptor(parsed, name);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value'))
        return fail();
      data[name] = descriptor.value;
    }
    if (
      data.format !== 'jito-signed-packet-recovery-v1' ||
      typeof data.projectId !== 'string' ||
      !UUID.test(data.projectId) ||
      typeof data.sessionId !== 'string' ||
      !UUID.test(data.sessionId) ||
      typeof data.bundleId !== 'string' ||
      !UUID.test(data.bundleId) ||
      typeof data.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(data.sha256) ||
      typeof data.packet !== 'bigint' ||
      data.packet < 0n ||
      data.packet > 4n ||
      typeof data.signature !== 'string' ||
      !data.signature ||
      typeof data.transaction !== 'string' ||
      !data.transaction
    )
      return fail();
    return Object.freeze({
      projectId: data.projectId,
      sessionId: data.sessionId,
      bundleId: data.bundleId,
      sha256: data.sha256,
      packet: Number(data.packet),
    });
  } catch {
    // Never include file contents, parser internals or caller-supplied errors.
    return fail();
  }
}
