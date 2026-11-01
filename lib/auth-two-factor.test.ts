import { describe, expect, it } from 'vitest';
import { createClient } from '@libsql/client';
import { readFileSync } from 'node:fs';
import { createOTP } from '@better-auth/utils/otp';
import { base32 } from '@better-auth/utils/base32';
import { createBundleAuth } from './auth';

const origin = 'http://localhost:3000';
async function migrated(files: string[]) {
  const db = createClient({ url: 'file::memory:' });
  for (const file of files)
    for (const sql of readFileSync(file, 'utf8').split(
      '--> statement-breakpoint',
    ))
      if (sql.trim()) await db.execute(sql);
  return db;
}
const base = 'drizzle/0080_remarkable_winter_soldier.sql';
const post = (
  auth: ReturnType<typeof createBundleAuth>,
  path: string,
  body: object,
  cookie = '',
) =>
  auth.handler(
    new Request(`${origin}/api/auth${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin, cookie },
      body: JSON.stringify(body),
    }),
  );
const cookies = (r: Response) =>
  r.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');

describe('two-factor sign-in', () => {
  it('without the flag, sign-in works on a database that lacks migration 0163', async () => {
    const db = await migrated([base]);
    const auth = createBundleAuth(db, {
      secret: 'x'.repeat(40),
      baseURL: origin,
    });
    expect(
      (
        await post(auth, '/sign-up/email', {
          email: 'a@b.co',
          password: 'password1',
          name: 'A',
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await post(auth, '/sign-in/email', {
          email: 'a@b.co',
          password: 'password1',
        })
      ).status,
    ).toBe(200);
  });

  it('with the flag, an enrolled account needs an authenticator code or a backup code', async () => {
    const db = await migrated([base, 'drizzle/0163_two_factor.sql']);
    const auth = createBundleAuth(db, {
      secret: 'x'.repeat(40),
      baseURL: origin,
      twoFactor: true,
    });
    const up = await post(auth, '/sign-up/email', {
      email: 'a@b.co',
      password: 'password1',
      name: 'A',
    });
    const session = cookies(up);
    const enabled = await post(
      auth,
      '/two-factor/enable',
      { password: 'password1' },
      session,
    );
    expect(enabled.status).toBe(200);
    const { totpURI, backupCodes } = (await enabled.json()) as {
      totpURI: string;
      backupCodes: string[];
    };
    const secret = new TextDecoder().decode(
      base32.decode(new URL(totpURI).searchParams.get('secret')!),
    );
    expect(backupCodes.length).toBeGreaterThan(0);
    // Verify enrolment with a current code.
    const verify = await post(
      auth,
      '/two-factor/verify-totp',
      { code: await createOTP(secret).totp() },
      session,
    );
    expect(verify.status).toBe(200);
    const signIn = await post(auth, '/sign-in/email', {
      email: 'a@b.co',
      password: 'password1',
    });
    expect(
      ((await signIn.json()) as { twoFactorRedirect?: boolean })
        .twoFactorRedirect,
    ).toBe(true);
    const pending = cookies(signIn);
    expect(
      (
        await post(
          auth,
          '/two-factor/verify-backup-code',
          { code: 'wrong-code' },
          pending,
        )
      ).status,
    ).not.toBe(200);
    const ok = await post(
      auth,
      '/two-factor/verify-backup-code',
      { code: backupCodes[0] },
      pending,
    );
    expect(ok.status).toBe(200);
    expect(cookies(ok)).toContain('session_token');
  });
});
