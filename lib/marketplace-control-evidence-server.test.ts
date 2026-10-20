import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { createClient, type Client } from '@libsql/client';
import { readFileSync } from 'node:fs';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { createTursoDatabase } from '@/db/turso';
import { readMarketplaceControlEvidence } from './marketplace-control-evidence-server';
import { buildMarketplaceOwnedInventory } from './marketplace-owned-inventory';
import { admitMarketplaceControlEvidence } from './marketplace-control-evidence';
const mocks = vi.hoisted(() => ({
  user: { userId: 'operator' },
  db: null as unknown as D1Database,
}));
vi.mock('@/app/chatgpt-auth', () => ({
  getChatGPTUser: async () => mocks.user,
}));
vi.mock('@/db', () => ({ getD1: () => mocks.db }));
import { POST as ownershipPost } from '@/app/api/wallet-workspace/ownership/route';
let client: Client,
  db: D1Database,
  pair: nacl.SignKeyPair,
  address: string,
  updatedAt: string;
const site = 'https://bundle.test';
const signal = () => new AbortController().signal;
beforeEach(async () => {
  client = createClient({ url: 'file::memory:', intMode: 'number' });
  db = createTursoDatabase(client);
  mocks.db = db;
  mocks.user = { userId: 'operator' };
  pair = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(11));
  address = bs58.encode(pair.publicKey);
  updatedAt = new Date(Date.now() - 3600000).toISOString();
  await db
    .prepare(
      'CREATE TABLE workspace_wallets(owner_id TEXT,chain TEXT,address TEXT,revision INTEGER,updated_at TEXT,archived INTEGER)',
    )
    .run();
  for (const statement of readFileSync('drizzle/0013_fresh_sandman.sql', 'utf8')
    .split('--> statement-breakpoint')
    .filter((s) => s.trim()))
    await db.prepare(statement).run();
  await db
    .prepare('INSERT INTO workspace_wallets VALUES(?,?,?,?,?,?)')
    .bind('operator', 'Solana', address, 2, updatedAt, 0)
    .run();
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw Error('No provider calls in saved control evidence tests');
    }),
  );
});
afterEach(() => {
  pair.secretKey.fill(0);
  vi.restoreAllMocks();
  client.close();
  vi.unstubAllGlobals();
});
const selection = () => ({
  address,
  walletRevision: 2,
  priceLamports: '50000000',
});
async function own(body: unknown) {
  return ownershipPost(
    new Request(site + '/api/wallet-workspace/ownership', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: site },
      body: JSON.stringify({ chain: 'Solana', address, ...(body as object) }),
    }),
  );
}
async function verify() {
  const prepared = await own({ action: 'challenge' });
  expect(prepared.status).toBe(200);
  const challenge = (await prepared.json()) as { id: string; message: string };
  const signature = nacl.sign.detached(
    new TextEncoder().encode(challenge.message),
    pair.secretKey,
  );
  const accepted = await own({
    action: 'verify',
    id: challenge.id,
    signature: bs58.encode(signature),
  });
  expect(accepted.status).toBe(200);
  return accepted.json() as Promise<{ verifiedAt: string }>;
}
it('reads a real existing ownership-route verification as a recent server record through one SELECT only', async () => {
  const accepted = await verify(),
    queries: string[] = [],
    prepare = db.prepare.bind(db);
  const inventory = buildMarketplaceOwnedInventory({
    wallets: [{ address, revision: 2, label: 'Test', updatedAt }],
    proofs: [{ address, verifiedAt: accepted.verifiedAt }],
    runs: [],
    receipts: [],
  });
  vi.spyOn(db, 'prepare').mockImplementation((sql: string) => {
    queries.push(sql);
    return prepare(sql);
  });
  const evidence = await readMarketplaceControlEvidence(
    db,
    'operator',
    selection(),
    site,
    signal(),
  );
  expect(queries).toHaveLength(1);
  expect(queries[0].startsWith('SELECT')).toBe(true);
  expect(evidence).toMatchObject({
    state: 'recent-record',
    recordedControlRecent: true,
    record: { verifiedAt: accepted.verifiedAt },
    signatureReplayed: false,
    currentControlVerified: false,
    proofCoversAskingPrice: false,
    proofCoversWalletRevision: false,
    saleQualified: false,
    signingAllowed: false,
  });
  expect(
    await admitMarketplaceControlEvidence(
      { evidence },
      inventory,
      selection(),
      site,
    ),
  ).toEqual(evidence);
  expect(fetch).not.toHaveBeenCalled();
});
it('does not treat an unsigned or invalid ownership challenge as a proof', async () => {
  const prepared = await own({ action: 'challenge' }),
    challenge = (await prepared.json()) as { id: string };
  expect(
    (
      await readMarketplaceControlEvidence(
        db,
        'operator',
        selection(),
        site,
        signal(),
      )
    ).state,
  ).toBe('no-record');
  const invalid = await own({
    action: 'verify',
    id: challenge.id,
    signature: bs58.encode(new Uint8Array(64).fill(1)),
  });
  expect(invalid.status).toBe(400);
  expect(
    (
      await readMarketplaceControlEvidence(
        db,
        'operator',
        selection(),
        site,
        signal(),
      )
    ).state,
  ).toBe('no-record');
});
it('retains historical metadata when the generic ownership flow has purged the old challenge', async () => {
  const accepted = await verify();
  await db.prepare('DELETE FROM wallet_ownership_challenges').run();
  expect(
    await readMarketplaceControlEvidence(
      db,
      'operator',
      selection(),
      site,
      signal(),
    ),
  ).toMatchObject({
    state: 'challenge-unavailable',
    recordedControlRecent: false,
    record: { verifiedAt: accepted.verifiedAt, challenge: null },
  });
});
it('refuses another owner, archived wallet or stale revision and never borrows another tenant challenge', async () => {
  await verify();
  await expect(
    readMarketplaceControlEvidence(db, 'other', selection(), site, signal()),
  ).rejects.toThrow('Seller wallet changed');
  await expect(
    readMarketplaceControlEvidence(
      db,
      'operator',
      { ...selection(), walletRevision: 3 },
      site,
      signal(),
    ),
  ).rejects.toThrow('Seller wallet changed');
  await db
    .prepare('UPDATE wallet_ownership_challenges SET owner_id=?')
    .bind('other')
    .run();
  expect(
    (
      await readMarketplaceControlEvidence(
        db,
        'operator',
        selection(),
        site,
        signal(),
      )
    ).state,
  ).toBe('challenge-unavailable');
  await db.prepare('UPDATE workspace_wallets SET archived=1').run();
  await expect(
    readMarketplaceControlEvidence(db, 'operator', selection(), site, signal()),
  ).rejects.toThrow('Seller wallet changed');
});
it('never turns a generic address proof into consent for a newer wallet revision or changed price', async () => {
  await verify();
  await db.prepare('UPDATE workspace_wallets SET revision=3').run();
  const evidence = await readMarketplaceControlEvidence(
    db,
    'operator',
    { ...selection(), walletRevision: 3, priceLamports: '90000000' },
    site,
    signal(),
  );
  expect(evidence).toMatchObject({
    recordedControlRecent: true,
    proofCoversWalletRevision: false,
    proofCoversAskingPrice: false,
    publicationAllowed: false,
    paymentAllowed: false,
  });
});
it('refuses corrupted consumed-challenge parents and cancellation without provider activity', async () => {
  await verify();
  await db
    .prepare('UPDATE wallet_ownership_challenges SET claim_id=NULL')
    .run();
  await expect(
    readMarketplaceControlEvidence(db, 'operator', selection(), site, signal()),
  ).rejects.toThrow();
  const stopped = new AbortController();
  stopped.abort();
  const prepare = vi.spyOn(db, 'prepare');
  await expect(
    readMarketplaceControlEvidence(
      db,
      'operator',
      selection(),
      site,
      stopped.signal,
    ),
  ).rejects.toThrow();
  expect(prepare).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});
