import { timingSafeEqual } from 'node:crypto';
export function cronAuthorized(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || secret.length < 32) return false;
  const expected = Buffer.from(`Bearer ${secret}`),
    actual = Buffer.from(request.headers.get('authorization') ?? '');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
