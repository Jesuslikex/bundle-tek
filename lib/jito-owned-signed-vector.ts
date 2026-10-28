import { jitoOwnerScope } from './jito-owner-scope';
import { requireJitoV2Snapshot } from './jito-v2-snapshot';
import { verifyExactSwapSignature } from './exact-swap-signature';
import { inspectNativeWithdrawal } from './native-withdrawal';
import { requireJitoManifest } from './jito-bundle';

/** Pure detached packet evidence, never a qualification or a send permit.
 * The caller must obtain rawSnapshot and responseOwnerScope from the SAME
 * authenticated exact-bundle read; a header alone does not authenticate it.
 * The returned byte arrays are private copies but remain mutable. Callers must
 * recompute/compare their binding at their own final use boundary. */
export async function buildOwnedJitoSignedVector(input: {
  rawSnapshot: unknown;
  ownerId: string;
  responseOwnerScope: string | null;
  projectId: string;
  sessionId: string;
  bundleId: string;
  manifestSha256: string;
}) {
  // Detach the complete input before hashing, parsing, or signature checks.
  const detached = structuredClone(input);
  const snapshot = await requireJitoV2Snapshot(detached.rawSnapshot, {
    ownerId: detached.ownerId,
    responseOwnerScope: detached.responseOwnerScope,
    projectId: detached.projectId,
    sessionId: detached.sessionId,
    bundleId: detached.bundleId,
    manifestSha256: detached.manifestSha256,
  });
  const manifest = await requireJitoManifest(snapshot.bundle.manifest);
  const count = manifest.swaps.length + 1;
  if (
    snapshot.legacyReadOnly ||
    snapshot.bundle.state !== 'reviewed' ||
    snapshot.bundle.bundleId !== null ||
    snapshot.attempts.length !== count ||
    snapshot.bundle.signatures.length !== count ||
    snapshot.bundle.signatures.some((s) => !s)
  )
    throw Error('Exact registered bundle required.');
  const attempts = [...snapshot.attempts].sort((a, b) => a.packet - b.packet);
  const packets: Array<{
    packet: number;
    attemptId: string;
    signer: string;
    intentId: string | null;
    signature: string;
    transaction: string;
    bytes: Uint8Array;
  }> = [];
  for (let index = 0; index < count; index++) {
    const attempt = attempts[index];
    if (
      !attempt ||
      attempt.packet !== index ||
      attempt.state !== 'registered' ||
      !attempt.transaction ||
      !attempt.signature
    )
      throw Error('Exact registered bundle required.');
    const bytes = Uint8Array.from(Buffer.from(attempt.transaction, 'base64'));
    if (
      bytes.length === 0 ||
      bytes.length > 1232 ||
      Buffer.from(bytes).toString('base64') !== attempt.transaction
    )
      throw Error('Canonical signed packet required.');
    const review = manifest.swaps[index];
    const signature = review
      ? verifyExactSwapSignature(review, attempt.transaction)
      : (await inspectNativeWithdrawal(manifest.tip, attempt.transaction, true))
          .signature;
    if (
      !signature ||
      signature !== attempt.signature ||
      signature !== snapshot.bundle.signatures[index]
    )
      throw Error('Signed packet differs.');
    packets.push({
      packet: index,
      attemptId: attempt.attemptId,
      signer: attempt.signer,
      intentId: attempt.intentId,
      signature,
      transaction: attempt.transaction,
      bytes,
    });
  }
  const scope = await jitoOwnerScope(detached.ownerId);
  if (scope !== detached.responseOwnerScope)
    throw Error('Owned scope differs.');
  const encoder = new TextEncoder();
  const pieces: Uint8Array[] = [];
  let total = 0;
  const field = (bytes: Uint8Array) => {
    if (bytes.length > 0xffffffff) throw Error('Vector field too large.');
    const length = new Uint8Array(4);
    new DataView(length.buffer).setUint32(0, bytes.length, false);
    pieces.push(length, bytes);
    total += 4 + bytes.length;
  };
  const text = (value: string) => field(encoder.encode(value));
  text('bundle-tek/jito-signed-vector/v1');
  text(scope);
  text(detached.projectId);
  text(detached.sessionId);
  text(detached.bundleId);
  text(detached.manifestSha256);
  text(String(count));
  for (const packet of packets) {
    text(String(packet.packet));
    text(packet.attemptId);
    text(packet.signer);
    text(packet.intentId === null ? 'tip' : `intent:${packet.intentId}`);
    text(packet.signature);
    field(packet.bytes);
  }
  const vector = new Uint8Array(total);
  let offset = 0;
  for (const piece of pieces) {
    vector.set(piece, offset);
    offset += piece.length;
  }
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', vector));
  vector.fill(0);
  return {
    format: 'jito-owned-signed-vector-v1' as const,
    ownerScope: scope,
    projectId: detached.projectId,
    sessionId: detached.sessionId,
    bundleId: detached.bundleId,
    manifestSha256: detached.manifestSha256,
    fingerprint: Array.from(digest, (b) =>
      b.toString(16).padStart(2, '0'),
    ).join(''),
    packets,
    signatureVerified: true as const,
    sourceAuthenticated: false as const,
    currentStateVerified: false as const,
    providerQualified: false as const,
    runtimeAttested: false as const,
    signingAllowed: false as const,
    executionAllowed: false as const,
    automaticExecutionAllowed: false as const,
  };
}
