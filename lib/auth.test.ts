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
      const body = await response.json() as {url:string};
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
        (await auth.$context).options.account?.accountLinking?.enabled,
      ).toBe(false);
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
});
