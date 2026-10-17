import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getD1 } from '@/db';

// Referral codes and who joined through them. Bundle takes no trading fees,
// so this tracks referrals only; there is nothing to pay out.
export const dynamic = 'force-dynamic';
const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
// No 0/O/1/I/L to keep codes easy to read aloud.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const REFERRAL_CODE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/;

function newCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('');
}

async function summary(db: D1Database, userId: string) {
  const [code, count, referredBy] = await Promise.all([
    db
      .prepare('SELECT code FROM referral_codes WHERE owner_id=?')
      .bind(userId)
      .first<{ code: string }>(),
    db
      .prepare('SELECT COUNT(*) AS n FROM referrals WHERE referrer_id=?')
      .bind(userId)
      .first<{ n: number }>(),
    db
      .prepare('SELECT code, created_at AS at FROM referrals WHERE member_id=?')
      .bind(userId)
      .first<{ code: string; at: string }>(),
  ]);
  return {
    code: code?.code ?? null,
    referredCount: count?.n ?? 0,
    referredBy: referredBy
      ? { code: referredBy.code, at: referredBy.at }
      : null,
  };
}

export async function GET() {
  const user = await getChatGPTUser();
  if (!user) return json({ error: 'Sign in to see referrals.' }, 401);
  try {
    return json(await summary(getD1(), user.userId));
  } catch {
    return json({ error: 'Referrals temporarily unavailable.' }, 503);
  }
}

export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return json({ error: 'Sign in to use referrals.' }, 401);
  if (
    !request.headers
      .get('content-type')
      ?.toLowerCase()
      .startsWith('application/json')
  )
    return json({ error: 'JSON required.' }, 415);
  const origin = request.headers.get('origin');
  if (!origin || origin !== new URL(request.url).origin)
    return json({ error: 'Cross-origin request rejected.' }, 403);
  let body: { action?: unknown; code?: unknown };
  try {
    const text = await request.text();
    if (text.length > 256) return json({ error: 'Request too large.' }, 413);
    body = JSON.parse(text);
  } catch {
    return json({ error: 'Invalid request.' }, 400);
  }
  const db = getD1();
  const now = new Date().toISOString();
  try {
    if (body.action === 'create') {
      // Retry a few times in the unlikely case a random code collides.
      for (let i = 0; i < 5; i++) {
        await db
          .prepare(
            'INSERT OR IGNORE INTO referral_codes(owner_id,code,created_at) VALUES(?,?,?)',
          )
          .bind(user.userId, newCode(), now)
          .run();
        const value = await summary(db, user.userId);
        if (value.code) return json(value);
      }
      return json({ error: 'Could not create a code. Try again.' }, 503);
    }
    if (body.action === 'apply') {
      const code =
        typeof body.code === 'string' ? body.code.trim().toUpperCase() : '';
      if (!REFERRAL_CODE.test(code))
        return json({ error: 'Invalid referral code.' }, 400);
      const owner = await db
        .prepare('SELECT owner_id AS ownerId FROM referral_codes WHERE code=?')
        .bind(code)
        .first<{ ownerId: string }>();
      if (!owner) return json({ error: 'Referral code not found.' }, 404);
      if (owner.ownerId === user.userId)
        return json({ error: 'You cannot use your own code.' }, 409);
      const existing = await summary(db, user.userId);
      if (existing.referredBy)
        return existing.referredBy.code === code
          ? json(existing)
          : json({ error: 'A referral code is already applied.' }, 409);
      try {
        await db
          .prepare(
            'INSERT INTO referrals(member_id,referrer_id,code,created_at) VALUES(?,?,?,?)',
          )
          .bind(user.userId, owner.ownerId, code, now)
          .run();
      } catch (e) {
        if (e instanceof Error && e.message.includes('Referral loop'))
          return json({ error: 'You referred this account.' }, 409);
        const after = await summary(db, user.userId);
        if (after.referredBy?.code === code) return json(after);
        return json({ error: 'A referral code is already applied.' }, 409);
      }
      return json(await summary(db, user.userId));
    }
    return json({ error: 'Unknown action.' }, 400);
  } catch {
    return json({ error: 'Referrals temporarily unavailable.' }, 503);
  }
}
