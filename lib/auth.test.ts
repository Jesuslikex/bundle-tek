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
