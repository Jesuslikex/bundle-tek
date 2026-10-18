import { volumeDigest, volumeReject } from './volume-bundle-construction';
import {
  inspectVolumeSignedPacket,
  verifyVolumePumpSettlement,
  type VolumeFinalizedReceipt,
} from './volume-bundle-settlement';
import { readVolumeBundleReservation } from './volume-bundle-reservations';
import type { VolumeValidatedRuntime } from './volume-bundle-programs';
import { SOLANA_MAINNET_GENESIS } from './wallet-balances';

export type VolumeRecoveryRpc = (
  method: 'getGenesisHash' | 'getTransaction',
  params: unknown[],
  signal: AbortSignal,
) => Promise<unknown>;
type Binding = {
  reservation_id: string;
  owner_id: string;
  attempt_id: string;
  signature: string;
  packet: string;
  packet_sha256: string;
};
type Resolution = {
  reservation_id: string;
  owner_id: string;
  signature: string;
  document: string;
  sha256: string;
  tip_spent: number;
  packet: string;
  packet_sha256: string;
  bound_signature: string;
  bound_attempt: string;
};
async function context(db: D1Database, owner: string, id: string) {
  const reservation = await readVolumeBundleReservation(db, owner, id);
  if (
    !reservation ||
    !reservation.attemptId ||
    !['attempted', 'settled'].includes(reservation.state)
  )
    return volumeReject('An owned attempted reservation is required.');
  const raw = await db
    .prepare(
      'SELECT document FROM volume_bundle_reservations WHERE owner_id=? AND id=?',
    )
    .bind(owner, id)
    .first<{ document: string }>();
  if (!raw) return volumeReject('Stored runtime unavailable.');
  return {
    reservation,
    runtime: JSON.parse(raw.document) as VolumeValidatedRuntime,
  };
}
/** Metadata registration only. The caller must already possess a user-signed packet; no signer or send is provided. */
export async function bindVolumeRecoveryPacket(
  db: D1Database,
  owner: string,
  id: string,
  attemptId: string,
  packet: string,
) {
  const { reservation, runtime } = await context(db, owner, id);
  if (reservation.attemptId !== attemptId)
    volumeReject('Recovery attempt differs.');
  const inspected = await inspectVolumeSignedPacket(
    runtime.construction,
    packet,
  );
  await db
    .prepare(`INSERT INTO volume_bundle_recovery_packets(reservation_id,owner_id,attempt_id,signature,packet,packet_sha256,created_at)
    SELECT ?,?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE NOT EXISTS(SELECT 1 FROM volume_bundle_recovery_packets WHERE reservation_id=?)`)
    .bind(
      id,
      owner,
      attemptId,
      inspected.signature,
      packet,
      inspected.signedPacketSha256,
      id,
    )
    .run();
  const saved = await db
    .prepare(
      'SELECT * FROM volume_bundle_recovery_packets WHERE owner_id=? AND reservation_id=?',
    )
    .bind(owner, id)
    .first<Binding>();
  if (
    !saved ||
    saved.attempt_id !== attemptId ||
    saved.packet !== packet ||
    saved.signature !== inspected.signature ||
    saved.packet_sha256 !== inspected.signedPacketSha256
  )
    return volumeReject('Recovery packet is already bound differently.');
  return {
    signature: saved.signature,
    signedPacketSha256: saved.packet_sha256,
    signingAllowed: false as const,
    executionAllowed: false as const,
  };
}
export async function readVolumeSettlementRecovery(
  db: D1Database,
  owner: string,
  id: string,
) {
  const { reservation, runtime } = await context(db, owner, id);
  const row = await db
    .prepare(
      `SELECT s.*,b.packet,b.packet_sha256,b.signature AS bound_signature,b.attempt_id AS bound_attempt
       FROM volume_bundle_settlements s JOIN volume_bundle_recovery_packets b ON b.reservation_id=s.reservation_id AND b.owner_id=s.owner_id
       WHERE s.owner_id=? AND s.reservation_id=?`,
    )
    .bind(owner, id)
    .first<Resolution>();
  if (!row) {
    if (reservation.state === 'settled')
      volumeReject('Stored settlement is missing.');
    return null;
  }
  const document = JSON.parse(row.document) as RecoveryDocument;
  const { sha256, ...terms } = document;
  const current = await readVolumeBundleReservation(db, owner, id);
  if (
    current?.state !== 'settled' ||
    row.sha256 !== sha256 ||
    (await volumeDigest(terms)) !== sha256 ||
    document.reservationId !== id ||
    document.attemptId !== reservation.attemptId ||
    document.runtimeSha256 !== runtime.sha256 ||
    document.format !== 'volume-settlement-recovery-v1' ||
    document.historicalCodeAttested !== false ||
    document.proof.pumpAccountingVerified !== true ||
    document.proof.routeSha256 !== runtime.route.sha256 ||
    document.proof.constructionSha256 !== reservation.constructionSha256 ||
    document.receipt.result.slot < runtime.simulation.slotMax ||
    document.proof.signature !== row.signature ||
    row.bound_signature !== row.signature ||
    row.bound_attempt !== reservation.attemptId ||
    document.receipt.result.transaction[0] !== row.packet ||
    document.proof.signedPacketSha256 !== row.packet_sha256 ||
    document.proof.tipLamports !== String(row.tip_spent) ||
    document.executionAllowed !== false ||
    document.signingAllowed !== false
  )
    volumeReject('Stored settlement differs.');
  const proof = await verifyVolumePumpSettlement(
    runtime.construction,
    runtime.route,
    document.receipt,
  );
  if (JSON.stringify(proof) !== JSON.stringify(document.proof))
    volumeReject('Stored receipt accounting differs.');
  return document;
}
type RecoveryDocument = {
  format: 'volume-settlement-recovery-v1';
  reservationId: string;
  attemptId: string;
  runtimeSha256: string;
  proof: Awaited<ReturnType<typeof verifyVolumePumpSettlement>>;
  receipt: VolumeFinalizedReceipt;
  signingAllowed: false;
  executionAllowed: false;
  historicalCodeAttested: false;
  sha256: string;
};
/** One bounded finalized lookup per invocation. Only verified success or exact fee-only rollback settles a hold. */
export async function recoverVolumeBundleSettlement(
  db: D1Database,
  owner: string,
  id: string,
  rpc: VolumeRecoveryRpc,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const { reservation, runtime } = await context(db, owner, id);
  const old = await readVolumeSettlementRecovery(db, owner, id);
  if (old) return old;
  const binding = await db
    .prepare(
      'SELECT * FROM volume_bundle_recovery_packets WHERE owner_id=? AND reservation_id=?',
    )
    .bind(owner, id)
    .first<Binding>();
  if (!binding || binding.attempt_id !== reservation.attemptId)
    return volumeReject('Bind the exact attempted packet before recovery.');
  const packet = await inspectVolumeSignedPacket(
    runtime.construction,
    binding.packet,
  );
  if (
    packet.signature !== binding.signature ||
    packet.signedPacketSha256 !== binding.packet_sha256
  )
    volumeReject('Stored recovery packet differs.');
  const scope = AbortSignal.any([signal, AbortSignal.timeout(15000)]);
  const call = (
    method: 'getGenesisHash' | 'getTransaction',
    params: unknown[],
  ) =>
    new Promise<unknown>((resolve, reject) => {
      scope.throwIfAborted();
      const abort = () =>
        reject(new Error('Settlement recovery cancelled or expired.'));
      scope.addEventListener('abort', abort, { once: true });
      Promise.resolve()
        .then(() => {
          scope.throwIfAborted();
          return rpc(method, params, scope);
        })
        .then(
          (value) => {
            scope.throwIfAborted();
            resolve(value);
          },
          () => reject(new Error('Settlement recovery RPC unavailable.')),
        )
        .catch(reject)
        .finally(() => scope.removeEventListener('abort', abort));
    });
  if ((await call('getGenesisHash', [])) !== SOLANA_MAINNET_GENESIS)
    volumeReject('Recovery requires mainnet evidence.');
  const result = await call('getTransaction', [
    binding.signature,
    {
      commitment: 'finalized',
      encoding: 'base64',
      maxSupportedTransactionVersion: 0,
    },
  ]);
  if ((await call('getGenesisHash', [])) !== SOLANA_MAINNET_GENESIS)
    volumeReject('Recovery network changed.');
  if (result === null)
    return {
      state: 'unresolved' as const,
      holdsRetained: true as const,
      signingAllowed: false as const,
      executionAllowed: false as const,
    };
  // Injected transport is a server trust boundary. Bound before storing or interpreting provider metadata.
  const text = JSON.stringify(result);
  if (!text || text.length > 262144)
    volumeReject('Bounded finalized receipt required.');
  const receipt: VolumeFinalizedReceipt = {
    commitment: 'finalized',
    signature: binding.signature,
    result: JSON.parse(text) as VolumeFinalizedReceipt['result'],
  };
  if (
    receipt.result.transaction?.[0] !== binding.packet ||
    receipt.result.slot < runtime.simulation.slotMax
  )
    volumeReject(
      'Finalized receipt predates review or differs from attempted packet.',
    );
  const proof = await verifyVolumePumpSettlement(
    runtime.construction,
    runtime.route,
    receipt,
  );
  if (proof.signedPacketSha256 !== binding.packet_sha256)
    volumeReject('Finalized packet hash differs.');
  scope.throwIfAborted();
  const terms = {
    format: 'volume-settlement-recovery-v1' as const,
    reservationId: id,
    attemptId: binding.attempt_id,
    runtimeSha256: runtime.sha256,
    proof,
    receipt,
    signingAllowed: false as const,
    executionAllowed: false as const,
    historicalCodeAttested: false as const,
  };
  const document: RecoveryDocument = {
    ...terms,
    sha256: await volumeDigest(terms),
  };
  scope.throwIfAborted();
  // The insert and reservation transition occur in one SQL statement/trigger transaction.
  await db
    .prepare(`INSERT INTO volume_bundle_settlements(reservation_id,owner_id,signature,document,sha256,tip_spent,created_at)
    SELECT ?,?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE NOT EXISTS(SELECT 1 FROM volume_bundle_settlements WHERE reservation_id=?)`)
    .bind(
      id,
      owner,
      binding.signature,
      JSON.stringify(document),
      document.sha256,
      Number(proof.tipLamports),
      id,
    )
    .run();
  const saved = await readVolumeSettlementRecovery(db, owner, id);
  if (!saved || saved.sha256 !== document.sha256)
    volumeReject('Conflicting finalized settlement.');
  return saved;
}
