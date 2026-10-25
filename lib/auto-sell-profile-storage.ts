import {
  autoSellProfileId,
  autoSellProfileSha256,
  autoSellProfileTermsJson,
  readSavedAutoSellProfile,
  requireAutoSellProfileSummary,
  requireAutoSellProfileTerms,
  type AutoSellProfileSummary,
  type AutoSellProfileTerms,
  type SavedAutoSellProfile,
} from './auto-sell-profile';

const DOCUMENT_BYTES = 263168;
const PAGE_SIZE = 20;
const columns =
  'id,project_id,project_revision,profile_id,version,document,sha256,created_at';
type Row = {
  id: string;
  project_id: string;
  project_revision: number;
  profile_id: string;
  version: number;
  document: string;
  sha256: string;
  created_at: string;
};
export class AutoSellProfileStorageError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
function refused(message: string, status = 400): never {
  throw new AutoSellProfileStorageError(message, status);
}
function active(signal: AbortSignal) {
  if (signal.aborted)
    refused(
      'Auto Sell profile request cancelled. Reload saved profiles before retrying.',
      499,
    );
}
function scope(owner: string, projectId: unknown) {
  if (typeof owner !== 'string' || owner.length < 1 || owner.length > 128)
    refused('Choose an owned project.');
  try {
    autoSellProfileId(projectId);
  } catch {
    refused('Choose an owned project.');
  }
}
function id(value: unknown) {
  try {
    return autoSellProfileId(value);
  } catch {
    return refused('Choose a saved Auto Sell profile.');
  }
}
function failed(error: unknown, signal: AbortSignal): never {
  active(signal);
  if (error instanceof AutoSellProfileStorageError) throw error;
  refused(
    'Auto Sell profile storage unavailable. No session was started.',
    503,
  );
}
async function row(
  db: D1Database,
  owner: string,
  projectId: string,
  saveId: string,
  signal: AbortSignal,
) {
  active(signal);
  const result = await db
    .prepare(
      `SELECT ${columns} FROM auto_sell_profiles WHERE owner_id=? AND project_id=? AND id=?`,
    )
    .bind(owner, projectId, saveId)
    .first<Row>();
  active(signal);
  return result;
}
async function decode(value: Row, projectId: string, signal: AbortSignal) {
  active(signal);
  if (
    typeof value.document !== 'string' ||
    new TextEncoder().encode(value.document).byteLength > DOCUMENT_BYTES
  )
    throw Error('Stored profile exceeds capacity.');
  const saved = await readSavedAutoSellProfile(JSON.parse(value.document));
  if (
    saved.id !== value.id ||
    saved.profileId !== value.profile_id ||
    saved.version !== value.version ||
    saved.version > 1000 ||
    saved.createdAt !== value.created_at ||
    saved.sha256 !== value.sha256 ||
    saved.terms.projectId !== projectId ||
    value.project_id !== projectId ||
    saved.terms.projectRevision !== value.project_revision ||
    JSON.stringify(saved) !== value.document
  )
    throw Error('Stored Auto Sell profile differs.');
  active(signal);
  return saved;
}

/** Original owned configuration, independent of current project/wallet availability. */
export async function readAutoSellProfile(
  db: D1Database,
  owner: string,
  projectId: string,
  saveId: string,
  signal: AbortSignal,
): Promise<SavedAutoSellProfile> {
  try {
    scope(owner, projectId);
    id(saveId);
    const value = await row(db, owner, projectId, saveId, signal);
    if (!value) refused('Auto Sell profile unavailable.', 404);
    return await decode(value, projectId, signal);
  } catch (error) {
    return failed(error, signal);
  }
}

/** A bounded metadata index. Only an explicit exact GET verifies full terms. */
export async function listAutoSellProfiles(
  db: D1Database,
  owner: string,
  projectId: string,
  before: string | null,
  signal: AbortSignal,
): Promise<{ profiles: AutoSellProfileSummary[]; nextCursor: string | null }> {
  try {
    scope(owner, projectId);
    active(signal);
    let cursor: { id: string; created_at: string } | null = null;
    if (before !== null) {
      id(before);
      cursor = await db
        .prepare(
          'SELECT id,created_at FROM auto_sell_profiles WHERE owner_id=? AND project_id=? AND id=?',
        )
        .bind(owner, projectId, before)
        .first<{ id: string; created_at: string }>();
      active(signal);
      if (!cursor) refused('Auto Sell profile page unavailable.', 404);
      if (
        cursor.id !== before ||
        typeof cursor.created_at !== 'string' ||
        cursor.created_at.length !== 24 ||
        new Date(cursor.created_at).toISOString() !== cursor.created_at
      )
        throw Error('Profile page differs.');
    }
    const result = await db
      .prepare(`SELECT id, profile_id AS profileId, version, project_revision AS projectRevision, created_at AS createdAt, sha256,
      json_extract(document,'$.terms.name') AS name,
      json_extract(document,'$.terms.token.chain') AS tokenChain,
      json_extract(document,'$.terms.token.mint') AS tokenMint,
      json_extract(document,'$.terms.token.decimals') AS tokenDecimals,
      json_extract(document,'$.terms.token.totalSupplyRaw') AS tokenSupply,
      json_array_length(document,'$.terms.wallets') AS walletCount,
      json_array_length(document,'$.terms.configuration.strategies') AS strategyCount,
      json_extract(document,'$.id') AS documentId, json_extract(document,'$.profileId') AS documentProfileId,
      json_extract(document,'$.version') AS documentVersion, json_extract(document,'$.createdAt') AS documentCreatedAt,
      json_extract(document,'$.sha256') AS documentSha256,
      json_extract(document,'$.terms.projectId') AS documentProjectId,
      json_extract(document,'$.terms.projectRevision') AS documentProjectRevision,
      json_extract(document,'$.format') AS format,
      json_type(document,'$.signingAllowed') AS signing,
      json_type(document,'$.executionAllowed') AS execution,
      json_type(document,'$.automaticResumeAllowed') AS automaticResume
      FROM auto_sell_profiles WHERE owner_id=? AND project_id=?${cursor ? ' AND (created_at<? OR (created_at=? AND id<?))' : ''}
      ORDER BY created_at DESC,id DESC LIMIT 21`)
      .bind(
        owner,
        projectId,
        ...(cursor ? [cursor.created_at, cursor.created_at, cursor.id] : []),
      )
      .all<Record<string, unknown>>();
    active(signal);
    if (
      !result.success ||
      !Array.isArray(result.results) ||
      result.results.length > PAGE_SIZE + 1
    )
      throw Error('Profile page unavailable.');
    const seen = new Set<string>();
    const profiles = result.results.map((value) => {
      if (
        value.id !== value.documentId ||
        value.profileId !== value.documentProfileId ||
        value.version !== value.documentVersion ||
        value.createdAt !== value.documentCreatedAt ||
        value.sha256 !== value.documentSha256 ||
        value.documentProjectId !== projectId ||
        value.projectRevision !== value.documentProjectRevision ||
        value.format !== 'auto-sell-profile-v1' ||
        value.signing !== 'false' ||
        value.execution !== 'false' ||
        value.automaticResume !== 'false'
      )
        throw Error('Profile index context differs.');
      const summary = requireAutoSellProfileSummary({
        id: value.id,
        profileId: value.profileId,
        version: value.version,
        name: value.name,
        projectRevision: value.projectRevision,
        createdAt: value.createdAt,
        sha256: value.sha256,
        token: {
          chain: value.tokenChain,
          mint: value.tokenMint,
          decimals: value.tokenDecimals,
          totalSupplyRaw: value.tokenSupply,
        },
        walletCount: value.walletCount,
        strategyCount: value.strategyCount,
      });
      if (summary.version > 1000 || seen.has(summary.id))
        throw Error('Profile index differs.');
      seen.add(summary.id);
      return summary;
    });
    return {
      profiles: profiles.slice(0, PAGE_SIZE),
      nextCursor:
        profiles.length > PAGE_SIZE ? profiles[PAGE_SIZE - 1].id : null,
    };
  } catch (error) {
    return failed(error, signal);
  }
}

export type AutoSellProfileSaveInput = {
  id: string;
  profileId: string;
  expectedVersion: number;
  terms: AutoSellProfileTerms;
};
function request(value: AutoSellProfileSaveInput) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    refused('Review exact Auto Sell profile save fields.');
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== 4 ||
    keys.some(
      (key) =>
        typeof key !== 'string' ||
        !['id', 'profileId', 'expectedVersion', 'terms'].includes(key),
    )
  )
    refused('Review exact Auto Sell profile save fields.');
  for (const key of Reflect.ownKeys(value)) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !d?.enumerable || !Object.hasOwn(d, 'value'))
      refused('Review exact Auto Sell profile save fields.');
  }
  id(value.id);
  id(value.profileId);
  if (
    !Number.isSafeInteger(value.expectedVersion) ||
    value.expectedVersion < 0 ||
    value.expectedVersion >= 1000
  )
    refused('Choose the current Auto Sell profile version.');
  let terms: AutoSellProfileTerms;
  try {
    terms = requireAutoSellProfileTerms(value.terms);
  } catch {
    return refused('Review exact Auto Sell profile terms.');
  }
  return { ...value, terms };
}

export async function saveAutoSellProfile(
  db: D1Database,
  owner: string,
  input: AutoSellProfileSaveInput,
  signal: AbortSignal,
): Promise<SavedAutoSellProfile> {
  try {
    active(signal);
    const admitted = request(input),
      terms = admitted.terms;
    scope(owner, terms.projectId);
    const termsText = autoSellProfileTermsJson(terms),
      sha256 = await autoSellProfileSha256(termsText),
      version = admitted.expectedVersion + 1;
    active(signal);
    const matching = async (existing: Row) => {
      const saved = await decode(existing, terms.projectId, signal);
      if (
        saved.profileId !== admitted.profileId ||
        saved.version !== version ||
        saved.sha256 !== sha256 ||
        autoSellProfileTermsJson(saved.terms) !== termsText
      )
        refused('This save ID already has different profile terms.', 409);
      return saved;
    };
    const existing = await row(db, owner, terms.projectId, admitted.id, signal);
    if (existing) return await matching(existing);
    const p = await db
      .prepare(
        'SELECT revision,archived,chain,address,document FROM imported_token_projects WHERE owner_id=? AND id=?',
      )
      .bind(owner, terms.projectId)
      .first<{
        revision: number;
        archived: number;
        chain: string;
        address: string;
        document: string;
      }>();
    active(signal);
    if (!p) refused('Owned token project unavailable.', 404);
    const source = JSON.parse(p.document) as {
      token?: {
        chain?: unknown;
        address?: unknown;
        decimals?: unknown;
        totalSupplyRaw?: unknown;
      };
    };
    if (
      p.archived !== 0 ||
      p.revision !== terms.projectRevision ||
      p.chain !== 'Solana' ||
      p.address !== terms.token.mint ||
      source.token?.chain !== 'Solana' ||
      source.token.address !== terms.token.mint ||
      source.token.decimals !== terms.token.decimals ||
      source.token.totalSupplyRaw !== terms.token.totalSupplyRaw
    )
      refused('Project changed. Reload it before saving this profile.', 409);
    const roster = JSON.stringify(terms.wallets);
    const wallets = await db
      .prepare(
        "SELECT address,revision,archived FROM workspace_wallets WHERE owner_id=? AND chain='Solana' AND address IN (SELECT json_extract(value,'$.address') FROM json_each(?))",
      )
      .bind(owner, roster)
      .all<{ address: string; revision: number; archived: number }>();
    active(signal);
    if (!wallets.success || !Array.isArray(wallets.results))
      throw Error('Wallet read unavailable.');
    if (
      wallets.results.length !== terms.wallets.length ||
      terms.wallets.some(
        (w) =>
          !wallets.results.some(
            (current) =>
              current.address === w.address &&
              current.revision === w.revision &&
              current.archived === 0,
          ),
      )
    )
      refused(
        'Selected wallets changed. Reload them before saving this profile.',
        409,
      );
    const saved: SavedAutoSellProfile = {
      format: 'auto-sell-profile-v1',
      id: admitted.id,
      profileId: admitted.profileId,
      version,
      createdAt: new Date().toISOString(),
      sha256,
      terms,
      signingAllowed: false,
      executionAllowed: false,
      automaticResumeAllowed: false,
    };
    const document = JSON.stringify(saved);
    if (new TextEncoder().encode(document).byteLength > DOCUMENT_BYTES)
      refused('Auto Sell profile exceeds storage capacity.');
    active(signal);
    try {
      await db
        .prepare(`INSERT INTO auto_sell_profiles(id,owner_id,project_id,project_revision,profile_id,version,document,sha256,created_at)
        SELECT ?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM imported_token_projects WHERE owner_id=? AND id=? AND revision=? AND archived=0 AND chain='Solana' AND address=? AND document=?)
        AND NOT EXISTS(SELECT 1 FROM json_each(?) j WHERE NOT EXISTS(SELECT 1 FROM workspace_wallets WHERE owner_id=? AND chain='Solana' AND archived=0 AND address=json_extract(j.value,'$.address') AND revision=json_extract(j.value,'$.revision')))
        AND (SELECT COALESCE(MAX(version),0) FROM auto_sell_profiles WHERE owner_id=? AND project_id=? AND profile_id=?)=?`)
        .bind(
          admitted.id,
          owner,
          terms.projectId,
          terms.projectRevision,
          admitted.profileId,
          version,
          document,
          sha256,
          saved.createdAt,
          owner,
          terms.projectId,
          terms.projectRevision,
          terms.token.mint,
          p.document,
          roster,
          owner,
          owner,
          terms.projectId,
          admitted.profileId,
          admitted.expectedVersion,
        )
        .run();
    } catch {
      /* Re-read the exact request ID, including after concurrent insertion. */
    }
    active(signal);
    const result = await row(db, owner, terms.projectId, admitted.id, signal);
    if (!result)
      refused(
        'Project or wallets changed, version advanced or profile storage is full. Reload profiles before retrying the same save.',
        409,
      );
    return await matching(result);
  } catch (error) {
    return failed(error, signal);
  }
}
