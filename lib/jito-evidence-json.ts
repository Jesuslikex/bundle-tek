/** Bounded JSON data snapshot. Does not invoke own getters, toJSON or iterators.
 * Parsed server data only; caller-created Proxy traps cannot be detected. */
export function snapshotJitoEvidence<T>(value: T, maximumBytes = 8388608): T {
  let nodes = 0,
    bytes = 0;
  const encoder = new TextEncoder();
  const fail = (): never => {
    throw Error('Jito evidence JSON shape or capacity differs.');
  };
  const copy = (v: unknown, depth: number): unknown => {
    if (++nodes > 100000 || depth > 32) return fail();
    if (v === null || typeof v === 'boolean') return v;
    if (typeof v === 'number') {
      if (!Number.isFinite(v) || Object.is(v, -0)) return fail();
      return v;
    }
    if (typeof v === 'string') {
      if (
        v.length > maximumBytes ||
        (bytes += encoder.encode(JSON.stringify(v)).length) > maximumBytes
      )
        return fail();
      return v;
    }
    if (!v || typeof v !== 'object') return fail();
    const array = Array.isArray(v);
    if (
      ![Object.prototype, null, ...(array ? [Array.prototype] : [])].includes(
        Object.getPrototypeOf(v),
      )
    )
      return fail();
    const names = Reflect.ownKeys(v).filter((k) => !(array && k === 'length'));
    if (
      names.length > 4096 ||
      names.some((k) => typeof k !== 'string') ||
      (array &&
        (names.length !== v.length || names.some((k, i) => k !== String(i))))
    )
      return fail();
    const out: Record<string, unknown> | unknown[] = array ? [] : {};
    for (const k of names) {
      const d = Object.getOwnPropertyDescriptor(v, k)!;
      if (!d.enumerable || !Object.hasOwn(d, 'value')) return fail();
      Object.defineProperty(out, k, {
        value: copy(d.value, depth + 1),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return out;
  };
  if (
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes < 1 ||
    maximumBytes > 16777216
  )
    return fail();
  const result = copy(value, 0);
  if (encoder.encode(JSON.stringify(result)).byteLength > maximumBytes)
    return fail();
  return result as T;
}
export async function jitoEvidenceSha256(bytes: Uint8Array) {
  return Buffer.from(
    await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes)),
  ).toString('hex');
}

export async function awaitJitoEvidence<T>(
  signal: AbortSignal,
  pending: Promise<T>,
): Promise<T> {
  let abort = () => {};
  const stopped = new Promise<never>((_, reject) => {
    abort = () => reject(Error('Jito evidence interrupted.'));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
  try {
    return await Promise.race([pending, stopped]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
}
