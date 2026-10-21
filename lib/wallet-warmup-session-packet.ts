import { z } from 'zod';
import { canonicalPumpHolderJson as canonical } from './pump-holder-review';
import { walletWarmupSessionDigest as digest } from './wallet-warmup-session-digest';
import { reviewUnsignedSwapEnvelope } from './unsigned-swap-order';
import type { WarmupPreparationSummary } from './warmup-preparation-history';

export type WarmupSessionPacketMaterial = {
  summary: WarmupPreparationSummary;
  transaction: string;
};
const schema = z
  .object({
    owner_id: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/),
    preparation_id: z.uuid(),
    preparation_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    unsigned_transaction: z.string().min(1).max(1644),
    packet_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    record_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
type Row = z.infer<typeof schema>;
const unavailable = () =>
  new Error(
    'The retained unsigned session packet is unavailable. No signing is enabled.',
  );

/** Envelope identity only. Route, custody, lifetime and signing are NOT authorized. */
export async function validateWalletWarmupSessionPacket(
  transaction: unknown,
  summary: WarmupPreparationSummary,
) {
  const packet = await reviewUnsignedSwapEnvelope(transaction, summary.wallet);
  if (
    packet.sha256 !== summary.transaction.sha256 ||
    packet.transactionBytes !== summary.transaction.bytes ||
    packet.instructionCount !== summary.transaction.instructionCount ||
    packet.lookupTableCount !== summary.transaction.lookupTableCount
  )
    throw unavailable();
  return { transaction: packet.transaction, sha256: packet.sha256 };
}

export async function walletWarmupSessionPacketStatement(
  db: D1Database,
  owner: string,
  id: string,
  preparationSha256: string,
  transaction: string,
  summary: WarmupPreparationSummary,
) {
  const installed = await db
    .prepare(
      "SELECT count(*) AS n FROM sqlite_master WHERE type='trigger' AND name IN ('wallet_warmup_session_packets_insert','wallet_warmup_session_packets_no_update','wallet_warmup_session_packets_no_delete')",
    )
    .first<{ n: number }>();
  if (installed?.n !== 3) throw unavailable();
  const packet = await validateWalletWarmupSessionPacket(transaction, summary);
  const facts = {
    owner_id: owner,
    preparation_id: id,
    preparation_sha256: preparationSha256,
    unsigned_transaction: packet.transaction,
    packet_sha256: packet.sha256,
  };
  const row = schema.parse({
    ...facts,
    record_sha256: await digest(canonical(facts)),
  });
  return db
    .prepare(
      'INSERT INTO wallet_warmup_session_packets(owner_id,preparation_id,preparation_sha256,unsigned_transaction,packet_sha256,record_sha256) VALUES(?,?,?,?,?,?)',
    )
    .bind(
      row.owner_id,
      row.preparation_id,
      row.preparation_sha256,
      row.unsigned_transaction,
      row.packet_sha256,
      row.record_sha256,
    );
}

/** Saved-only recovery deliberately works after expiry; it cannot renew authority. */
export async function readWalletWarmupSessionPacket(
  db: D1Database,
  owner: string,
  id: string,
  preparationSha256: string,
  summary: WarmupPreparationSummary,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const installed = await db
    .prepare(
      "SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='wallet_warmup_session_packets'",
    )
    .first();
  if (!installed) return null; // Old summary-only preparations remain historical.
  const stored = await db
    .prepare(
      'SELECT * FROM wallet_warmup_session_packets WHERE owner_id=? AND preparation_id=?',
    )
    .bind(owner, id)
    .first<Row>();
  signal.throwIfAborted();
  if (!stored) return null;
  const { record_sha256, ...facts } = schema.parse(stored);
  if (
    facts.owner_id !== owner ||
    facts.preparation_id !== id ||
    facts.preparation_sha256 !== preparationSha256 ||
    facts.packet_sha256 !== summary.transaction.sha256 ||
    (await digest(canonical(facts))) !== record_sha256
  )
    throw unavailable();
  const packet = await validateWalletWarmupSessionPacket(
    facts.unsigned_transaction,
    summary,
  );
  signal.throwIfAborted();
  return packet;
}
