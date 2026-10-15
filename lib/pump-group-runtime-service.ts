import { address } from '@solana/kit-v1';
import bs58 from 'bs58';
import { PumpPreflightError } from './owned-pump-preflight';
import {
  readPumpLaunchGroupReview,
  refreshPumpLaunchGroupReview,
  approvePumpLaunchGroupReview,
} from './pump-launch-group-review-service';
import {
  requirePumpLaunchGroupConsent,
  type PumpLaunchGroupConsent,
} from './pump-launch-group-review';
import { collectPumpProgramIdentities } from './pump-group-code-identity';
import {
  pumpRpcAccount,
  pumpAccountBytes,
  pumpUnsignedInteger,
  type PumpLaunchRpc,
} from './pump-launch-simulation';
import {
  pumpGroupProgramDataLink,
  requirePumpGroupDeploymentHeader,
} from './pump-launch-group-deployments';
import {
  canonicalPumpHolderJson,
  pumpHolderDigest,
} from './pump-holder-review';
import { SOLANA_MAINNET_GENESIS } from './wallet-balances';
import {
  requirePumpRuntimePreview,
  pumpGroupRuntimeProgramScope,
  requirePumpCodeConsent,
  type PumpGroupRuntimePreview,
  type PumpGroupCodeConsent,
  type PumpGroupSigningAuthorization,
} from './pump-group-runtime-authorization';
const fail = (message: string, status = 409): never => {
  throw new PumpPreflightError(message, status);
};
async function installed(db: D1Database) {
  const n = await db
    .prepare(
      "SELECT count(*) AS n FROM sqlite_master WHERE type='trigger' AND name IN ('pump_group_runtime_insert','pump_group_runtime_no_update','pump_group_runtime_no_delete','pump_group_signing_auth_insert','pump_group_signing_auth_no_update','pump_group_signing_auth_no_delete')",
    )
    .first<{ n: number }>();
  if (n?.n !== 6)
    fail('Runtime signing authorization migration is not installed.', 503);
}
export async function previewOwnedPumpGroupRuntime(
  db: D1Database,
  owner: string,
  id: string,
  signal: AbortSignal,
  rpc: PumpLaunchRpc,
) {
  signal.throwIfAborted();
  await installed(db);
  const saved = await readPumpLaunchGroupReview(db, owner, id);
  if (!['review', 'approved'].includes(saved.state))
    return fail('Select an unsigned live complete group.');
  const fresh = await refreshPumpLaunchGroupReview(db, owner, id, signal, rpc);
  const programs = await pumpGroupRuntimeProgramScope(saved.review);
  const identity = await collectPumpProgramIdentities(
    programs,
    fresh.checked.simulation.bankSlot,
    signal,
    rpc,
  );
  const after = await readPumpLaunchGroupReview(db, owner, id);
  if (canonicalPumpHolderJson(after) !== canonicalPumpHolderJson(saved))
    return fail('Group changed while reading runtime code.');
  const now = Date.now();
  const preview: PumpGroupRuntimePreview = {
    format: 'pump-group-runtime-preview-v1',
    id: crypto.randomUUID(),
    reviewId: id,
    contextSha256: saved.review.contextSha256,
    manifestSha256: saved.review.manifestSha256,
    simulationSha256: saved.review.simulationSha256,
    programs: identity.programs,
    identitySha256: await pumpHolderDigest({
      reviewId: id,
      contextSha256: saved.review.contextSha256,
      programs: identity.programs,
    }),
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(
      Math.min(now + 30000, Date.parse(saved.review.expiresAt)),
    ).toISOString(),
    codeIdentityVerified: true,
    semanticAuditEstablished: false,
    signingAllowed: false,
    executionAllowed: false,
  };
  await requirePumpRuntimePreview(preview, saved.review);
  signal.throwIfAborted();
  try {
    await db
      .prepare(
        'INSERT INTO pump_group_runtime_reviews(id,owner_id,review_id,context_sha256,identity_sha256,preview,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?)',
      )
      .bind(
        preview.id,
        owner,
        id,
        preview.contextSha256,
        preview.identitySha256,
        canonicalPumpHolderJson(preview),
        preview.createdAt,
        preview.expiresAt,
      )
      .run();
  } catch {
    return fail('Group changed before runtime preview storage.');
  }
  return preview;
}
async function recheckHeaders(
  preview: PumpGroupRuntimePreview,
  signal: AbortSignal,
  rpc: PumpLaunchRpc,
) {
  signal.throwIfAborted();
  if ((await rpc('getGenesisHash', [], signal)) !== SOLANA_MAINNET_GENESIS)
    return fail('Runtime provider network differs.');
  const latest = (await rpc(
    'getLatestBlockhash',
    [{ commitment: 'confirmed' }],
    signal,
  )) as { context: { slot: unknown } };
  const slot = Number(pumpUnsignedInteger(latest?.context?.slot));
  if (!Number.isSafeInteger(slot)) return fail('Runtime bank is unavailable.');
  const keys = preview.programs.map((p) => p.address),
    links = preview.programs
      .filter((p) => p.programData !== null)
      .map((p) => p.programData!);
  const all = [...keys, ...links];
  const value = (await rpc(
    'getMultipleAccounts',
    [
      all,
      {
        encoding: 'base64',
        commitment: 'confirmed',
        minContextSlot: slot,
        dataSlice: { offset: 0, length: 45 },
      },
    ],
    signal,
  )) as { context: { slot: unknown }; value: unknown[] };
  const bank = Number(pumpUnsignedInteger(value?.context?.slot));
  if (
    !Number.isSafeInteger(bank) ||
    bank < slot ||
    bank - slot > 32 ||
    !Array.isArray(value.value) ||
    value.value.length !== all.length
  )
    return fail('Runtime header bank or scope differs.');
  const accounts = value.value.map(pumpRpcAccount);
  for (const [i, p] of preview.programs.entries()) {
    address(p.address);
    const account = accounts[i];
    if (
      !account ||
      account.owner !== p.loader ||
      pumpGroupProgramDataLink(p.address, account) !== p.programData
    )
      return fail('Runtime program link or loader changed.');
    if (p.identityKind === 'native-system') {
      const digest = Buffer.from(
        await crypto.subtle.digest(
          'SHA-256',
          Uint8Array.from(pumpAccountBytes(account)),
        ),
      ).toString('hex');
      if (digest !== p.codeSha256)
        return fail('Native runtime identity changed.');
    }
    if (p.programData) {
      const header = accounts[all.indexOf(p.programData)];
      requirePumpGroupDeploymentHeader(header, bank);
      if (!header) return fail('Program deployment disappeared.');
      const bytes = pumpAccountBytes(header);
      const deployment = new DataView(
        bytes.buffer,
        bytes.byteOffset,
        bytes.byteLength,
      )
        .getBigUint64(4, true)
        .toString();
      const authority =
        bytes[12] === 1 ? bs58.encode(bytes.slice(13, 45)) : null;
      if (deployment !== p.deploymentSlot || authority !== p.upgradeAuthority)
        return fail('Program deployment or upgrade authority changed.');
    }
  }
  signal.throwIfAborted();
  return bank;
}
export async function authorizeOwnedPumpGroupSigning(
  db: D1Database,
  owner: string,
  id: string,
  previewId: string,
  consent: PumpLaunchGroupConsent,
  codeConsent: PumpGroupCodeConsent,
  signal: AbortSignal,
  rpc: PumpLaunchRpc,
) {
  signal.throwIfAborted();
  await installed(db);
  const saved = await readPumpLaunchGroupReview(db, owner, id);
  requirePumpLaunchGroupConsent(saved.review, consent);
  const row = await db
    .prepare(
      'SELECT preview FROM pump_group_runtime_reviews WHERE owner_id=? AND review_id=? AND id=?',
    )
    .bind(owner, id, previewId)
    .first<{ preview: string }>();
  if (!row) return fail('Read and approve this group’s deployed code first.');
  const preview = await requirePumpRuntimePreview(
    JSON.parse(row.preview),
    saved.review,
  );
  requirePumpCodeConsent(preview, codeConsent);
  const keys = await pumpGroupRuntimeProgramScope(saved.review);
  if (
    [...keys].sort().join(',') !==
    preview.programs
      .map((p) => p.address)
      .sort()
      .join(',')
  )
    return fail('Runtime program coverage differs.');
  const approved = await approvePumpLaunchGroupReview(
    db,
    owner,
    id,
    consent,
    signal,
    rpc,
  );
  if (
    approved.state !== 'approved' ||
    canonicalPumpHolderJson(approved.review) !==
      canonicalPumpHolderJson(saved.review)
  )
    return fail('Group approval changed.');
  const currentBank = await recheckHeaders(preview, signal, rpc);
  const currentCode = await collectPumpProgramIdentities(
    keys,
    currentBank,
    signal,
    rpc,
  );
  if (
    canonicalPumpHolderJson(currentCode.programs) !==
    canonicalPumpHolderJson(preview.programs)
  )
    return fail(
      'Deployed group code changed after explicit code approval. Read and approve its new identities.',
    );
  await requirePumpRuntimePreview(preview, saved.review);
  const now = Date.now();
  const authorization: PumpGroupSigningAuthorization = {
    format: 'pump-group-signing-authorization-v1',
    id: crypto.randomUUID(),
    reviewId: id,
    previewId,
    contextSha256: saved.review.contextSha256,
    manifestSha256: saved.review.manifestSha256,
    simulationSha256: saved.review.simulationSha256,
    identitySha256: preview.identitySha256,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(
      Math.min(now + 5000, Date.parse(saved.review.expiresAt)),
    ).toISOString(),
    scope: 'sign-complete-group-only',
    signingAllowed: true,
    executionAllowed: false,
    submissionAllowed: false,
    semanticAuditEstablished: false,
  };
  signal.throwIfAborted();
  try {
    await db
      .prepare(
        'INSERT INTO pump_group_signing_authorizations(id,owner_id,review_id,preview_id,context_sha256,identity_sha256,consent,code_consent,authorization,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
      )
      .bind(
        authorization.id,
        owner,
        id,
        previewId,
        authorization.contextSha256,
        authorization.identitySha256,
        canonicalPumpHolderJson(consent),
        canonicalPumpHolderJson(codeConsent),
        canonicalPumpHolderJson(authorization),
        authorization.createdAt,
        authorization.expiresAt,
      )
      .run();
  } catch {
    return fail(
      'Group or runtime approval changed before signing authorization.',
    );
  }
  return { group: approved, preview, authorization };
}
