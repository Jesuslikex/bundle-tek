import 'server-only';
import { readJitoBundle } from './jito-bundle-server';
import { listJitoSignAttempts } from './jito-sign-attempt-server';
import { buildOwnedJitoSignedVector } from './jito-owned-signed-vector';
import { jitoOwnerScope } from './jito-owner-scope';
import { currentImportedPreparation } from './imported-swap-approval';
import { currentTradeSession } from './imported-trade-session-server';
import { currentImportedAcquisition } from './imported-acquisition-server';
import { restoreSavedSwapOrder } from './warmup-signing';
import type { SavedSwapPreparation } from './imported-swap-preparation-history';
import { UUID } from './wallet-operation';
import { jitoEvidenceSha256, snapshotJitoEvidence } from './jito-evidence-json';

type Context = { owner: string; bundleId: string; digest: string };
type Handle = Readonly<{ format: 'jito-owned-source-handle-v1' }>;
const issued = new WeakMap<
  Handle,
  { db: D1Database; context: Context; fingerprint: string }
>();
const fail = (): never => {
  throw Error('Owned registered Jito source unavailable.');
};

/* This is DB evidence only. The caller is responsible for authenticating owner;
 * an owner string, issued handle or matching reread does not prove authentication,
 * an atomic database snapshot, provider provenance or execution authority. */
async function read(db: D1Database, context: Context) {
  const { owner, bundleId, digest } = context;
  const bundle = await readJitoBundle(db, owner, bundleId);
  const m = bundle.manifest;
  const protocol = await db
    .prepare(
      'SELECT version,manifest_sha256 AS digest FROM jito_bundle_protocol WHERE owner_id=? AND bundle_id=?',
    )
    .bind(owner, bundleId)
    .first<{ version: number; digest: string }>();
  if (
    !protocol ||
    protocol.version !== 2 ||
    protocol.digest !== digest ||
    m.id !== bundleId ||
    m.sha256 !== digest
  )
    return fail();
  const project = await db
    .prepare(
      'SELECT revision,document,address,chain,archived FROM imported_token_projects WHERE owner_id=? AND id=?',
    )
    .bind(owner, m.projectId)
    .first<{
      revision: number;
      document: string;
      address: string;
      chain: string;
      archived: number;
    }>();
  if (!project || project.chain !== 'Solana' || project.archived !== 0)
    return fail();
  const attempts = await listJitoSignAttempts(db, owner, bundleId);
  const scope = await jitoOwnerScope(owner);
  const snapshot = {
    projectId: m.projectId,
    sessionId: m.sessionId,
    bundle: bundle.record,
    attempts,
    legacyReadOnly: false,
  };
  const vector = await buildOwnedJitoSignedVector({
    rawSnapshot: snapshot,
    ownerId: owner,
    responseOwnerScope: scope,
    projectId: m.projectId,
    sessionId: m.sessionId,
    bundleId,
    manifestSha256: digest,
  });
  const state: unknown[] = [];
  for (let index = 0; index < vector.packets.length; index++) {
    const packet = vector.packets[index];
    const receipt = await db
      .prepare(
        'SELECT attempt_id AS attemptId,manifest_sha256 AS digest,signer,intent_id AS intentId,`transaction`,signature FROM jito_sign_receipts WHERE owner_id=? AND bundle_id=? AND packet=?',
      )
      .bind(owner, bundleId, index)
      .first<{
        attemptId: string;
        digest: string;
        signer: string;
        intentId: string | null;
        transaction: string;
        signature: string;
      }>();
    if (
      !receipt ||
      receipt.attemptId !== packet.attemptId ||
      receipt.digest !== digest ||
      receipt.signer !== packet.signer ||
      receipt.intentId !== packet.intentId ||
      receipt.transaction !== packet.transaction ||
      receipt.signature !== packet.signature ||
      bundle.packets[index].transaction !== packet.transaction ||
      bundle.packets[index].signature !== packet.signature
    )
      return fail();
    if (packet.intentId === null) {
      state.push({ receipt });
      continue;
    }
    const review = m.swaps[index];
    const savedRow = await currentImportedPreparation(
      db,
      owner,
      review.preparationId,
    );
    if (!savedRow) return fail();
    const saved: SavedSwapPreparation = {
      ...savedRow,
      document: JSON.parse(savedRow.document),
    };
    if (
      saved.projectId !== m.projectId ||
      saved.document.conditional ||
      !review.session ||
      JSON.stringify(saved.document.acquisition ?? null) !==
        JSON.stringify(review.acquisition ?? null) ||
      JSON.stringify(saved.document.session) !== JSON.stringify(review.session)
    )
      return fail();
    const order = await restoreSavedSwapOrder(saved, review.transaction);
    if (
      order.preparation.wallet !== review.wallet ||
      order.inputMint !== review.inputMint ||
      order.outputMint !== review.outputMint ||
      order.inAmount !== review.inputRaw ||
      order.minimumOutAmount !== review.minimumOutputRaw ||
      JSON.stringify(order.platformFee ?? null) !==
        JSON.stringify(review.platformFee ?? null) ||
      order.preparation.lastValidBlockHeight !== review.lastValidBlockHeight ||
      order.expiresAt !== review.expiresAt
    )
      return fail();
    const session = await currentTradeSession(db, owner, saved, review.id);
    if (!session) return fail();
    const acquisition = review.acquisition
      ? await currentImportedAcquisition(db, owner, review.acquisition, true)
      : null;
    const intent = await db
      .prepare(
        'SELECT document,state,signature,preparation_id AS preparationId,wallet_address AS wallet FROM imported_swap_signing_intents WHERE owner_id=? AND id=?',
      )
      .bind(owner, review.id)
      .first<{
        document: string;
        state: string;
        signature: string;
        preparationId: string;
        wallet: string;
      }>();
    const reservations = await db
      .prepare(
        'SELECT r.scope AS swapScope,r.intent_id AS swapIntent,r.state AS swapState,e.scope AS executionScope,e.intent_id AS executionIntent,e.state AS executionState FROM solana_swap_reservations r JOIN solana_execution_reservations e ON e.owner_id=r.owner_id AND e.wallet_address=r.wallet_address WHERE r.owner_id=? AND r.wallet_address=?',
      )
      .bind(owner, review.wallet)
      .first<{
        swapScope: string;
        swapIntent: string;
        swapState: string;
        executionScope: string;
        executionIntent: string;
        executionState: string;
      }>();
    if (
      !intent ||
      intent.document !== JSON.stringify(review) ||
      intent.state !== 'signed' ||
      intent.signature !== packet.signature ||
      intent.preparationId !== review.preparationId ||
      intent.wallet !== review.wallet ||
      !reservations ||
      reservations.swapScope !== 'imported' ||
      reservations.swapIntent !== review.id ||
      reservations.swapState !== 'signed' ||
      reservations.executionScope !== 'imported' ||
      reservations.executionIntent !== review.id ||
      reservations.executionState !== 'signed'
    )
      return fail();
    state.push({
      receipt,
      savedRow,
      session,
      acquisition,
      intent,
      reservations,
    });
  }
  const captured = snapshotJitoEvidence({
    bundle: bundle.record,
    packets: bundle.packets,
    protocol,
    project,
    attempts,
    vector: vector.fingerprint,
    state,
  });
  const bytes = new TextEncoder().encode(JSON.stringify(captured));
  try {
    return await jitoEvidenceSha256(bytes);
  } finally {
    bytes.fill(0);
  }
}

/** Caller owner is not authentication. Opaque handles remain in process only. */
export async function captureOwnedRegisteredJitoSource(
  db: D1Database,
  owner: string,
  bundleId: string,
  digest: string,
): Promise<Handle> {
  if (
    typeof owner !== 'string' ||
    !owner ||
    owner.length > 256 ||
    typeof bundleId !== 'string' ||
    !UUID.test(bundleId) ||
    typeof digest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(digest)
  )
    return fail();
  const context = { owner, bundleId, digest };
  try {
    const first = await read(db, context);
    if (first !== (await read(db, context))) return fail();
    const handle = Object.freeze({
      format: 'jito-owned-source-handle-v1' as const,
    });
    issued.set(handle, { db, context, fingerprint: first });
    return handle;
  } catch {
    return fail();
  }
}

/** Comparison is diagnostic, not a lock or guarantee against later changes. */
export async function recheckOwnedRegisteredJitoSource(handle: Handle) {
  const saved = issued.get(handle);
  try {
    if (!saved || (await read(saved.db, saved.context)) !== saved.fingerprint)
      return fail();
    return Object.freeze({
      matched: true as const,
      sourceCurrent: false as const,
      providerQualified: false as const,
      signingAllowed: false as const,
      executionAllowed: false as const,
    });
  } catch {
    return fail();
  }
}
