import { describe, it, expect } from 'vitest';
import { createClient } from '@libsql/client';
import { readFileSync } from 'node:fs';
import { createBundleAuth } from './auth';
describe('Bundle sessions with real libSQL', () => {
  it('authenticates cookies, rejects forged identity', async () => {
    const db = createClient({ url: 'file::memory:' });
    try {
      const sql = readFileSync(
        'drizzle/0080_remarkable_winter_soldier.sql',
        'utf8',
      );
      for (const chunk of sql.split('--> statement-breakpoint'))
        if (chunk.trim()) await db.execute(chunk);
      const auth = createBundleAuth(db, {
        secret: 'test-only-secret-for-disposable-session-database',
        baseURL: 'http://localhost:3000',
      });
      const forged = await auth.api.getSession({
        headers: new Headers({
          'oai-authenticated-user-id': 'victim',
          'oai-authenticated-user-email': 'victim@example.com',
        }),
      });
      expect(forged).toBeNull();
      const response = await auth.handler(
        new Request('http://localhost:3000/api/auth/sign-up/email', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Origin: 'http://localhost:3000',
          },
          body: JSON.stringify({
            email: 'test@example.com',
            password: 'disposable-password-123',
            name: 'Test',
          }),
        }),
      );
      expect(response.status).toBe(200);
      const cookie = response.headers.get('set-cookie');
      expect(cookie).toBeTruthy();
      const session = await auth.api.getSession({
        headers: new Headers({ cookie: cookie! }),
      });
      expect(session?.user.email).toBe('test@example.com');
      const stored = await db.execute('SELECT password FROM account');
      expect(stored.rows[0].password).not.toBe('disposable-password-123');

      expect(
        await auth.api.getSession({
          headers: new Headers({ cookie: 'better-auth.session_token=forged' }),
        }),
      ).toBeNull();
    } finally {
      db.close();
    }
  });
});

describe('Google OAuth with disposable libSQL', () => {
  async function fixture(google = true) {
    const db = createClient({ url: 'file::memory:' });
    for (const sql of readFileSync(
      'drizzle/0080_remarkable_winter_soldier.sql',
      'utf8',
    ).split('--> statement-breakpoint'))
      if (sql.trim()) await db.execute(sql);
    const auth = createBundleAuth(db, {
      secret: 'test-only-google-oauth-disposable-secret',
      baseURL: 'https://bundle.example',
      ...(google
        ? {
            google: {
              clientId: 'bundle-test.apps.googleusercontent.com',
              clientSecret: 'test-only-client-secret',
            },
          }
        : {}),
    });
    return { db, auth };
  }
  it('starts a state-protected Google flow with the exact callback and identity-only scopes', async () => {
    const { db, auth } = await fixture();
    try {
      const response = await auth.handler(
        new Request('https://bundle.example/api/auth/sign-in/social', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            origin: 'https://bundle.example',
          },
          body: JSON.stringify({
            provider: 'google',
            callbackURL: '/',
            disableRedirect: true,
          }),
        }),
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as { url: string };
      const url = new URL(body.url);
      expect(url.origin).toBe('https://accounts.google.com');
      expect(url.searchParams.get('client_id')).toBe(
        'bundle-test.apps.googleusercontent.com',
      );
      expect(url.searchParams.get('redirect_uri')).toBe(
        'https://bundle.example/api/auth/callback/google',
      );
      expect(url.searchParams.get('scope')?.split(' ').sort()).toEqual([
        'email',
        'openid',
        'profile',
      ]);
      expect(url.searchParams.get('state')).toBeTruthy();
      expect(url.searchParams.get('code_challenge')).toBeTruthy();
      expect(url.searchParams.get('access_type')).toBe('online');
      expect(url.searchParams.get('include_granted_scopes')).not.toBe('true');
      expect(response.headers.get('set-cookie')).toBeTruthy();
      expect(
        (await auth.$context).options.account?.accountLinking
          ?.disableImplicitLinking,
      ).toBe(true);
    } finally {
      db.close();
    }
  });
  it('rejects a callback to another origin', async () => {
    const { db, auth } = await fixture();
    try {
      const response = await auth.handler(
        new Request('https://bundle.example/api/auth/sign-in/social', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            origin: 'https://bundle.example',
          },
          body: JSON.stringify({
            provider: 'google',
            callbackURL: 'https://attacker.example',
            disableRedirect: true,
          }),
        }),
      );
      expect(response.status).toBe(403);
      expect(
        (await db.execute('SELECT count(*) AS count FROM user')).rows[0].count,
      ).toBe(0);
    } finally {
      db.close();
    }
  });
  it('leaves Google unavailable when no credentials are configured', async () => {
    const { db, auth } = await fixture(false);
    try {
      const response = await auth.handler(
        new Request('https://bundle.example/api/auth/sign-in/social', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            origin: 'https://bundle.example',
          },
          body: JSON.stringify({
            provider: 'google',
            callbackURL: '/',
            disableRedirect: true,
          }),
        }),
      );
      expect(response.status).toBe(404);
    } finally {
      db.close();
    }
  });
  it('requires a real session for explicit Google linking and binds OAuth state to its owner', async () => {
    const { db, auth } = await fixture();
    try {
      const request = (cookie?: string) =>
        new Request('https://bundle.example/api/auth/link-social', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            origin: 'https://bundle.example',
            ...(cookie ? { cookie } : {}),
          },
          body: JSON.stringify({
            provider: 'google',
            callbackURL: '/',
            disableRedirect: true,
            additionalData: {
              link: { userId: 'victim', email: 'victim@example.com' },
            },
          }),
        });
      expect((await auth.handler(request())).status).toBe(401);
      const signup = await auth.handler(
        new Request('https://bundle.example/api/auth/sign-up/email', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            origin: 'https://bundle.example',
          },
          body: JSON.stringify({
            name: 'Owner',
            email: 'owner@example.com',
            password: 'disposable-owner-password',
          }),
        }),
      );
      expect(signup.status).toBe(200);
      const cookie = signup.headers
        .getSetCookie()
        .map((value) => value.split(';')[0])
        .join('; ');
      const owner = await auth.api.getSession({
        headers: new Headers({ cookie }),
      });
      expect(owner).toBeTruthy();
      const linked = await auth.handler(request(cookie));
      expect(linked.status).toBe(200);
      const response = (await linked.json()) as { url: string };
      const state = new URL(response.url).searchParams.get('state');
      const record = await db.execute({
        sql: 'SELECT value FROM verification WHERE identifier=?',
        args: ['auth-state:' + state],
      });
      const stored = JSON.parse(record.rows[0].value as string);
      expect(stored.link).toEqual({
        userId: owner!.user.id,
        email: 'owner@example.com',
      });
      expect(
        (
          await db.execute(
            "SELECT count(*) AS count FROM account WHERE provider_id='google'",
          )
        ).rows[0].count,
      ).toBe(0);
    } finally {
      db.close();
    }
  });
});
