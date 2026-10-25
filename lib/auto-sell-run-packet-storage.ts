import {
  AutoSellRunStorageError,
  readOwnedAutoSellAttempts,
  requireAutoSellRunPreparationGuard,
  autoSellPreparationWriteGuard,
  type AutoSellRunPreparationGuard,
} from './auto-sell-run-storage';
import { autoSellRunId } from './auto-sell-run';
import {
  readAutoSellRunPacketSummary,
  autoSellRunSummarySha256,
  validateAutoSellRunPacket,
} from './auto-sell-run-packet';
import { warmupProposalSqlTokens } from './wallet-warmup-execution-proposal-schema';
import type {
  SavedSwapPreparation,
  SwapPreparationSummary,
} from './imported-swap-preparation-history';

const authority = {
  signingAllowed: false,
  executionAllowed: false,
  automaticResumeAllowed: false,
} as const;
const schema: Readonly<Record<string, string>> = {
  auto_sell_run_attempts:
    '571620d9cf8d4a2335520e544cbeabb003ea41d0b5b6f6bf72ea4ab2a1e1d6ac',
  auto_sell_run_attempts_no_delete:
    'c08b722da4a06038c648dbb12cc63dd8ef9bfe511384b637c32f924f362292af',
  auto_sell_run_attempts_no_update:
    'aab9be72a2fa16e3668f56e842729a9239bd7f8a0f4cc18bc2d529813163ea9f',
  auto_sell_run_current_sources:
    '3f0bc6baed9fe4197a457032a9bd122a43b823fc9475b180cd5c21ae25f1a981',
  auto_sell_run_heads:
    '3636acdbd92a1477c01dad3ce8268cedc391cea8290d0f40fae308471264b5c2',
  auto_sell_run_heads_update:
    'e6dd13c04aa32d25e423934604063ef02a4f7c8e0d358913e2f1097295561c0e',
  auto_sell_run_packets:
    '245959d1fc6b19ee1d8d6df053aef8e9154512cf67296d890cdd66606ed7fb48',
  auto_sell_run_packets_insert:
    '7e7be0d23cf52c5f6bba4a1804dc7caa8f66f62bcf9f1b41733a66cf3c42da4a',
  auto_sell_run_packets_no_delete:
    '48be11623086b99a05912fed58a74d7b054d1867fa2a7e10ec1c0c8dfde1685b',
  auto_sell_run_packets_no_update:
    'fb91ebdba3b864636c237aaf5c35c408d764595dd0cea0af17f82804591c58fb',
  auto_sell_run_preparation_starts:
    'b59fd6d203ac75196258c9fa020b450489821f65fbf7fb2d25624906116a9584',
  auto_sell_run_preparation_starts_insert:
    '856d516686cc55bfb508dfefc12afe780293dccefb567cfb49d40891a8ff3bd2',
  auto_sell_run_preparation_starts_no_delete:
    '71ecdb6bda5358b13265b640de70c80df39dbaff9a87a72ee0552ed3bf6aeb17',
  auto_sell_run_preparation_starts_no_update:
    'cf9c90eb84e475af9931441d7a922a4deae95f25a4c593afc7f61ed600c1cb3e',
  auto_sell_run_preparations_insert:
    'a51dc9199b0ca5a95f86102ebef0ce40c30aab5071f8685b5c03581ede91ce20',
  auto_sell_run_preparations_no_delete:
    'b2f43052123fdf61e713725b98bf65f4aab3a0b480d124f5711adaa0ec1ebc44',
  auto_sell_run_preparations_no_update:
    'd2c7b881834359fac67309bfcb7fdd44c08342c3080a1ceb236a2a00474596e8',
  auto_sell_run_signing_disabled:
    '45b286364cfeffa362fb04820a2ef0460749407bb7c51dfca552dd62704400c3',
  auto_sell_run_signing_update_disabled:
    '0987e4db7b94732be981986163f611302989c4ed4819a3877923e3b523f5ddaa',
  auto_sell_run_stops:
    'fca3fbfa0e9c8b2df8817b4c13366f9dbc279da5150884401952840be46c3676',
  auto_sell_run_stops_insert:
    'e3224b2caa173ecfd79a62cadd08393481664ad79d81fac8f5a8a533ac024889',
  auto_sell_run_stops_no_delete:
    'fccf84d65a154c5f56ecaf31e6ad039b6475d0b87faa1b303fe2a7648519d423',
  auto_sell_run_stops_no_update:
    '2b1f36161fb039ec1b823b7d1c2fe7f80028246ea5105f9d6ce4d8db1610b03b',
  auto_sell_runs:
    '1bc6437266177c5b64d75f773b197865432750034d0470b969201e306b43a316',
  auto_sell_runs_no_delete:
    'e1326e1295a0f2536edb8ba41a175d21dc6ad497b09a76e2ffac3a42aea6d22d',
  auto_sell_runs_no_update:
    'd6581dbbcf575b80074b138f0da0878407f4cf807c64d6f9231315392532444f',
};
function fail(message: string, status = 503): never {
  throw new AutoSellRunStorageError(message, status);
}
function active(signal: AbortSignal) {
  if (signal.aborted)
    fail(
      'Saved packet waiting cancelled. Keep the original run and attempt IDs.',
      499,
    );
}
function ownerScope(owner: string) {
  if (typeof owner !== 'string' || owner.length < 1 || owner.length > 128)
    fail('Choose the original signed-in account.', 400);
}
async function digest(text: string) {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)),
    ),
    (b) => b.toString(16).padStart(2, '0'),
  ).join('');
}
async function sqlNow(db: D1Database) {
  const r = await db
    .prepare("SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS now")
    .first<{ now: string }>();
  if (!r) throw Error('Missing packet clock');
  return r.now;
}
function timestamp(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length !== 24 ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    throw Error('Invalid packet timestamp');
  return value;
}
/** No cache: missing or changed publication/no-signing guards refuse before RPC. */
export async function autoSellRunPacketWriteReady(
  db: D1Database,
  signal: AbortSignal = new AbortController().signal,
) {
  active(signal);
  try {
    const fk = await db
      .prepare('PRAGMA foreign_keys')
      .first<{ foreign_keys: number }>();
    if (fk?.foreign_keys !== 1)
      throw Error('Foreign-key enforcement unavailable');
    const names = Object.keys(schema);
    if (!names.length) throw Error('Missing packet schema fingerprints');
    const rows = await db
      .prepare(
        `SELECT name,sql FROM sqlite_master WHERE name IN (${names.map(() => '?').join(',')})`,
      )
      .bind(...names)
      .all<{ name: string; sql: string }>();
    active(signal);
    if (
      !rows.success ||
      !Array.isArray(rows.results) ||
      rows.results.length !== names.length ||
      new Set(rows.results.map((r) => r.name)).size !== names.length
    )
      throw Error('Packet schema incomplete');
    for (const row of rows.results) {
      active(signal);
      if (
        typeof row.sql !== 'string' ||
        !Object.hasOwn(schema, row.name) ||
        (await digest(warmupProposalSqlTokens(row.sql))) !== schema[row.name]
      )
        throw Error('Packet schema changed');
    }
    active(signal);
  } catch (error) {
    active(signal);
    if (error instanceof AutoSellRunStorageError) throw error;
    fail(
      'Auto Sell packet storage is not ready. No new provider work or signing is permitted.',
    );
  }
}
export type AutoSellRunPacket = {
  format: 'auto-sell-run-packet-v1';
  runId: string;
  attemptId: string;
  preparationId: string;
  runSha256: string;
  attemptSha256: string;
  projectId: string;
  projectRevision: number;
  wallet: string;
  walletRevision: number;
  packetSha256: string;
  summarySha256: string;
  transaction: string;
  packetBytes: number;
  createdAt: string;
  sha256: string;
} & typeof authority;
type PacketRow = {
  owner_id: string;
  run_id: string;
  attempt_id: string;
  preparation_id: string;
  run_sha256: string;
  attempt_sha256: string;
  project_id: string;
  project_revision: number;
  wallet: string;
  wallet_revision: number;
  packet_sha256: string;
  summary_sha256: string;
  summary_document: string;
  transaction_text: string;
  packet_bytes: number;
  document: string;
  sha256: string;
  created_at: string;
};
async function packetRecord(
  row: PacketRow,
  summary: SwapPreparationSummary,
): Promise<AutoSellRunPacket> {
  const body = {
    format: 'auto-sell-run-packet-v1' as const,
    runId: autoSellRunId(row.run_id),
    attemptId: autoSellRunId(row.attempt_id),
    preparationId: autoSellRunId(row.preparation_id),
    runSha256: row.run_sha256,
    attemptSha256: row.attempt_sha256,
    projectId: autoSellRunId(row.project_id),
    projectRevision: row.project_revision,
    wallet: row.wallet,
    walletRevision: row.wallet_revision,
    packetSha256: row.packet_sha256,
    summarySha256: row.summary_sha256,
    transaction: row.transaction_text,
    packetBytes: row.packet_bytes,
    createdAt: timestamp(row.created_at),
    ...authority,
  };
  const text = row.document,
    rawSummary = row.summary_document,
    storedHash = row.sha256;
  if (
    ![
      body.runSha256,
      body.attemptSha256,
      body.packetSha256,
      body.summarySha256,
      storedHash,
    ].every((v) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v)) ||
    !Number.isSafeInteger(body.projectRevision) ||
    body.projectRevision < 1 ||
    body.projectRevision > 1e9 ||
    !Number.isSafeInteger(body.walletRevision) ||
    body.walletRevision < 1 ||
    body.walletRevision > 1e9 ||
    !Number.isSafeInteger(body.packetBytes) ||
    body.packetBytes < 1 ||
    body.packetBytes > 1232
  )
    throw Error('Invalid original packet metadata');
  const packet = await validateAutoSellRunPacket(body.transaction, summary);
  if (
    packet.sha256 !== body.packetSha256 ||
    summary.transaction.bytes !== body.packetBytes ||
    (await autoSellRunSummarySha256(rawSummary)) !== body.summarySha256
  )
    throw Error('Original packet bytes or summary differ');
  const sha256 = await digest(
    JSON.stringify(['auto-sell-run-packet-v1', body]),
  );
  const result = { ...body, sha256 };
  if (storedHash !== sha256 || JSON.stringify(result) !== text)
    throw Error('Original packet record differs');
  return result;
}
/** The only write interface returns a one-shot atomic composition with the
 * caller's unchanged original preparation statement. It accepts no HTTP body. */
export async function prepareAutoSellRunPacketWrite(
  db: D1Database,
  preparationStatement: D1PreparedStatement,
  owner: string,
  id: string,
  summaryText: string,
  transaction: unknown,
  summary: SwapPreparationSummary,
  guard: AutoSellRunPreparationGuard,
): Promise<() => Promise<D1Result>> {
  ownerScope(owner);
  autoSellRunId(id);
  requireAutoSellRunPreparationGuard(guard);
  if (owner !== guard.owner || id !== guard.preparationId)
    fail('The original packet owner or preparation ID differs.', 409);
  const rawSummary = summaryText;
  let captured: SwapPreparationSummary;
  try {
    if (typeof rawSummary !== 'string') throw Error('Original summary missing');
    captured = readAutoSellRunPacketSummary(JSON.parse(rawSummary));
    const supplied = readAutoSellRunPacketSummary(summary);
    if (
      JSON.stringify(captured) !== rawSummary ||
      JSON.stringify(supplied) !== rawSummary
    )
      throw Error('Original summary bytes differ');
    autoSellPreparationWriteGuard(
      owner,
      guard,
      {
        projectId: guard.projectId,
        projectRevision: guard.projectRevision,
        wallet: guard.wallet,
        walletRevision: guard.walletRevision,
      },
      captured,
    );
  } catch {
    fail('The exact original unsigned packet and summary are required.', 409);
  }
  await autoSellRunPacketWriteReady(db);
  const existing = await db
    .prepare(
      'SELECT id FROM imported_swap_preparations WHERE id=? UNION ALL SELECT preparation_id AS id FROM auto_sell_run_packets WHERE preparation_id=? LIMIT 1',
    )
    .bind(id, id)
    .first();
  if (existing)
    fail(
      'The original preparation already exists. Read its retained status; do not attach new packet bytes.',
      409,
    );
  let checked: Awaited<ReturnType<typeof validateAutoSellRunPacket>>,
    summarySha256: string;
  try {
    summarySha256 = await autoSellRunSummarySha256(rawSummary);
    checked = await validateAutoSellRunPacket(transaction, captured);
  } catch {
    fail('Unsigned packet bytes do not match the original summary.', 409);
  }
  const createdAt = timestamp(await sqlNow(db));
  const body = {
    format: 'auto-sell-run-packet-v1' as const,
    runId: guard.runId,
    attemptId: guard.attemptId,
    preparationId: id,
    runSha256: guard.runSha256,
    attemptSha256: guard.attemptSha256,
    projectId: guard.projectId,
    projectRevision: guard.projectRevision,
    wallet: guard.wallet,
    walletRevision: guard.walletRevision,
    packetSha256: checked.sha256,
    summarySha256,
    transaction: checked.transaction,
    packetBytes: captured.transaction.bytes,
    createdAt,
    ...authority,
  };
  const sha256 = await digest(
      JSON.stringify(['auto-sell-run-packet-v1', body]),
    ),
    record = { ...body, sha256 };
  if (new TextEncoder().encode(JSON.stringify(record)).byteLength > 8192)
    fail('Original packet record exceeds retention capacity.', 409);
  const packetStatement = db
    .prepare(
      'INSERT INTO auto_sell_run_packets(owner_id,run_id,attempt_id,preparation_id,run_sha256,attempt_sha256,project_id,project_revision,wallet,wallet_revision,packet_sha256,summary_sha256,summary_document,transaction_text,packet_bytes,document,sha256,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    )
    .bind(
      owner,
      guard.runId,
      guard.attemptId,
      id,
      guard.runSha256,
      guard.attemptSha256,
      guard.projectId,
      guard.projectRevision,
      guard.wallet,
      guard.walletRevision,
      checked.sha256,
      summarySha256,
      rawSummary,
      checked.transaction,
      captured.transaction.bytes,
      JSON.stringify(record),
      sha256,
      createdAt,
    );
  let dispatched = false;
  return async () => {
    if (dispatched)
      fail(
        'This packet write was already dispatched. Read the original retained result.',
        409,
      );
    dispatched = true;
    await autoSellRunPacketWriteReady(db);
    const results = await db.batch([preparationStatement, packetStatement]);
    if (
      results.length !== 2 ||
      results.some((r) => !r.success || r.meta.changes !== 1)
    )
      fail(
        'The original packet write could not be confirmed. Keep its original IDs.',
      );
    return results[0];
  };
}
export type AutoSellRunPacketRecovery = {
  format: 'auto-sell-run-packet-recovery-v1';
  status:
    | 'retained'
    | 'summary-only'
    | 'started-without-result'
    | 'not-started';
  runId: string;
  attemptId: string;
  preparationId: string;
  summary: SavedSwapPreparation | null;
  packet: AutoSellRunPacket | null;
} & typeof authority;
/** Historical owned evidence only. No expiry renewal, fresh provider read,
 * signing authorization, retry, settlement or allowance release occurs. */
export async function readOwnedAutoSellRunPacket(
  db: D1Database,
  owner: string,
  runId: string,
  attemptId: string,
  signal: AbortSignal,
): Promise<AutoSellRunPacketRecovery> {
  active(signal);
  ownerScope(owner);
  autoSellRunId(runId);
  autoSellRunId(attemptId);
  try {
    await autoSellRunPacketWriteReady(db, signal);
    const history = await readOwnedAutoSellAttempts(db, owner, runId, signal),
      attempt = history.attempts.find((a) => a.id === attemptId);
    if (!attempt) fail('Owned Auto Sell attempt unavailable.', 404);
    const row = await db
      .prepare(`SELECT k.*,p.id AS original_preparation_id,p.project_id AS original_project_id,p.project_revision AS original_project_revision,p.wallet_revision AS original_wallet_revision,p.wallet_address AS original_wallet,p.document AS original_document,p.created_at AS original_created_at,s.attempt_id AS started_attempt_id,s.preparation_id AS started_preparation_id
      FROM auto_sell_run_attempts a LEFT JOIN imported_swap_preparations p ON p.owner_id=a.owner_id AND p.id=a.preparation_id
      LEFT JOIN auto_sell_run_packets k ON k.owner_id=a.owner_id AND k.attempt_id=a.id
      LEFT JOIN auto_sell_run_preparation_starts s ON s.owner_id=a.owner_id AND s.attempt_id=a.id
      WHERE a.owner_id=? AND a.run_id=? AND a.id=?`)
      .bind(owner, runId, attemptId)
      .first<
        PacketRow & {
          original_preparation_id: string | null;
          original_project_id: string;
          original_project_revision: number;
          original_wallet_revision: number;
          original_wallet: string;
          original_document: string;
          original_created_at: string;
          started_attempt_id: string | null;
          started_preparation_id: string | null;
        }
      >();
    active(signal);
    if (!row) throw Error('Original journal snapshot missing');
    const started = row.started_attempt_id !== null;
    if (
      started &&
      (row.started_attempt_id !== attemptId ||
        row.started_preparation_id !== attempt.preparationId)
    )
      throw Error('Original start differs');
    const base = {
      format: 'auto-sell-run-packet-recovery-v1' as const,
      runId,
      attemptId,
      preparationId: attempt.preparationId,
      ...authority,
    };
    if (row.original_preparation_id === null) {
      if (row.attempt_id !== null)
        throw Error('Packet has no original preparation');
      return {
        ...base,
        status: started ? 'started-without-result' : 'not-started',
        summary: null,
        packet: null,
      };
    }
    if (
      !started ||
      row.original_preparation_id !== attempt.preparationId ||
      row.original_project_id !== history.run.profile.terms.projectId ||
      row.original_project_revision !==
        history.run.profile.terms.projectRevision ||
      row.original_wallet_revision !== attempt.walletRevision ||
      row.original_wallet !== attempt.wallet
    )
      throw Error('Original preparation context differs');
    const rawSummary = row.original_document;
    const summaryHash = await autoSellRunSummarySha256(rawSummary),
      document = readAutoSellRunPacketSummary(JSON.parse(rawSummary));
    if (
      document.wallet !== attempt.wallet ||
      document.inAmountRaw !== attempt.inputRaw ||
      document.inputMint !== history.run.profile.terms.token.mint ||
      document.slippageBps >
        (history.run.profile.terms.configuration.session.maxSlippageBps ?? 50)
    )
      throw Error('Original summary differs');
    const summary: SavedSwapPreparation = {
      id: attempt.preparationId,
      projectId: row.original_project_id,
      projectRevision: row.original_project_revision,
      walletRevision: row.original_wallet_revision,
      createdAt: timestamp(row.original_created_at),
      document,
    };
    if (row.attempt_id === null) {
      active(signal);
      return { ...base, status: 'summary-only', summary, packet: null };
    }
    if (
      row.owner_id !== owner ||
      row.run_id !== runId ||
      row.attempt_id !== attemptId ||
      row.preparation_id !== attempt.preparationId ||
      row.run_sha256 !== history.run.sha256 ||
      row.attempt_sha256 !== attempt.sha256 ||
      row.project_id !== summary.projectId ||
      row.project_revision !== summary.projectRevision ||
      row.wallet !== attempt.wallet ||
      row.wallet_revision !== attempt.walletRevision ||
      row.summary_document !== rawSummary ||
      row.summary_sha256 !== summaryHash
    )
      throw Error('Original packet association differs');
    const packet = await packetRecord({ ...row }, document);
    active(signal);
    return { ...base, status: 'retained', summary, packet };
  } catch (error) {
    active(signal);
    if (error instanceof AutoSellRunStorageError) throw error;
    return fail(
      'Original Auto Sell packet evidence is unavailable or differs. Keep its original IDs; no new preparation or signing is authorized.',
    );
  }
}
