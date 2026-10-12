import {
  beforeAll,
  afterAll,
  beforeEach,
  describe,
  it,
  expect,
  vi,
} from 'vitest';
import { readFileSync } from 'node:fs';
import { Miniflare } from 'miniflare';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { createVault, importVaultWallets } from '@/lib/browser-wallet-vault';
import { signVaultOwnership } from '@/lib/vault-ownership';
import { validateOwnershipChallenge } from '@/lib/wallet-ownership-message';
const mocks = vi.hoisted(() => ({
  user: null as { userId: string } | null,
  db: null as unknown as D1Database,
}));
vi.mock('@/app/chatgpt-auth', () => ({
  getChatGPTUser: async () => mocks.user,
}));
vi.mock('@/db', () => ({ getD1: () => mocks.db }));
import { POST } from './route';
import { GET } from '../route';
const signer = privateKeyToAccount(generatePrivateKey());
const other = privateKeyToAccount(generatePrivateKey());
let mf: Miniflare;
function write(body: Record<string, unknown>, headers = {}) {
  return POST(
    new Request('https://pulseforge.test/api/wallet-workspace/ownership', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'https://pulseforge.test',
        ...headers,
      },
      body: JSON.stringify({ chain: 'Base', address: signer.address, ...body }),
    }),
  );
}
async function challenge() {
  const response = await write({ action: 'challenge' });
  expect(response.status).toBe(200);
  return (await response.json()) as {
    id: string;
    message: string;
    expiresAt: string;
    chainId: number;
  };
}
async function signedChallenge() {
  const value = await challenge();
  const signature = await signer.signMessage({ message: value.message });
  return { action: 'verify', id: value.id, signature };
}
beforeAll(async () => {
  mf = new Miniflare({
    telemetry: { enabled: false },
    workers: [
      {
        config: {
          name: 'ownership-test',
          type: 'worker',
          compatibilityDate: '2026-09-01',
          manifest: {
            mainModule: 'index.js',
            modules: {
              'index.js': {
                type: 'esm',
                contents:
                  'export default {fetch(){return new Response("test")}}',
              },
            },
          },
          env: { DB: { type: 'd1', id: 'ownership-test-db' } },
        },
      },
    ],
  });
  mocks.db = (await mf.getD1Database(
    'DB',
    'ownership-test',
  )) as unknown as D1Database;
  for (const migration of [
    '0011_huge_donald_blake.sql',
    '0019_wallet_folder_memberships.sql',
    '0020_wallet_folder_colors.sql',
    '0030_workspace_wallet_tags.sql',
    '0012_messy_zzzax.sql',
    '0013_fresh_sandman.sql',
  ]) {
    for (const sql of readFileSync(
      new URL(`../../../../drizzle/${migration}`, import.meta.url),
      'utf8',
    )
      .split('--> statement-breakpoint')
      .filter((s) => s.trim()))
      await mocks.db.prepare(sql).run();
  }
}, 30000);
beforeEach(async () => {
  vi.useRealTimers();
  mocks.user = { userId: 'alice' };
  await mocks.db.batch(
    [
      'DROP TRIGGER IF EXISTS reject_proof',
      'DELETE FROM wallet_ownership_challenges',
      'DELETE FROM wallet_ownership_proofs',
      'DELETE FROM workspace_wallets',
      'DELETE FROM wallet_folders',
    ].map((sql) => mocks.db.prepare(sql)),
  );
  await mocks.db
    .prepare(
      "INSERT INTO wallet_folders (owner_id,id,name,chain,archived,revision,updated_at) VALUES ('alice','a','Accounts','Base',0,1,'2026-10-09')",
    )
    .run();
  await mocks.db
    .prepare(
      "INSERT INTO workspace_wallets (owner_id,chain,address,folder_id,label,role,archived,revision,updated_at) VALUES ('alice','Base',?,'a','Account','Recipient',0,1,'2026-10-09')",
    )
    .bind(signer.address)
    .run();
});
afterAll(async () => {
  vi.useRealTimers();
  await mf.dispose();
});
describe('owner-bound EVM message verification', () => {
  it('verifies a real ECDSA signature, persists a historical proof, and rejects replay', async () => {
    const value = await challenge();
    expect(value.chainId).toBe(8453);
    expect(value.message).toContain('Origin: https://pulseforge.test');
    expect(value.message).toContain(`Address: ${signer.address}`);
    expect(value.message).toContain('does not authorize a transaction');
    const body = {
      action: 'verify',
      id: value.id,
      signature: await signer.signMessage({ message: value.message }),
    };
    expect((await write(body)).status).toBe(200);
    const data = (await (await GET()).json()) as { proofs: unknown[] };
    expect(data.proofs).toEqual([
      {
        chain: 'Base',
        address: signer.address,
        verifiedAt: expect.any(String),
      },
    ]);
    expect((await write(body)).status).toBe(409);
    mocks.user = { userId: 'bob' };
    expect(
      ((await (await GET()).json()) as { proofs: unknown[] }).proofs,
    ).toEqual([]);
    expect((await write(body)).status).toBe(409);
  });
  it('rejects signatures from another key, altered messages, and another network', async () => {
    const value = await challenge();
    expect(
      (
        await write({
          action: 'verify',
          id: value.id,
          signature: await other.signMessage({ message: value.message }),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await write({
          action: 'verify',
          id: value.id,
          signature: await signer.signMessage({
            message: `${value.message}\nAltered`,
          }),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await write({
          action: 'verify',
          id: value.id,
          signature: await signer.signMessage({ message: value.message }),
          chain: 'Solana',
        })
      ).status,
    ).toBe(400);
    expect(
      await mocks.db
        .prepare('SELECT COUNT(*) AS count FROM wallet_ownership_proofs')
        .first('count'),
    ).toBe(0);
  });
  it('expires messages and stops verification after a wallet is archived', async () => {
    const body = await signedChallenge();
    await mocks.db
      .prepare('UPDATE wallet_ownership_challenges SET expires_at=?')
      .bind('2000-01-01')
      .run();
    expect((await write(body)).status).toBe(410);
    const next = await signedChallenge();
    await mocks.db.prepare('UPDATE workspace_wallets SET archived=1').run();
    expect((await write(next)).status).toBe(409);
    expect(
      await mocks.db
        .prepare('SELECT COUNT(*) AS count FROM wallet_ownership_proofs')
        .first('count'),
    ).toBe(0);
  });
  it('admits one concurrent verification even with a frozen clock', async () => {
    const body = await signedChallenge();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date());
    const result = await Promise.all([write(body), write(body)]);
    expect(result.map((r) => r.status).sort((a, b) => a - b)).toEqual([
      200, 409,
    ]);
    expect(
      await mocks.db
        .prepare('SELECT COUNT(*) AS count FROM wallet_ownership_proofs')
        .first('count'),
    ).toBe(1);
  });
  it('rolls back challenge consumption if proof storage fails, allowing a retry', async () => {
    const body = await signedChallenge();
    await mocks.db
      .prepare(
        "CREATE TRIGGER reject_proof BEFORE INSERT ON wallet_ownership_proofs BEGIN SELECT RAISE(ABORT,'storage unavailable'); END",
      )
      .run();
    expect((await write(body)).status).toBe(503);
    expect(
      await mocks.db
        .prepare('SELECT used_at FROM wallet_ownership_challenges WHERE id=?')
        .bind(body.id)
        .first('used_at'),
    ).toBeNull();
    await mocks.db.prepare('DROP TRIGGER reject_proof').run();
    expect((await write(body)).status).toBe(200);
  });
  it('bounds outstanding requests and clears expired ones', async () => {
    for (let i = 0; i < 5; i++) await challenge();
    expect((await write({ action: 'challenge' })).status).toBe(429);
    await mocks.db
      .prepare("UPDATE wallet_ownership_challenges SET expires_at='2000-01-01'")
      .run();
    await challenge();
    expect(
      await mocks.db
        .prepare('SELECT COUNT(*) AS count FROM wallet_ownership_challenges')
        .first('count'),
    ).toBe(1);
  });
  it('requires authentication, same origin, supported network and a saved active account', async () => {
    expect(
      (await write({ action: 'challenge' }, { origin: 'https://other.test' }))
        .status,
    ).toBe(403);
    expect(
      (await write({ action: 'challenge', address: other.address })).status,
    ).toBe(409);
    expect((await write({ action: 'challenge', chain: 'Solana' })).status).toBe(
      400,
    );
    mocks.user = null;
    expect((await write({ action: 'challenge' })).status).toBe(401);
  });
  it('enforces the owner cap inside concurrent challenge writes', async () => {
    const rows = Array.from({ length: 49 }, (_, i) => ({
      id: crypto.randomUUID(),
      address: `reserved-${i}`,
    }));
    await mocks.db
      .prepare(
        "INSERT INTO wallet_ownership_challenges (id,owner_id,chain,address,message,expires_at) SELECT json_extract(value,'$.id'),'alice','Base',json_extract(value,'$.address'),'reserved','2099-01-01' FROM json_each(?)",
      )
      .bind(JSON.stringify(rows))
      .run();
    const result = await Promise.all([
      write({ action: 'challenge' }),
      write({ action: 'challenge' }),
    ]);
    expect(result.map((r) => r.status).sort((a, b) => a - b)).toEqual([
      200, 429,
    ]);
    expect(
      await mocks.db
        .prepare('SELECT COUNT(*) AS count FROM wallet_ownership_challenges')
        .first('count'),
    ).toBe(50);
  });
  it('rechecks wallet eligibility atomically when consuming a valid signature', async () => {
    const body = await signedChallenge();
    const real = mocks.db;
    // Miniflare's RPC proxy returns bound methods; wrap it to intercept the write boundary.
    mocks.db = {
      prepare: real.prepare.bind(real),
      batch: async (statements: D1PreparedStatement[]) => {
        await real.prepare('UPDATE workspace_wallets SET archived=1').run();
        return real.batch(statements);
      },
    } as D1Database;
    try {
      expect((await write(body)).status).toBe(409);
      expect(
        await mocks.db
          .prepare('SELECT used_at FROM wallet_ownership_challenges WHERE id=?')
          .bind(body.id)
          .first('used_at'),
      ).toBeNull();
      expect(
        await mocks.db
          .prepare('SELECT COUNT(*) AS count FROM wallet_ownership_proofs')
          .first('count'),
      ).toBe(0);
    } finally {
      mocks.db = real;
    }
  });
});

it('verifies an active parent wallet even when its organizational folder is archived', async () => {
  const body = await signedChallenge();
  await mocks.db.prepare('UPDATE wallet_folders SET archived=1').run();
  expect((await write(body)).status).toBe(200);
});

describe('owner-bound Solana vault ownership proofs', () => {
  async function solanaChallenge() {
    const pair = nacl.sign.keyPair();
    const address = bs58.encode(pair.publicKey);
    const session = importVaultWallets(
      await createVault('disposable integration vault passphrase'),
      'solana',
      bs58.encode(pair.secretKey),
    ).session;
    pair.secretKey.fill(0);
    await mocks.db
      .prepare(
        "INSERT INTO workspace_wallets (owner_id,chain,address,folder_id,folder_ids,label,role,archived,revision,updated_at) VALUES ('alice','Solana',?,'','[]','Imported','Recipient',0,1,'2026-10-10')",
      )
      .bind(address)
      .run();
    const response = await write({
      action: 'challenge',
      chain: 'Solana',
      address,
    });
    expect(response.status).toBe(200);
    const value = validateOwnershipChallenge(
      await response.json(),
      'https://pulseforge.test',
      'Solana',
      address,
    );
    expect(value.chainId).toBeNull();
    const signature = await signVaultOwnership(
      session,
      session.payload.wallets[0].id,
      'Solana',
      value,
      'https://pulseforge.test',
    );
    return {
      value,
      body: {
        action: 'verify',
        chain: 'Solana',
        address,
        id: value.id,
        signature,
      },
      session,
    };
  }
  it('verifies a vault-produced Ed25519 signature, persists only a historical proof, and rejects replay', async () => {
    const { body } = await solanaChallenge();
    expect((await write(body)).status).toBe(200);
    const data = (await (await GET()).json()) as {
      proofs: { chain: string; address: string }[];
    };
    expect(data.proofs).toEqual([
      {
        chain: 'Solana',
        address: body.address,
        verifiedAt: expect.any(String),
      },
    ]);
    expect((await write(body)).status).toBe(409);
  });
  it('rejects another key, altered text and malformed signatures without consuming the challenge', async () => {
    const { body, value, session } = await solanaChallenge();
    const other = nacl.sign.keyPair();
    const wrong = bs58.encode(
      nacl.sign.detached(
        new TextEncoder().encode(value.message),
        other.secretKey,
      ),
    );
    expect((await write({ ...body, signature: wrong })).status).toBe(400);
    const seed = Uint8Array.from(
      session.payload.wallets[0].seed.match(/../g)!,
      (part) => parseInt(part, 16),
    );
    const original = nacl.sign.keyPair.fromSeed(seed);
    const altered = bs58.encode(
      nacl.sign.detached(
        new TextEncoder().encode(value.message + '\nChanged'),
        original.secretKey,
      ),
    );
    seed.fill(0);
    original.secretKey.fill(0);
    expect((await write({ ...body, signature: altered })).status).toBe(400);
    const crossSite = await POST(
      new Request('https://other.test/api/wallet-workspace/ownership', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: 'https://other.test',
        },
        body: JSON.stringify(body),
      }),
    );
    expect(crossSite.status).toBe(400);
    expect(
      (await write({ ...body, signature: bs58.encode(new Uint8Array(32)) }))
        .status,
    ).toBe(400);
    expect(
      await mocks.db
        .prepare('SELECT used_at FROM wallet_ownership_challenges WHERE id=?')
        .bind(body.id)
        .first('used_at'),
    ).toBeNull();
    expect((await write(body)).status).toBe(200);
  });
  it('binds Solana proofs to the authenticated owner, active public record and expiry', async () => {
    const first = await solanaChallenge();
    mocks.user = { userId: 'bob' };
    await mocks.db
      .prepare(
        "INSERT INTO workspace_wallets (owner_id,chain,address,folder_id,folder_ids,label,role,archived,revision,updated_at) VALUES ('bob','Solana',?,'','[]','Other owner','Recipient',0,1,'2026-10-10')",
      )
      .bind(first.body.address)
      .run();
    expect((await write(first.body)).status).toBe(404);
    mocks.user = { userId: 'alice' };
    await mocks.db
      .prepare("UPDATE workspace_wallets SET archived=1 WHERE chain='Solana'")
      .run();
    expect((await write(first.body)).status).toBe(409);
    await mocks.db
      .prepare("UPDATE workspace_wallets SET archived=0 WHERE chain='Solana'")
      .run();
    await mocks.db
      .prepare('UPDATE wallet_ownership_challenges SET expires_at=? WHERE id=?')
      .bind('2000-01-01', first.body.id)
      .run();
    expect((await write(first.body)).status).toBe(410);
    expect(
      await mocks.db
        .prepare('SELECT COUNT(*) AS count FROM wallet_ownership_proofs')
        .first('count'),
    ).toBe(0);
  });
  it('atomically admits one concurrent Solana proof and rolls back a failed insertion', async () => {
    const first = await solanaChallenge();
    const results = await Promise.all([write(first.body), write(first.body)]);
    expect(
      results.map((response) => response.status).sort((a, b) => a - b),
    ).toEqual([200, 409]);
    const second = await solanaChallenge();
    await mocks.db
      .prepare(
        "CREATE TRIGGER reject_proof BEFORE INSERT ON wallet_ownership_proofs BEGIN SELECT RAISE(ABORT,'test rejection'); END",
      )
      .run();
    expect((await write(second.body)).status).toBe(503);
    expect(
      await mocks.db
        .prepare('SELECT used_at FROM wallet_ownership_challenges WHERE id=?')
        .bind(second.body.id)
        .first('used_at'),
    ).toBeNull();
    expect(
      await mocks.db
        .prepare('SELECT COUNT(*) AS count FROM wallet_ownership_proofs')
        .first('count'),
    ).toBe(1);
  });
});
