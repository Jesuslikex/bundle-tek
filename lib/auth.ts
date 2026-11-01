import { betterAuth } from 'better-auth';
import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import { drizzle } from 'drizzle-orm/libsql';
import { getTursoClient } from '@/db/turso';
import * as schema from '@/db/auth-schema';
import {
  twoFactor as twoFactorTable,
  userWithTwoFactor,
} from '@/db/two-factor-schema';
import { twoFactor } from 'better-auth/plugins';
import { solanaLogin } from './solana-login';
import { ACCOUNT_MIN_PASSWORD_LENGTH } from './account-password-policy';
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
    (process.env.VERCEL_ENV === 'production' &&
    process.env.VERCEL_PROJECT_PRODUCTION_URL
      ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
      : process.env.VERCEL_URL
        ? `https://${process.env.VERCEL_URL}`
        : 'http://localhost:3000');
  if (process.env.NODE_ENV === 'production' && !baseURL.startsWith('https://'))
    throw new Error('Authentication requires a secure origin.');
  return createBundleAuth(getTursoClient(), {
    secret,
    baseURL,
    google: getGoogleCredentials(),
    twoFactor: twoFactorAvailable(),
  });
}

/** 2FA stays off until migration 0163 is applied and this flag is set. */
export function twoFactorAvailable() {
  return process.env.BUNDLE_TWO_FACTOR_ENABLED === 'true';
}
export function createBundleAuth(
  client: import('@libsql/client').Client,
  {
    secret,
    baseURL,
    google,
    twoFactor: withTwoFactor = false,
  }: {
    secret: string;
    baseURL: string;
    google?: { clientId: string; clientSecret: string };
    twoFactor?: boolean;
  },
) {
  return betterAuth({
    plugins: [
      solanaLogin(client, baseURL),
      // Gates email/password sign-in with an authenticator code or backup code.
      ...(withTwoFactor ? [twoFactor({ issuer: 'Bundle Tek' })] : []),
    ],
    secret,
    baseURL,
    advanced: { disableOriginCheck: false, disableCSRFCheck: false },
    database: drizzleAdapter(drizzle(client), {
      provider: 'sqlite',
      schema: withTwoFactor
        ? { ...schema, user: userWithTwoFactor, twoFactor: twoFactorTable }
        : schema,
    }),
    socialProviders: google
      ? {
          google: {
            ...google,
            prompt: 'select_account',
            accessType: 'online',
            includeGrantedScopes: false,
          },
        }
      : {},
    account: {
      accountLinking: { enabled: true, disableImplicitLinking: true },
    },
    emailAndPassword: {
      enabled: true,
      minPasswordLength: ACCOUNT_MIN_PASSWORD_LENGTH,
    },
    rateLimit: { enabled: true, storage: 'database' },
  });
}

/** Credentials stay server-side; an unconfigured provider never starts OAuth. */
export function getGoogleCredentials() {
  const clientId = process.env.GOOGLE_CLIENT_ID,
    clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  return clientId && clientSecret ? { clientId, clientSecret } : undefined;
}
