import { UUID } from './wallet-operation';
import { verifyExactSwapSignature } from './imported-swap-approval';
import { inspectNativeWithdrawal } from './native-withdrawal';
import { requireJitoManifest } from './jito-bundle';
import { readJitoBundle } from './jito-bundle-server';

type AttemptRow = {
  bundleId: string;
  packet: number;
  attemptId: string;
  manifestSha256: string;
  signer: string;
  intentId: string | null;
  transaction: string | null;
  signature: string | null;
};

/** Discover outstanding attempts after a reload or on another signed-in device. */
export async function listJitoSignAttempts(
  db: D1Database,
  owner: string,
  bundleId: string,
) {
  const rows = await db
    .prepare(`SELECT a.attempt_id AS attemptId FROM jito_sign_attempts a
    WHERE a.owner_id=? AND a.bundle_id=? ORDER BY a.packet`)
    .bind(owner, bundleId)
    .all<{ attemptId: string }>();
  const attempts = await Promise.all(
    rows.results.map((r) => readJitoSignAttempt(db, owner, r.attemptId)),
  );
  if (attempts.some((a) => !a || a.bundleId !== bundleId))
    throw new Error('Bundle attempt history differs.');
  return attempts;
}

/** The authenticated owner can recover by the exact caller-supplied nonce. */
export async function readJitoSignAttempt(
  db: D1Database,
  owner: string,
  attemptId: string,
) {
  if (!UUID.test(attemptId))
    throw new Error('Bundle attempt identity differs.');
  const row = await db
    .prepare(`SELECT a.bundle_id AS bundleId, a.packet,
    a.attempt_id AS attemptId, a.manifest_sha256 AS manifestSha256,
    a.signer, a.intent_id AS intentId, r.\`transaction\`, r.signature
    FROM jito_sign_attempts a LEFT JOIN jito_sign_receipts r
      ON r.owner_id=a.owner_id AND r.bundle_id=a.bundle_id AND r.packet=a.packet
      AND r.attempt_id=a.attempt_id
    WHERE a.owner_id=? AND a.attempt_id=?`)
    .bind(owner, attemptId)
    .first<AttemptRow>();
  if (!row) return null;
  if (Boolean(row.signature) !== Boolean(row.transaction))
    throw new Error('Bundle attempt receipt differs.');
  return {
    ...row,
    state: row.signature ? ('registered' as const) : ('unknown' as const),
  };
}

export async function beginJitoSignAttempt(
  db: D1Database,
  owner: string,
  id: string,
  digest: string,
  packet: number,
  attemptId: string,
) {
  if (
    !UUID.test(attemptId) ||
    !Number.isSafeInteger(packet) ||
    packet < 0 ||
    !/^[a-f0-9]{64}$/.test(digest)
  )
    throw new Error('Bundle attempt identity differs.');
  const matches = (a: Awaited<ReturnType<typeof readJitoSignAttempt>>) =>
    a &&
    a.bundleId === id &&
    a.packet === packet &&
    a.manifestSha256 === digest;
  const prior = await readJitoSignAttempt(db, owner, attemptId);
  if (prior) {
    if (!matches(prior)) throw new Error('Bundle attempt identity differs.');
    return { attempt: prior, mayInvokeSigner: false as const };
  }
  const bundle = await readJitoBundle(db, owner, id);
  await requireJitoManifest(bundle.manifest);
  if (
    bundle.row.state !== 'reviewed' ||
    bundle.manifest.sha256 !== digest ||
    packet > bundle.manifest.swaps.length ||
    bundle.packets[packet].signature
  )
    throw new Error('Current complete bundle approval required.');
  const swap = bundle.manifest.swaps[packet];
  const signer = swap?.wallet ?? bundle.manifest.tip.wallet;
  try {
    const result = await db
      .prepare(`INSERT INTO jito_sign_attempts
      (owner_id,bundle_id,packet,attempt_id,manifest_sha256,signer,intent_id,created_at)
      VALUES(?,?,?,?,?,?,?,?)`)
      .bind(
        owner,
        id,
        packet,
        attemptId,
        digest,
        signer,
        swap?.id ?? null,
        new Date().toISOString(),
      )
      .run();
    if ((result.success as boolean) === false || result.meta?.changes !== 1)
      throw new Error('Bundle attempt was not inserted.');
  } catch {
    // A duplicate after a lost response is safe only if its complete identity matches.
    const existing = await readJitoSignAttempt(db, owner, attemptId);
    if (!matches(existing))
      throw new Error(
        'Bundle attempt is unavailable or conflicts with another operation.',
      );
    return { attempt: existing!, mayInvokeSigner: false as const };
  }
  const stored = await readJitoSignAttempt(db, owner, attemptId);
  if (!matches(stored))
    throw new Error('Bundle attempt was not durably acknowledged.');
  return { attempt: stored!, mayInvokeSigner: stored!.state === 'unknown' };
}

export async function registerJitoSignAttempt(
  db: D1Database,
  owner: string,
  id: string,
  digest: string,
  packet: number,
  attemptId: string,
  transaction: string,
) {
  const bundle = await readJitoBundle(db, owner, id);
  await requireJitoManifest(bundle.manifest, false);
  if (
    bundle.row.state !== 'reviewed' ||
    bundle.manifest.sha256 !== digest ||
    !Number.isSafeInteger(packet) ||
    packet < 0 ||
    packet > bundle.manifest.swaps.length
  )
    throw new Error('Current complete bundle approval required.');
  const review = bundle.manifest.swaps[packet];
  const signature = review
    ? verifyExactSwapSignature(review, transaction)
    : (await inspectNativeWithdrawal(bundle.manifest.tip, transaction, true))
        .signature!;
  const attempt = await readJitoSignAttempt(db, owner, attemptId);
  if (
    !attempt ||
    attempt.bundleId !== id ||
    attempt.packet !== packet ||
    attempt.manifestSha256 !== digest ||
    attempt.signer !== (review?.wallet ?? bundle.manifest.tip.wallet) ||
    attempt.intentId !== (review?.id ?? null)
  )
    throw new Error('Bundle attempt identity differs.');
  if (attempt.state === 'registered') {
    if (attempt.signature !== signature || attempt.transaction !== transaction)
      throw new Error('Registered bundle packet differs.');
    return bundle.record;
  }
  try {
    await db
      .prepare(`INSERT INTO jito_sign_receipts
      (owner_id,bundle_id,packet,attempt_id,manifest_sha256,signer,intent_id,\`transaction\`,signature,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?)`)
      .bind(
        owner,
        id,
        packet,
        attemptId,
        digest,
        attempt.signer,
        attempt.intentId,
        transaction,
        signature,
        new Date().toISOString(),
      )
      .run();
  } catch {
    const existing = await readJitoSignAttempt(db, owner, attemptId);
    if (
      !existing ||
      existing.state !== 'registered' ||
      existing.bundleId !== id ||
      existing.packet !== packet ||
      existing.manifestSha256 !== digest ||
      existing.signature !== signature ||
      existing.transaction !== transaction
    )
      throw new Error('Bundle registration was not durably acknowledged.');
  }
  const stored = await readJitoSignAttempt(db, owner, attemptId);
  if (
    !stored ||
    stored.state !== 'registered' ||
    stored.signature !== signature ||
    stored.transaction !== transaction
  )
    throw new Error('Bundle registration was not durably acknowledged.');
  return (await readJitoBundle(db, owner, id)).record;
}
