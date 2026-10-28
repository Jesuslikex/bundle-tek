import bs58 from 'bs58';
import { requireJitoManifest, type JitoBundleRecord } from './jito-bundle';
import { requireJitoFinalization } from './jito-finalization';
import { jitoOwnerScope } from './jito-owner-scope';
import { UUID } from './wallet-operation';

export type JitoV2Attempt = {
  bundleId: string;
  packet: number;
  attemptId: string;
  manifestSha256: string;
  signer: string;
  intentId: string | null;
  transaction: string | null;
  signature: string | null;
  state: 'unknown' | 'registered';
};

export type JitoV2Snapshot = {
  projectId: string;
  sessionId: string;
  bundle: JitoBundleRecord;
  attempts: JitoV2Attempt[];
  legacyReadOnly: boolean;
};

type ExpectedContext = {
  ownerId: string;
  responseOwnerScope: string | null;
  projectId: string;
  sessionId: string;
  bundleId: string;
  manifestSha256: string;
};

const fail = (): never => {
  throw new Error('Returned Jito snapshot differs.');
};
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function signature(value: unknown): value is string {
  if (typeof value !== 'string' || value.length < 80 || value.length > 90)
    return false;
  try {
    return bs58.decode(value).length === 64;
  } catch {
    return false;
  }
}

/**
 * Validates an exact-bundle GET response bound to the authenticated owner and
 * previously reviewed manifest. This only describes retained server evidence:
 * it never grants signing, retrying, cancelling, or submitting authority.
 * Callers must independently validate any signed transaction's exact bytes.
 */
export async function requireJitoV2Snapshot(
  rawValue: unknown,
  rawExpected: ExpectedContext,
): Promise<JitoV2Snapshot> {
  // Detach before the first asynchronous digest: the network response or its
  // calling context may otherwise be mutated while verification is pending.
  let value: unknown;
  let expected: ExpectedContext;
  try {
    value = structuredClone(rawValue);
    expected = structuredClone(rawExpected);
  } catch {
    return fail();
  }
  if (
    !expected ||
    typeof expected.ownerId !== 'string' ||
    expected.responseOwnerScope !== (await jitoOwnerScope(expected.ownerId)) ||
    !UUID.test(expected.projectId) ||
    !UUID.test(expected.sessionId) ||
    !UUID.test(expected.bundleId) ||
    !/^[a-f0-9]{64}$/.test(expected.manifestSha256) ||
    !object(value) ||
    value.projectId !== expected.projectId ||
    value.sessionId !== expected.sessionId ||
    typeof value.legacyReadOnly !== 'boolean' ||
    !Array.isArray(value.attempts) ||
    !object(value.bundle)
  )
    return fail();

  const record = value.bundle as unknown as JitoBundleRecord;
  if (!record.manifest || typeof record.manifest !== 'object') return fail();
  const manifest = await requireJitoManifest(record.manifest, false);
  if (
    manifest.id !== expected.bundleId ||
    manifest.projectId !== expected.projectId ||
    manifest.sessionId !== expected.sessionId ||
    manifest.sha256 !== expected.manifestSha256 ||
    ![
      'reviewed',
      'submitting',
      'submitted',
      'finalized',
      'cancelled',
      'expired',
    ].includes(record.state) ||
    !Array.isArray(record.signatures) ||
    record.signatures.length !== manifest.swaps.length + 1 ||
    record.signatures.some((s) => s !== null && !signature(s)) ||
    typeof record.updatedAt !== 'string' ||
    !Number.isFinite(Date.parse(record.updatedAt)) ||
    (record.bundleId !== null &&
      (typeof record.bundleId !== 'string' ||
        !/^[a-f0-9]{64}$/.test(record.bundleId))) ||
    (record.state === 'submitted' && record.bundleId === null) ||
    (['reviewed', 'submitting', 'cancelled'].includes(record.state) &&
      record.bundleId !== null) ||
    (['submitting', 'submitted', 'finalized'].includes(record.state) &&
      record.signatures.some((s) => s === null)) ||
    (record.state === 'cancelled' &&
      record.signatures.some((s) => s !== null)) ||
    (record.state === 'finalized' &&
      !record.finalization &&
      !value.legacyReadOnly) ||
    (record.state !== 'finalized' && Boolean(record.finalization))
  )
    return fail();
  const nonNullSignatures = record.signatures.filter(
    (s): s is string => s !== null,
  );
  if (new Set(nonNullSignatures).size !== nonNullSignatures.length)
    return fail();
  if (record.finalization)
    await requireJitoFinalization(
      record.finalization,
      manifest,
      record.signatures,
    );

  if (
    value.attempts.length > record.signatures.length ||
    (value.legacyReadOnly && value.attempts.length !== 0)
  )
    return fail();
  const packets = new Set<number>(),
    ids = new Set<string>();
  let unknownCount = 0;
  for (const attempt of value.attempts) {
    if (
      !object(attempt) ||
      typeof attempt.packet !== 'number' ||
      !Number.isSafeInteger(attempt.packet) ||
      attempt.packet < 0 ||
      attempt.packet >= record.signatures.length ||
      typeof attempt.attemptId !== 'string' ||
      !UUID.test(attempt.attemptId) ||
      packets.has(attempt.packet) ||
      ids.has(attempt.attemptId) ||
      attempt.bundleId !== manifest.id ||
      attempt.manifestSha256 !== manifest.sha256 ||
      attempt.signer !==
        (manifest.swaps[attempt.packet]?.wallet ?? manifest.tip.wallet) ||
      attempt.intentId !== (manifest.swaps[attempt.packet]?.id ?? null)
    )
      return fail();
    packets.add(attempt.packet);
    ids.add(attempt.attemptId);
    if (attempt.state === 'unknown') {
      unknownCount++;
      if (
        attempt.transaction !== null ||
        attempt.signature !== null ||
        record.signatures[attempt.packet] !== null ||
        record.state !== 'reviewed'
      )
        return fail();
    } else if (attempt.state === 'registered') {
      if (
        typeof attempt.transaction !== 'string' ||
        attempt.transaction.length < 1 ||
        attempt.transaction.length > 1644 ||
        !signature(attempt.signature) ||
        record.signatures[attempt.packet] !== attempt.signature
      )
        return fail();
    } else return fail();
  }
  if (unknownCount > 1 || (record.state === 'cancelled' && packets.size > 0))
    return fail();
  if (
    !value.legacyReadOnly &&
    record.signatures.some((s, i) => s !== null && !packets.has(i))
  )
    return fail();
  return value as unknown as JitoV2Snapshot;
}
