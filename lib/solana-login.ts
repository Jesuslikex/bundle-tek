import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Client } from '@libsql/client';
import { createAuthEndpoint, APIError } from 'better-auth/api';
import { setSessionCookie } from 'better-auth/cookies';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { z } from 'zod';

const walletAddress = z
  .string()
  .min(32)
  .max(44)
  .refine((value) => {
    try {
      return (
        bs58.decode(value).length === 32 &&
        bs58.encode(bs58.decode(value)) === value
      );
    } catch {
      return false;
    }
  });
const lifetime = 5 * 60_000;

/** Message authentication only. No RPC calls, private keys, or transactions. */
export function solanaLogin(client: Client, baseURL: string) {
  const origin = new URL(baseURL).origin;
  function requireOrigin(headers: Headers | undefined) {
    if (headers?.get('origin') !== origin)
      throw new APIError('FORBIDDEN', { message: 'Untrusted sign-in origin.' });
  }
  return {
    id: 'bundle-solana-login',
    rateLimit: [
      {
        pathMatcher: (path: string) => path.startsWith('/solana/'),
        window: 60,
        max: 10,
      },
    ],
    endpoints: {
      solanaChallenge: createAuthEndpoint(
        '/solana/challenge',
        {
          method: 'POST',
          requireRequest: true,
          body: z.object({ address: walletAddress }).strict(),
        },
        async (ctx) => {
          requireOrigin(ctx.headers);
          const nonce = Array.from(randomBytes(32), (byte) =>
            byte.toString(16).padStart(2, '0'),
          ).join('');
          const now = Date.now();
          const message = `${new URL(origin).host} wants you to sign in with your Solana account:\n${ctx.body.address}\n\nSign in to Bundle Tek. This does not authorize transactions.\n\nURI: ${origin}\nVersion: 1\nChain ID: solana:mainnet\nNonce: ${nonce}\nIssued At: ${new Date(now).toISOString()}\nExpiration Time: ${new Date(now + lifetime).toISOString()}`;
          await client.batch(
            [
              {
                sql: "DELETE FROM verification WHERE identifier LIKE 'solana-login:%' AND expires_at<=?",
                args: [now],
              },
              {
                sql: 'INSERT INTO verification (id,identifier,value,expires_at,created_at,updated_at) VALUES (?,?,?,?,?,?)',
                args: [
                  randomUUID(),
                  `solana-login:${nonce}`,
                  JSON.stringify({ address: ctx.body.address, message }),
                  now + lifetime,
                  now,
                  now,
                ],
              },
            ],
            'write',
          );
          const cookie = ctx.context.createAuthCookie('solana_login', {
            maxAge: lifetime / 1000,
          });
          await ctx.setSignedCookie(
            cookie.name,
            nonce,
            ctx.context.secret,
            cookie.attributes,
          );
          ctx.setHeader('Cache-Control', 'no-store');
          return ctx.json({ nonce, message });
        },
      ),
      solanaVerify: createAuthEndpoint(
        '/solana/verify',
        {
          method: 'POST',
          requireRequest: true,
          body: z
            .object({
              nonce: z.string().regex(/^[a-f0-9]{64}$/),
              address: walletAddress,
              signature: z.string().min(64).max(90),
            })
            .strict(),
        },
        async (ctx) => {
          requireOrigin(ctx.headers);
          const cookie = ctx.context.createAuthCookie('solana_login', {
            maxAge: lifetime / 1000,
          });
          if (
            (await ctx.getSignedCookie(cookie.name, ctx.context.secret)) !==
            ctx.body.nonce
          )
            throw new APIError('UNAUTHORIZED', {
              message:
                'Sign-in challenge belongs to a different browser. Please try again.',
            });
          // Atomic consumption across server instances. A failed signature burns the challenge too.
          const consumed = await client.execute({
            sql: 'DELETE FROM verification WHERE identifier=? RETURNING value,expires_at',
            args: [`solana-login:${ctx.body.nonce}`],
          });
          const row = consumed.rows[0];
          if (
            consumed.rows.length !== 1 ||
            Number(row?.expires_at) <= Date.now()
          )
            throw new APIError('UNAUTHORIZED', {
              message: 'Sign-in challenge expired or was already used.',
            });
          if (typeof row.value !== 'string')
            throw new APIError('UNAUTHORIZED', {
              message: 'Invalid sign-in challenge.',
            });
          const saved = JSON.parse(row.value) as {
            address: string;
            message: string;
          };
          let valid = false;
          try {
            valid =
              saved.address === ctx.body.address &&
              nacl.sign.detached.verify(
                new TextEncoder().encode(saved.message),
                bs58.decode(ctx.body.signature),
                bs58.decode(saved.address),
              );
          } catch {
            /* Invalid encoding or signature fails closed. */
          }
          if (!valid)
            throw new APIError('UNAUTHORIZED', {
              message: 'Wallet signature did not match the sign-in challenge.',
            });
          const id = `solana_${createHash('sha256').update(saved.address).digest('hex')}`;
          const now = Date.now();
          // A deterministic primary key makes concurrent first sign-ins converge. Never match by email.
          await client.batch(
            [
              {
                sql: 'INSERT INTO user (id,name,email,email_verified,created_at,updated_at) VALUES (?,?,?,0,?,?) ON CONFLICT(id) DO NOTHING',
                args: [
                  id,
                  `${saved.address.slice(0, 4)}…${saved.address.slice(-4)}`,
                  `${randomUUID()}@wallet.bundle.invalid`,
                  now,
                  now,
                ],
              },
              {
                sql: 'INSERT INTO account (id,account_id,provider_id,user_id,created_at,updated_at) VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING',
                args: [id, saved.address, 'solana', id, now, now],
              },
            ],
            'write',
          );
          const user = await ctx.context.internalAdapter.findUserById(id);
          if (!user)
            throw new APIError('INTERNAL_SERVER_ERROR', {
              message: 'Unable to create wallet session.',
            });
          const session = await ctx.context.internalAdapter.createSession(
            user.id,
          );
          if (!session)
            throw new APIError('INTERNAL_SERVER_ERROR', {
              message: 'Unable to create wallet session.',
            });
          await setSessionCookie(ctx, { session, user });
          ctx.setCookie(cookie.name, '', { ...cookie.attributes, maxAge: 0 });
          ctx.setHeader('Cache-Control', 'no-store');
          return ctx.json({ success: true });
        },
      ),
    },
  };
}
