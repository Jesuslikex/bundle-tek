import { createHash } from 'node:crypto';
const CLOCK = 'SysvarC1ock11111111111111111111111111111111';
export function hasStockClockRequest(body) {
  return (Array.isArray(body) ? body : [body]).some(
    (r) =>
      r?.method === 'getMultipleAccounts' &&
      Array.isArray(r.params?.[0]) &&
      r.params[0].includes(CLOCK),
  );
}
export function stockClockWire(body, text, receivedServerTimeMs) {
  const parsed = JSON.parse(text, (_k, value, context) =>
    typeof value === 'number' && context?.source ? context.source : value,
  );
  const requests = Array.isArray(body) ? body : [body],
    responses = Array.isArray(parsed) ? parsed : [parsed];
  const observations = [];
  for (const request of requests) {
    if (!hasStockClockRequest(request)) continue;
    const matching = responses.filter(
      (r) => String(r?.id) === String(request.id),
    );
    if (matching.length !== 1)
      throw Error('Wire Clock response identity unavailable.');
    const response = matching[0];
    const contextSlot = String(response.result?.context?.slot);
    if (
      !/^[1-9]\d{0,15}$/.test(contextSlot) ||
      !Number.isSafeInteger(Number(contextSlot)) ||
      response.error
    )
      throw Error('Wire Clock context unavailable.');
    for (const [index, key] of request.params[0].entries()) {
      if (key !== CLOCK) continue;
      const account = response.result.value?.[index];
      const bytes = Buffer.from(account?.data?.[0] ?? '', 'base64');
      if (
        account?.data?.[1] !== 'base64' ||
        bytes.length !== 40 ||
        bytes.toString('base64') !== account.data[0]
      )
        throw Error('Wire Clock bytes unavailable.');
      observations.push({
        requestId: String(request.id),
        accountIndex: index,
        contextSlot,
        clockSlot: bytes.readBigUInt64LE(0).toString(),
        unixTimestamp: bytes.readBigInt64LE(32).toString(),
        clockDataSha256: createHash('sha256').update(bytes).digest('hex'),
        receivedServerTimeMs,
        commitment: request.params[1]?.commitment ?? null,
        requestedFloor: request.params[1]?.minContextSlot ?? null,
      });
    }
  }
  return observations;
}

// Bounded clone only. Original response/bytes and production transport validation
// remain untouched. No extra RPC or retry; diagnostic overhead is included.
export async function captureStockClockWire(response, request, now = Date.now) {
  if (!hasStockClockRequest(request)) return [];
  const reader = response.clone().body?.getReader();
  if (!reader) throw Error('Wire Clock body unavailable.');
  let size = 0,
    text = '';
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 2097152) {
        void reader.cancel().catch(() => {});
        throw Error('Wire Clock observation exceeds bound.');
      }
      text += decoder.decode(part.value, { stream: true });
    }
    text += decoder.decode();
    return stockClockWire(request, text, now());
  } finally {
    reader.releaseLock();
  }
}
