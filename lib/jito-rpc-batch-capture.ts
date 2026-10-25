import {
  readJitoSimulationPayload,
  type JitoSimulationPayload,
} from './jito-simulation-json';

const authority = {
  signingAllowed: false as const,
  executionAllowed: false as const,
  automaticExecutionAllowed: false as const,
  providerQualified: false as const,
  sourceAuthenticated: false as const,
  signatureVerified: false as const,
  altStateVerified: false as const,
  runtimePrivilegesVerified: false as const,
  economicOutputVerified: false as const,
};
export type JitoRpcBatchMember = {
  id: string;
  start: number;
  end: number;
  sha256: string;
  rawBody: Uint8Array;
};
type Reason = 'response-invalid' | 'batch-envelope-invalid' | 'interrupted';
export type JitoRpcBatchCapture = typeof authority & {
  profile: 'jito-rpc-batch-capture-v1';
} & (
    | {
        status: 'captured';
        rawResponse: JitoSimulationPayload;
        members: JitoRpcBatchMember[];
      }
    | {
        status: 'refused';
        reason: Reason;
        rawResponse: JitoSimulationPayload | null;
      }
  );

function snapshotIds(value: readonly string[]): string[] {
  const fail = (): never => {
    throw Error('Jito RPC batch: invalid expected IDs.');
  };
  try {
    if (
      !Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Array.prototype ||
      value.length < 2 ||
      value.length > 6 ||
      Reflect.ownKeys(value).length !== value.length + 1
    )
      return fail();
    const ids: string[] = [];
    for (let i = 0; i < value.length; i++) {
      const d = Object.getOwnPropertyDescriptor(value, String(i));
      if (
        !d?.enumerable ||
        !Object.hasOwn(d, 'value') ||
        typeof d.value !== 'string' ||
        !/^[A-Za-z0-9._:-]{1,128}$/.test(d.value) ||
        ids.includes(d.value)
      )
        return fail();
      ids.push(d.value);
    }
    return ids;
  } catch {
    return fail();
  }
}

/** Byte offsets refer to the complete verified UTF-8 parent, with exclusive ends.
 * This scanner never decodes or serializes numeric values. Full JSON grammar and
 * UTF-8 validity have already been checked by the bounded lossless reader. */
function ranges(bytes: Uint8Array): { start: number; end: number }[] {
  let i = 0;
  const whitespace = () => {
    while ([9, 10, 13, 32].includes(bytes[i])) i++;
  };
  whitespace();
  if (bytes[i++] !== 91) throw Error('array');
  const result: { start: number; end: number }[] = [];
  while (i < bytes.length) {
    whitespace();
    if (bytes[i] !== 123) throw Error('object');
    const start = i;
    let depth = 0;
    let string = false;
    let escape = false;
    for (; i < bytes.length; i++) {
      const b = bytes[i];
      if (string) {
        if (escape) escape = false;
        else if (b === 92) escape = true;
        else if (b === 34) string = false;
      } else if (b === 34) string = true;
      else if (b === 123 || b === 91) depth++;
      else if (b === 125 || b === 93) {
        depth--;
        if (depth === 0) {
          i++;
          break;
        }
      }
    }
    if (depth !== 0 || string) throw Error('incomplete');
    result.push({ start, end: i });
    whitespace();
    if (bytes[i] === 44) {
      i++;
      continue;
    }
    if (bytes[i++] !== 93) throw Error('end');
    whitespace();
    if (i !== bytes.length) throw Error('trailing');
    return result;
  }
  throw Error('incomplete');
}

/** Private, mutable retained evidence only. No source authentication or public DTO
 * admission is implied. Invalid options/pre-abort leave stream ownership with the
 * caller; once reading starts the existing reader owns its cleanup. */
export async function readJitoRpcBatchCapture(
  body: ReadableStream<Uint8Array> | null,
  signal: AbortSignal,
  expectedIds: readonly string[],
): Promise<JitoRpcBatchCapture> {
  const ids = snapshotIds(expectedIds);
  let aborted: () => boolean;
  try {
    const getter = Object.getOwnPropertyDescriptor(
      AbortSignal.prototype,
      'aborted',
    )!.get!.bind(signal);
    aborted = () => getter() as boolean;
    if (aborted()) throw Error('aborted');
  } catch {
    throw Error('Jito RPC batch: invalid or interrupted signal.');
  }
  let rawResponse: JitoSimulationPayload | null = null;
  const refused = (reason: Reason): JitoRpcBatchCapture => ({
    ...authority,
    profile: 'jito-rpc-batch-capture-v1',
    status: 'refused',
    reason,
    rawResponse,
  });
  try {
    rawResponse = await readJitoSimulationPayload(
      body,
      signal,
      4 * 1024 * 1024,
      {
        allowDecimalTokens: true,
      },
    );
  } catch {
    return refused(aborted() ? 'interrupted' : 'response-invalid');
  }
  let rejectAbort!: (reason: Error) => void;
  const interrupted = new Promise<never>((_, reject) => {
    rejectAbort = reject;
  });
  void interrupted.catch(() => {});
  const abort = () => rejectAbort(Error('interrupted'));
  EventTarget.prototype.addEventListener.call(signal, 'abort', abort, {
    once: true,
  });
  try {
    if (aborted()) return refused('interrupted');
    const value = rawResponse.value;
    if (!Array.isArray(value) || value.length !== ids.length)
      return refused('batch-envelope-invalid');
    for (let i = 0; i < ids.length; i++) {
      const member: unknown = value[i];
      if (!member || typeof member !== 'object' || Array.isArray(member))
        return refused('batch-envelope-invalid');
      const o = member as Record<string, unknown>;
      if (
        Object.keys(o).length !== 3 ||
        o.jsonrpc !== '2.0' ||
        o.id !== ids[i] ||
        Object.hasOwn(o, 'result') === Object.hasOwn(o, 'error') ||
        Object.keys(o).some(
          (k) => !['jsonrpc', 'id', 'result', 'error'].includes(k),
        )
      )
        return refused('batch-envelope-invalid');
    }
    const positions = ranges(rawResponse.rawBody);
    if (positions.length !== ids.length)
      return refused('batch-envelope-invalid');
    const members: JitoRpcBatchMember[] = [];
    for (let i = 0; i < positions.length; i++) {
      if (aborted()) return refused('interrupted');
      const { start, end } = positions[i];
      const rawBody = rawResponse.rawBody.slice(start, end);
      const digest = await Promise.race([
        crypto.subtle.digest('SHA-256', rawBody),
        interrupted,
      ]);
      if (aborted()) return refused('interrupted');
      const sha256 = Array.from(new Uint8Array(digest), (b) =>
        b.toString(16).padStart(2, '0'),
      ).join('');
      members.push({ id: ids[i], start, end, sha256, rawBody });
    }
    return {
      ...authority,
      profile: 'jito-rpc-batch-capture-v1',
      status: 'captured',
      rawResponse,
      members,
    };
  } catch {
    return refused(aborted() ? 'interrupted' : 'batch-envelope-invalid');
  } finally {
    EventTarget.prototype.removeEventListener.call(signal, 'abort', abort);
  }
}
