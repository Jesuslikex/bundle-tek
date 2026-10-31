/** Failure classification only. No provider message is returned, and no error
 * can turn into an admission, retry, new slot floor or execution authority. */
export function classifyJitoHeliusRefusal(input: unknown, httpStatus: number) {
  const field = (v: unknown, key: string): unknown => {
    if (!v || typeof v !== 'object') return undefined;
    const d = Object.getOwnPropertyDescriptor(v, key);
    return d && Object.hasOwn(d, 'value') ? d.value : undefined;
  };
  const count = Array.isArray(input) ? field(input, 'length') : 1;
  const rows =
    Array.isArray(input) && typeof count === 'number' && count <= 5
      ? Array.from({ length: count }, (_, i) => field(input, String(i)))
      : [input];
  let rateLimited = httpStatus === 429,
    quota = false;
  const codes: number[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const error = field(row, 'error');
    if (!error || typeof error !== 'object') continue;
    const e = { code: field(error, 'code'), message: field(error, 'message') };
    const code =
      typeof e.code === 'bigint'
        ? Number(e.code)
        : typeof e.code === 'number'
          ? e.code
          : null;
    if (code !== null && Number.isSafeInteger(code)) codes.push(code);
    const message =
      typeof e.message === 'string' && e.message.length <= 4096
        ? e.message
        : '';
    const rate = /too many requests|rate[ -]?limit/i.test(message);
    quota ||=
      /(?:credits?|quota).*(?:exhaust|exceed|deplet|insufficient)|(?:exhaust|insufficient).*(?:credits?|quota)/i.test(
        message,
      );
    rateLimited ||= quota || code === 429 || (code === -32005 && rate);
  }
  return {
    rateLimited,
    category: quota ? 'credit-quota' : rateLimited ? 'rate-limit' : 'other',
    codes,
  };
}
