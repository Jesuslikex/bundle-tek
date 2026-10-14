import { afterEach, describe, expect, it } from 'vitest';
import { createClient, type Client } from '@libsql/client';
import { readFileSync } from 'node:fs';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { createBundleAuth } from './auth';
const databases: Client[] = [];
it('refuses degenerate wallet identities before creating a nonce or user session', async () => {
  const f = await fixture(),
    identity = new Uint8Array(32);
  identity[0] = 1;
  expect(
    (await f.request('challenge', { address: bs58.encode(identity) })).status,
  ).toBe(400);
  expect(
    (await f.db.execute('SELECT count(*) AS total FROM verification')).rows[0]
      .total,
  ).toBe(0);
  expect(
    (await f.db.execute('SELECT count(*) AS total FROM user')).rows[0].total,
  ).toBe(0);
});
it('converges simultaneous first logins from separate server instances on one identity', async () => {
  const f = await fixture(),
    a = await f.challenge(),
    b = await f.challenge();
  const second = createBundleAuth(f.db, {
    secret: 'solana-test-only-secret-not-a-real-credential',
    baseURL: 'https://bundle.example',
  });
  const responses = await Promise.all([
    f.request('verify', f.proof(a), a.cookie),
    second.handler(
      new Request('https://bundle.example/api/auth/solana/verify', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: 'https://bundle.example',
          cookie: b.cookie,
        },
        body: JSON.stringify(f.proof(b)),
      }),
    ),
  ]);
  expect(responses.map((r) => r.status)).toEqual([200, 200]);
  expect(
    (await f.db.execute('SELECT count(*) AS total FROM user')).rows[0].total,
  ).toBe(1);
  expect(
    (await f.db.execute('SELECT count(*) AS total FROM account')).rows[0].total,
  ).toBe(1);
});
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
async function fixture() {
  const db = createClient({ url: 'file::memory:' });
  databases.push(db);
  for (const sql of readFileSync(
    'drizzle/0080_remarkable_winter_soldier.sql',
    'utf8',
  ).split('--> statement-breakpoint'))
    if (sql.trim()) await db.execute(sql);
  const auth = createBundleAuth(db, {
    secret: 'solana-test-only-secret-not-a-real-credential',
    baseURL: 'https://bundle.example',
  });
  const key = nacl.sign.keyPair(),
    address = bs58.encode(key.publicKey);
  async function request(
    path: string,
    body: object,
    cookie = '',
    origin = 'https://bundle.example',
  ) {
    return auth.handler(
      new Request(`https://bundle.example/api/auth/solana/${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin, cookie },
        body: JSON.stringify(body),
      }),
    );
  }
  async function challenge() {
    const response = await request('challenge', { address });
    expect(response.status).toBe(200);
    return {
      ...((await response.json()) as { nonce: string; message: string }),
      cookie: response.headers.get('set-cookie')!.split(';')[0],
    };
  }
  function proof(value: { nonce: string; message: string }, signer = key) {
    return {
      nonce: value.nonce,
      address,
      signature: bs58.encode(
        nacl.sign.detached(
          new TextEncoder().encode(value.message),
          signer.secretKey,
        ),
      ),
    };
  }
  return { db, auth, key, address, request, challenge, proof };
}
describe('Solana message login with real libSQL and Ed25519', () => {
  it('creates a cookie session and returns to the same user on another challenge', async () => {
    const f = await fixture(),
      c = await f.challenge();
    expect(c.message).toContain('URI: https://bundle.example');
    const verified = await f.request('verify', f.proof(c), c.cookie);
    expect(verified.status).toBe(200);
    const session = await f.auth.api.getSession({
      headers: new Headers({ cookie: verified.headers.get('set-cookie')! }),
    });
    expect(session?.user.id).toMatch(/^solana_/);
    expect(session?.user.emailVerified).toBe(false);
    const second = await f.challenge(),
      r = await f.request('verify', f.proof(second), second.cookie);
    expect(r.status).toBe(200);
    const s = await f.auth.api.getSession({
      headers: new Headers({ cookie: r.headers.get('set-cookie')! }),
    });
    expect(s?.user.id).toBe(session?.user.id);
    expect(
      (await f.db.execute('SELECT count(*) AS total FROM user')).rows[0].total,
    ).toBe(1);
    expect(
      (await f.db.execute('SELECT provider_id,account_id FROM account'))
        .rows[0],
    ).toMatchObject({ provider_id: 'solana', account_id: f.address });
    const signedOut = await f.auth.handler(
      new Request('https://bundle.example/api/auth/sign-out', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: 'https://bundle.example',
          cookie: r.headers.get('set-cookie')!,
        },
        body: '{}',
      }),
    );
    expect(signedOut.status).toBe(200);
    expect(
      await f.auth.api.getSession({
        headers: new Headers({ cookie: r.headers.get('set-cookie')! }),
      }),
    ).toBeNull();
  });
  it('requires the browser cookie and exact origin, without burning another browser challenge', async () => {
    const f = await fixture(),
      c = await f.challenge();
    expect((await f.request('verify', f.proof(c))).status).toBe(401);
    expect(
      (await f.request('verify', f.proof(c), c.cookie, 'https://evil.example'))
        .status,
    ).toBe(403);
    expect((await f.request('verify', f.proof(c), c.cookie)).status).toBe(200);
    expect(
      (await f.request('challenge', { address: f.address }, '', '')).status,
    ).toBe(403);
  });
  it('rejects wrong keys and tampered messages, and burns their nonces', async () => {
    const f = await fixture(),
      c = await f.challenge();
    expect(
      (await f.request('verify', f.proof(c, nacl.sign.keyPair()), c.cookie))
        .status,
    ).toBe(401);
    expect((await f.request('verify', f.proof(c), c.cookie)).status).toBe(401);
    const another = await f.challenge();
    expect(
      (
        await f.request(
          'verify',
          f.proof({
            ...another,
            message: another.message.replace('bundle.example', 'evil.example'),
          }),
          another.cookie,
        )
      ).status,
    ).toBe(401);
    expect(
      (await f.db.execute('SELECT count(*) AS total FROM session')).rows[0]
        .total,
    ).toBe(0);
  });
  it('expires challenges and consumes a concurrent replay exactly once', async () => {
    const f = await fixture(),
      c = await f.challenge();
    await f.db.execute({
      sql: 'UPDATE verification SET expires_at=0 WHERE identifier=?',
      args: [`solana-login:${c.nonce}`],
    });
    expect((await f.request('verify', f.proof(c), c.cookie)).status).toBe(401);
    const next = await f.challenge();
    const responses = await Promise.all([
      f.request('verify', f.proof(next), next.cookie),
      f.request('verify', f.proof(next), next.cookie),
    ]);
    expect(responses.map((r) => r.status).sort((a, b) => a - b)).toEqual([
      200, 401,
    ]);
    expect(
      (await f.db.execute('SELECT count(*) AS total FROM session')).rows[0]
        .total,
    ).toBe(1);
  });
  it('rejects malformed addresses and unrequested email or ownership overrides', async () => {
    const f = await fixture();
    expect(
      (await f.request('challenge', { address: 'x'.repeat(32) })).status,
    ).toBe(400);
    const c = await f.challenge();
    expect(
      (
        await f.request(
          'verify',
          { ...f.proof(c), email: 'victim@example.com', userId: 'victim' },
          c.cookie,
        )
      ).status,
    ).toBe(400);
  });
});
