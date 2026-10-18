import { afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { createClient, type Client } from '@libsql/client';
import { createTursoDatabase } from '../db/turso';
import { volumeProgramFixture } from './volume-program-fixture';
import {
  createVolumeBundleSession,
  reserveVolumeBundleRound,
} from '../lib/volume-bundle-reservations';
const clients: Client[] = [];
afterEach(() => {
  for (const c of clients.splice(0)) c.close();
});
export async function volumeReservationFixture(atMs?: number) {
  const f = await volumeProgramFixture(atMs),
    client = createClient({ url: 'file::memory:' });
  clients.push(client);
  // Real libSQL+production adapter and our complete migration. Narrow parent doubles isolate reciprocal guards.
  for (const sql of [
    'CREATE TABLE imported_token_projects(owner_id TEXT,id TEXT,revision INTEGER,archived INTEGER,chain TEXT,document TEXT)',
    'CREATE TABLE workspace_wallets(owner_id TEXT,chain TEXT,address TEXT,revision INTEGER,archived INTEGER)',
    'CREATE TABLE wallet_ownership_proofs(owner_id TEXT,chain TEXT,address TEXT)',
    'CREATE TABLE solana_execution_reservations(owner_id TEXT,wallet_address TEXT,scope TEXT,intent_id TEXT,state TEXT)',
    'CREATE TABLE volume_bot_sessions(id TEXT,owner_id TEXT,plan TEXT,state TEXT)',
    'CREATE TABLE volume_bot_batches(id TEXT,session_id TEXT)',
    'CREATE TABLE volume_bot_trades(batch_id TEXT,state TEXT)',
    'CREATE TABLE pump_organic_sequences(id TEXT,owner_id TEXT,plan TEXT,state TEXT)',
    'CREATE TABLE pump_organic_batches(id TEXT,sequence_id TEXT)',
    'CREATE TABLE pump_organic_buys(batch_id TEXT,state TEXT)',
    'CREATE TABLE pump_launch_reviews(id TEXT,owner_id TEXT,payer TEXT,review TEXT,state TEXT)',
    'CREATE TABLE pair_order_executions(owner_id TEXT,wallet TEXT,state TEXT)',
    'CREATE TABLE token_supply_actions(owner_id TEXT,wallet_address TEXT,state TEXT)',
    'CREATE TABLE counter_proposal_reservations(owner_id TEXT,wallet_address TEXT,approval_id TEXT,expires_at TEXT)',
  ])
    await client.execute(sql);
  for (const file of [
    '0105_volume_bundle_reservations',
    '0107_volume_bundle_recovery',
  ])
    for (const sql of readFileSync('drizzle/' + file + '.sql', 'utf8').split(
      '--> statement-breakpoint',
    ))
      if (sql.trim()) await client.execute(sql);
  await client.execute({
    sql: "INSERT INTO imported_token_projects VALUES('owner',?,1,0,'Solana',?)",
    args: [
      f.input.projectId,
      JSON.stringify({ token: { address: f.input.mint } }),
    ],
  });
  await client.execute({
    sql: "INSERT INTO workspace_wallets VALUES('owner','Solana',?,1,0)",
    args: [f.review.wallet],
  });
  await client.execute({
    sql: "INSERT INTO wallet_ownership_proofs VALUES('owner','Solana',?)",
    args: [f.review.wallet],
  });
  const db = createTursoDatabase(client),
    sessionInput = {
      id: f.input.sessionId,
      projectId: f.input.projectId,
      projectRevision: 1,
      mint: f.input.mint,
      plan: f.input.plan,
      wallets: [{ address: f.review.wallet, revision: 1 }],
    };
  const saved = await createVolumeBundleSession(db, 'owner', sessionInput);
  const request = {
    id: crypto.randomUUID(),
    sessionId: saved.id,
    sessionRevision: 1,
    walletRevision: 1,
    construction: f.review,
    route: f.route,
  };
  const deps = {
    rpc: f.rpc,
    policy: f.policy,
    minimumSlot: 1000,
    now: () => f.nowMs,
  };
  return {
    ...f,
    client,
    db,
    saved,
    sessionInput,
    request,
    deps,
    reserve: () =>
      reserveVolumeBundleRound(
        db,
        'owner',
        request,
        deps,
        new AbortController().signal,
      ),
  };
}
