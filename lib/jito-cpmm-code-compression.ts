import { zstdDecompressSync, constants } from 'node:zlib';
import { snapshotJitoEvidence } from './jito-evidence-json';
const fail = (): never => {
  throw Error('CPMM compressed account evidence refused.');
};
/** Research transport codec only. Preserves metadata, requires exact sliced
 * lengths, and grants no identity, bank, fee or signing authority. */
export function decodeJitoCpmmCompressedAccounts(
  input: unknown,
  count: number,
  slice: { offset: number; length: number },
) {
  const value = snapshotJitoEvidence(input, 2097152) as {
    context: unknown;
    value: unknown[];
  };
  if (
    !Number.isSafeInteger(count) ||
    count < 1 ||
    count > 100 ||
    !Number.isSafeInteger(slice.offset) ||
    slice.offset < 0 ||
    slice.offset > 10485805 ||
    !Number.isSafeInteger(slice.length) ||
    slice.length < 1 ||
    slice.length > 737280 ||
    count * slice.length > 1048576 ||
    !value ||
    !Array.isArray(value.value) ||
    value.value.length !== count
  )
    return fail();
  let total = 0;
  value.value = value.value.map((raw) => {
    if (raw === null) return null;
    const a = raw as { space: unknown; data: unknown };
    if (
      !a ||
      typeof a.space !== 'string' ||
      !/^(0|[1-9]\d{0,7})$/.test(a.space) ||
      BigInt(a.space) > 10485805n ||
      !Array.isArray(a.data) ||
      a.data.length !== 2 ||
      a.data[1] !== 'base64+zstd' ||
      typeof a.data[0] !== 'string' ||
      a.data[0].length > 1398104
    )
      return fail();
    const compressed = Buffer.from(a.data[0], 'base64');
    if (
      compressed.toString('base64') !== a.data[0] ||
      compressed.length < 4 ||
      compressed.subarray(0, 4).toString('hex') !== '28b52ffd'
    )
      return fail();
    const expected = Math.min(
      slice.length,
      Math.max(0, Number(a.space) - slice.offset),
    );
    let decoded: { buffer: Buffer; engine: { bytesWritten: number } };
    try {
      decoded = zstdDecompressSync(compressed, {
        info: true,
        maxOutputLength: Math.max(1, expected),
        params: { [constants.ZSTD_d_windowLogMax]: 21 },
      }) as unknown as typeof decoded;
    } catch {
      return fail();
    }
    if (
      !decoded ||
      !Buffer.isBuffer(decoded.buffer) ||
      decoded.buffer.length !== expected ||
      decoded.engine?.bytesWritten !== compressed.length
    )
      return fail();
    total += decoded.buffer.length;
    if (total > 1048576) return fail();
    a.data = [Buffer.from(decoded.buffer).toString('base64'), 'base64'];
    return a;
  });
  return value;
}
