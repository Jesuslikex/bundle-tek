import { betterAuth } from 'better-auth';
import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import { drizzle } from 'drizzle-orm/libsql';
import { getTursoClient } from '@/db/turso';
import * as schema from '@/db/auth-schema';
let instance: ReturnType<typeof createAuth> | undefined;
export function getAuth() {
  return (instance ??= createAuth());
}
function createAuth() {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret || secret.length < 32)
    throw new Error('Authentication configuration is unavailable.');
  const baseURL =
    process.env.BETTER_AUTH_URL ||
    (process.env.VERCEL_ENV === 'production' && process.env.VERCEL_PROJECT_PRODUCTION_URL
      ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
      : process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000');
  if (process.env.NODE_ENV === 'production' && !baseURL.startsWith('https://'))
    throw new Error('Authentication requires a secure origin.');
  return createBundleAuth(getTursoClient(), { secret, baseURL });
}
export function createBundleAuth(
  client: import('@libsql/client').Client,
  { secret, baseURL }: { secret: string; baseURL: string },
) {
  return betterAuth({
    secret,
    baseURL,
    database: drizzleAdapter(drizzle(client), {
      provider: 'sqlite',
      schema,
    }),
    emailAndPassword: { enabled: true, minPasswordLength: 12 },
    rateLimit: { enabled: true, storage: 'database' },
  });
}
