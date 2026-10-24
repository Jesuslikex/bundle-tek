const MAX_BYTES = 4 * 1024 * 1024;
const MAX_DEPTH = 32;
const MAX_NODES = 100000;
const MAX_MEMBERS = 4096;
const MAX_CHUNKS = 100000;
class JitoSimulationJsonError extends Error {}
const ownErrors = new WeakMap<object, string>();
function ownError(reason: string) {
  const error = new JitoSimulationJsonError(`Jito simulation JSON: ${reason}.`);
  ownErrors.set(error, reason);
  return error;
}
const fail = (reason: string): never => {
  throw ownError(reason);
};
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const nativeLength = (value: Uint8Array) =>
  Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength')!.get!.call(
    value,
  ) as number;
const nativeOffset = (value: Uint8Array) =>
  Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteOffset')!.get!.call(
    value,
  ) as number;
const nativeBuffer = (value: Uint8Array) =>
  Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer')!.get!.call(
    value,
  ) as ArrayBuffer;

/** Strict JSON data parser: numeric tokens remain distinct from JSON strings as exact bigint values.
 * Integer tokens have at most 20 decimal digits; field-specific ranges remain caller checks.
 * Escaped unpaired surrogates are refused, as are duplicate decoded object keys.
 * These are transport/data bounds only, not provider or execution qualification. */
function parseStrictJson(text: string): unknown {
  let at = 0,
    nodes = 0;
  const escapes: Record<string, string> = {
    '"': '"',
    '\\': '\\',
    '/': '/',
    b: '\b',
    f: '\f',
    n: '\n',
    r: '\r',
    t: '\t',
  };
  const whitespace = () => {
    while (at < text.length && /[\x20\t\r\n]/.test(text[at])) at++;
  };
  function string(): string {
    if (text[at++] !== '"') return fail('expected string');
    const chunks: string[] = [];
    let buffer = '',
      run = at;
    const append = (v: string) => {
      buffer += v;
      if (buffer.length >= 4096) {
        chunks.push(buffer);
        buffer = '';
      }
    };
    for (; at < text.length; at++) {
      const code = text.charCodeAt(at);
      if (code < 32) return fail('unescaped control character');
      if (text[at] === '"') {
        append(text.slice(run, at));
        at++;
        const result = chunks.join('') + buffer;
        for (let i = 0; i < result.length; i++) {
          const unit = result.charCodeAt(i);
          if (unit >= 0xd800 && unit <= 0xdbff) {
            const low = result.charCodeAt(++i);
            if (!(low >= 0xdc00 && low <= 0xdfff))
              return fail('unpaired surrogate');
          } else if (unit >= 0xdc00 && unit <= 0xdfff)
            return fail('unpaired surrogate');
        }
        return result;
      }
      if (text[at] !== '\\') continue;
      append(text.slice(run, at));
      const escape = text[++at];
      if (escape === 'u') {
        const hex = text.slice(at + 1, at + 5);
        if (!/^[0-9a-fA-F]{4}$/.test(hex))
          return fail('invalid Unicode escape');
        append(String.fromCharCode(parseInt(hex, 16)));
        at += 4;
      } else {
        if (!Object.hasOwn(escapes, escape))
          return fail('invalid string escape');
        append(escapes[escape]);
      }
      run = at + 1;
    }
    return fail('unterminated string');
  }
  function value(depth: number): unknown {
    if (++nodes > MAX_NODES) return fail('node bound');
    whitespace();
    const first = text[at];
    if (first === '"') return string();
    if (first === '[' || first === '{') {
      if (depth >= MAX_DEPTH) return fail('depth bound');
      at++;
      whitespace();
      const array = first === '[',
        closing = array ? ']' : '}';
      const out: unknown[] | Record<string, unknown> = array
        ? []
        : Object.create(null);
      const keys = new Set<string>();
      let count = 0;
      if (text[at] === closing) {
        at++;
        return out;
      }
      for (;;) {
        if (count >= MAX_MEMBERS) return fail('container member bound');
        whitespace();
        let name = '';
        if (!array) {
          if (text[at] !== '"') return fail('object key must be string');
          name = string();
          if (keys.has(name)) return fail('duplicate object key');
          keys.add(name);
          whitespace();
          if (text[at++] !== ':') return fail('expected colon');
        }
        const item = value(depth + 1);
        if (array) (out as unknown[]).push(item);
        else (out as Record<string, unknown>)[name] = item;
        count++;
        whitespace();
        if (text[at] === closing) {
          at++;
          return out;
        }
        if (text[at++] !== ',')
          return fail('expected comma or closing delimiter');
      }
    }
    for (const [word, result] of [
      ['true', true],
      ['false', false],
      ['null', null],
    ] as const)
      if (text.startsWith(word, at)) {
        at += word.length;
        return result;
      }
    if (first === '-' || (first >= '0' && first <= '9')) {
      const start = at;
      if (text[at] === '-') at++;
      const digitsStart = at;
      if (text[at] === '0') at++;
      else {
        if (!(text[at] >= '1' && text[at] <= '9'))
          return fail('invalid integer');
        while (text[at] >= '0' && text[at] <= '9') {
          at++;
          if (at - digitsStart > 20) return fail('integer digit bound');
        }
      }
      const token = text.slice(start, at);
      if (
        token === '-0' ||
        text[at] === '.' ||
        text[at] === 'e' ||
        text[at] === 'E'
      )
        return fail('noncanonical integer');
      return BigInt(token);
    }
    return fail('invalid value');
  }
  const result = value(0);
  whitespace();
  if (at !== text.length) return fail('trailing JSON content');
  return result;
}

/** Bounded UTF-8 JSON transport reader only. No network client or authority is created.
 * The limit is an actual streamed-byte bound; JSON containers allow at most 4096
 * members, 32 nested containers, 100000 value nodes and 100000 stream chunks
 * including empty chunks. A UTF-8 BOM is refused. Early option/signal refusal
 * leaves the body with its caller; after acquiring a reader this function cleans
 * it up. Caller-created stream methods are trusted code, not a sandbox. */
export async function readJitoSimulationJson(
  stream: ReadableStream<Uint8Array> | null,
  signal: AbortSignal,
  limit = MAX_BYTES,
): Promise<unknown> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_BYTES)
    return fail('invalid byte bound');
  let aborted: () => boolean;
  try {
    const getter = Object.getOwnPropertyDescriptor(
      AbortSignal.prototype,
      'aborted',
    )!.get!.bind(signal);
    if (!(signal instanceof AbortSignal)) return fail('invalid abort signal');
    aborted = () => getter() as boolean;
    aborted(); // Native brand check, without invoking a caller-defined getter or abort reason.
  } catch {
    return fail('invalid abort signal');
  }
  if (aborted()) return fail('interrupted');
  if (!stream) return fail('missing body');
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = stream.getReader();
  } catch {
    return fail('reader unavailable');
  }
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  let finished = false,
    size = 0,
    chunks = 0,
    text = '',
    rejectAbort!: (reason: Error) => void;
  const interrupted = new Promise<never>((_, reject) => {
    rejectAbort = reject;
  });
  // The signal can abort before the first race is installed.
  void interrupted.catch(() => {});
  const abort = () => {
    rejectAbort(ownError('interrupted'));
    void reader.cancel().catch(() => {});
  };
  EventTarget.prototype.addEventListener.call(signal, 'abort', abort, {
    once: true,
  });
  if (aborted()) abort();
  const readBody = async () => {
    for (;;) {
      if (aborted()) return fail('interrupted');
      const part = await reader.read();
      if (aborted()) return fail('interrupted');
      if (part.done) {
        finished = true;
        break;
      }
      // Empty chunks must also consume a finite budget. Otherwise an immediate
      // empty-chunk loop can starve timer-based cancellation without using bytes.
      if (++chunks > MAX_CHUNKS) return fail('chunk bound');
      const chunk = part.value;
      if (!(chunk instanceof Uint8Array)) return fail('non-byte body');
      // Intrinsics read actual view geometry, never an overridden byteLength.
      const length = nativeLength(chunk);
      size += length;
      if (size > limit) return fail('byte bound');
      const buffer = nativeBuffer(chunk);
      if (!(buffer instanceof ArrayBuffer))
        return fail('non-private byte body');
      const bytes = new Uint8Array(length);
      bytes.set(new Uint8Array(buffer, nativeOffset(chunk), length));
      try {
        text += decoder.decode(bytes, { stream: true });
      } catch {
        return fail('invalid UTF-8');
      }
    }
    try {
      text += decoder.decode();
    } catch {
      return fail('invalid UTF-8');
    }
    return text;
  };
  try {
    // One abort reaction for the whole read, rather than one retained reaction per chunk.
    const text = await Promise.race([readBody(), interrupted]);
    if (aborted()) return fail('interrupted');
    return parseStrictJson(text);
  } catch (error) {
    // A private class alone is forgeable through a previously caught constructor.
    // Reconstruct only reasons created here, ignoring even a mutated own message.
    const reason =
      error !== null && typeof error === 'object'
        ? ownErrors.get(error)
        : undefined;
    return fail(reason ?? 'stream unavailable');
  } finally {
    EventTarget.prototype.removeEventListener.call(signal, 'abort', abort);
    if (!finished) void reader.cancel().catch(() => {});
    try {
      reader.releaseLock();
    } catch {
      /* Cleanup must not expose underlying provider details. */
    }
  }
}
