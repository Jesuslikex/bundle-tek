/** Closed, process-local retained-byte transport. This is not provider evidence
 * admission. Only this factory's exact functions can omit live RPC pacing:
 * they have no network callback and cannot forward a request to a provider. */
const localReplays = new WeakSet<typeof fetch>();
const typedArrayByteLength = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype),
  'byteLength',
)!;
const fail = (): never => {
  throw Error('Jito retained RPC replay refused.');
};
export function isJitoRetainedRpcReplay(fetcher: typeof fetch) {
  return localReplays.has(fetcher);
}
export function createJitoRetainedRpcReplay(
  endpoint: string,
  reads: readonly { requestBody: string; rawBody: Uint8Array }[],
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const url = new URL(endpoint);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.hash ||
    !Array.isArray(reads) ||
    Reflect.ownKeys(reads).length !== reads.length + 1 ||
    reads.length < 1 ||
    reads.length > 32
  )
    return fail();
  let total = 0;
  const retained = Array.from({ length: reads.length }, (_, index) => {
    const entry = Object.getOwnPropertyDescriptor(reads, String(index));
    if (!entry?.enumerable || !Object.hasOwn(entry, 'value')) return fail();
    const read = entry.value;
    if (!read || typeof read !== 'object') return fail();
    const body = Object.getOwnPropertyDescriptor(read, 'requestBody'),
      bytes = Object.getOwnPropertyDescriptor(read, 'rawBody');
    if (
      !body ||
      !bytes ||
      !Object.hasOwn(body, 'value') ||
      !Object.hasOwn(bytes, 'value') ||
      typeof body.value !== 'string' ||
      Buffer.byteLength(body.value) > 32768 ||
      !(bytes.value instanceof Uint8Array)
    )
      return fail();
    let rawBody: Uint8Array;
    try {
      // Intrinsic internal-slot access refuses proxies and ignores spoofed own
      // byteLength/iterator properties. The typed-array constructor copies real
      // internal bytes without consulting a caller's iterator or species.
      const size = typedArrayByteLength.get!.call(bytes.value);
      if (size < 1 || size > 524288) return fail();
      rawBody = new Uint8Array(bytes.value as Uint8Array);
      if (rawBody.byteLength !== size) return fail();
    } catch {
      return fail();
    }
    total += rawBody.byteLength;
    if (total > 16777216) return fail();
    return {
      requestBody: body.value as string,
      rawBody,
    };
  });
  let next = 0,
    closed = false;
  const fetcher: typeof fetch = async (target, init) => {
    try {
      signal.throwIfAborted();
      const read = retained[next];
      if (
        closed ||
        !read ||
        typeof target !== 'string' ||
        target !== endpoint ||
        init?.method !== 'POST' ||
        init.signal !== signal ||
        init.body !== read.requestBody
      )
        return fail();
      next++;
      return new Response(Uint8Array.from(read.rawBody), { status: 200 });
    } catch {
      closed = true;
      return fail();
    }
  };
  Object.freeze(fetcher);
  localReplays.add(fetcher);
  return Object.freeze({
    fetcher,
    assertComplete() {
      signal.throwIfAborted();
      if (closed || next !== retained.length) return fail();
      closed = true;
    },
  });
}
