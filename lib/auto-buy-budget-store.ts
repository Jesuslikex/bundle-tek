import {
  AUTO_BUY_BUDGET_AUTHORITY,
  AUTO_BUY_BUDGET_SOL,
  AutoBuyBudgetError,
  autoBuyBudgetTerms,
  autoBuyBudgetClaim,
  type AutoBuyBudgetTerms,
  type AutoBuyBudgetClaim,
} from './auto-buy-budget';
const now = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
type SessionRow = {
  owner_id: string;
  id: string;
  project_id: string;
  project_revision: number;
  document: string;
  document_sha256: string;
  maximum_input_lamports: number;
  maximum_fee_and_rent_lamports: number;
  state: 'open' | 'paused' | 'stopped';
  revision: number;
  expires_at: string;
  created_at: string;
  updated_at: string;
};
type ClaimRow = {
  owner_id: string;
  id: string;
  session_id: string;
  document: string;
  document_sha256: string;
  state: 'held' | 'uncertain' | 'released';
  created_at: string;
  updated_at: string;
  strategy_id: string;
  wallet: string;
  wallet_revision: number;
  candidate_key: string;
  kind: string;
  source_sha256: string;
  packet_sha256: string;
  minimum_output_token_raw: string;
  maximum_input_lamports: number;
  maximum_fee_and_rent_lamports: number;
  expires_at: string;
};
const guards = [
  'auto_buy_budgets',
  'auto_buy_budget_id',
  'auto_buy_budget_claims',
  'auto_buy_budget_claim_id',
  'auto_buy_budget_claim_scope',
  'auto_buy_budget_active_candidate',
  'auto_buy_budget_active_packet',
  'auto_buy_budget_counter_source',
  'auto_buy_budget_packet_history',
  'auto_buy_budget_insert',
  'auto_buy_budget_claim_insert',
  'auto_buy_budgets_update',
  'auto_buy_budgets_delete',
  'auto_buy_budget_claims_update',
  'auto_buy_budget_claims_delete',
  ...['imported_swap_signing_intents', 'warmup_signing_intents'].flatMap(
    (t) => [
      t + '_auto_buy_budget_isolation',
      t + '_auto_buy_budget_update_isolation',
      t + '_auto_buy_budget_delete_isolation',
    ],
  ),
];
async function installed(db: D1Database) {
  const row = await query(() =>
    db
      .prepare(
        `SELECT count(*) AS n FROM sqlite_master WHERE name IN (${guards.map(() => '?').join(',')})`,
      )
      .bind(...guards)
      .first<{ n: number }>(),
  );
  if (row?.n !== guards.length) unavailable();
}
async function digest(value: string) {
  return [
    ...new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)),
    ),
  ]
    .map((n) => n.toString(16).padStart(2, '0'))
    .join('');
}
const unavailable = (): never => {
  throw new AutoBuyBudgetError(
    'Saved Auto Buy budget accounting is unavailable. Recover its original ID.',
    503,
  );
};
async function query<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch {
    return unavailable();
  }
}
function authority(v: Record<string, unknown>) {
  for (const name of Object.keys(AUTO_BUY_BUDGET_AUTHORITY))
    if (v[name] !== false) unavailable();
}
async function document(
  row: { document: string; document_sha256: string },
  format: string,
) {
  try {
    if (
      new TextEncoder().encode(row.document).length > 65536 ||
      (await digest(row.document)) !== row.document_sha256
    )
      return unavailable();
    const v = JSON.parse(row.document) as Record<string, unknown>;
    if (!v || typeof v !== 'object' || Array.isArray(v) || v.format !== format)
      return unavailable();
    authority(v);
    if (v.inputMint !== AUTO_BUY_BUDGET_SOL) return unavailable();
    return v;
  } catch {
    return unavailable();
  }
}
async function session(db: D1Database, owner: string, id: string) {
  return query(() =>
    db
      .prepare('SELECT * FROM auto_buy_budgets WHERE owner_id=? AND id=?')
      .bind(owner, id)
      .first<SessionRow>(),
  );
}
async function claim(db: D1Database, owner: string, id: string) {
  return query(() =>
    db
      .prepare('SELECT * FROM auto_buy_budget_claims WHERE owner_id=? AND id=?')
      .bind(owner, id)
      .first<ClaimRow>(),
  );
}
async function terms(row: SessionRow) {
  const doc = await document(row, 'auto-buy-budget-v1');
  let value: AutoBuyBudgetTerms;
  try {
    value = autoBuyBudgetTerms(doc.terms);
  } catch {
    return unavailable();
  }
  if (
    value.id !== row.id ||
    value.projectId !== row.project_id ||
    value.projectRevision !== row.project_revision ||
    value.expiresAt !== row.expires_at ||
    value.maximumInputLamports !== String(row.maximum_input_lamports) ||
    value.maximumFeeAndRentLamports !==
      String(row.maximum_fee_and_rent_lamports) ||
    !['open', 'paused', 'stopped'].includes(row.state) ||
    !Number.isSafeInteger(row.revision) ||
    row.revision < 0
  )
    return unavailable();
  return value;
}
/** One SQL snapshot. These totals are not a balance or permission to trade. */
export async function readAutoBuyBudget(
  db: D1Database,
  owner: string,
  id: string,
) {
  const row = await query(() =>
    db
      .prepare(`SELECT b.*,
    COALESCE((SELECT SUM(c.maximum_input_lamports) FROM auto_buy_budget_claims c WHERE c.owner_id=b.owner_id AND c.session_id=b.id AND c.state!='released'),0) AS input_held,
    COALESCE((SELECT SUM(c.maximum_fee_and_rent_lamports) FROM auto_buy_budget_claims c WHERE c.owner_id=b.owner_id AND c.session_id=b.id AND c.state!='released'),0) AS fee_held,
    (SELECT count(*) FROM auto_buy_budget_claims c WHERE c.owner_id=b.owner_id AND c.session_id=b.id AND c.state='uncertain') AS uncertain
    FROM auto_buy_budgets b WHERE b.owner_id=? AND b.id=?`)
      .bind(owner, id)
      .first<
        SessionRow & { input_held: number; fee_held: number; uncertain: number }
      >(),
  );
  if (!row) return null;
  if (row.owner_id !== owner || row.id !== id) return unavailable();
  const input = await terms(row);
  if (
    ![row.input_held, row.fee_held, row.uncertain].every(
      (n) => Number.isSafeInteger(n) && n >= 0,
    ) ||
    row.input_held > row.maximum_input_lamports ||
    row.fee_held > row.maximum_fee_and_rent_lamports
  )
    return unavailable();
  return {
    terms: input,
    inputMint: AUTO_BUY_BUDGET_SOL,
    state: row.state,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    heldInputLamports: String(row.input_held),
    heldFeeAndRentLamports: String(row.fee_held),
    remainingInputLamports: (
      BigInt(input.maximumInputLamports) - BigInt(row.input_held)
    ).toString(),
    remainingFeeAndRentLamports: (
      BigInt(input.maximumFeeAndRentLamports) - BigInt(row.fee_held)
    ).toString(),
    uncertainClaims: row.uncertain,
    ...AUTO_BUY_BUDGET_AUTHORITY,
  };
}
export async function retainAutoBuyBudget(
  db: D1Database,
  owner: string,
  value: unknown,
) {
  const input = autoBuyBudgetTerms(value);
  await installed(db);
  const existing = await session(db, owner, input.id);
  if (existing) {
    if (JSON.stringify(await terms(existing)) !== JSON.stringify(input))
      throw new AutoBuyBudgetError(
        'Original budget terms differ. Recover the saved ledger.',
      );
    return (await readAutoBuyBudget(db, owner, input.id))!;
  }
  const parent = await query(() =>
    db
      .prepare(
        'SELECT document FROM imported_token_projects WHERE owner_id=? AND id=? AND revision=? AND archived=0',
      )
      .bind(owner, input.projectId, input.projectRevision)
      .first<{ document: string }>(),
  );
  if (!parent)
    throw new AutoBuyBudgetError('Current owned project is unavailable.');
  const text = JSON.stringify({
    format: 'auto-buy-budget-v1',
    inputMint: AUTO_BUY_BUDGET_SOL,
    terms: input,
    projectDocument: parent.document,
    ...AUTO_BUY_BUDGET_AUTHORITY,
  });
  if (new TextEncoder().encode(text).length > 65536)
    throw new AutoBuyBudgetError('Budget context is too large.', 400);
  const sha = await digest(text);
  try {
    await db
      .prepare(
        'INSERT INTO auto_buy_budgets(owner_id,id,project_id,project_revision,document,document_sha256,maximum_input_lamports,maximum_fee_and_rent_lamports,expires_at) VALUES(?,?,?,?,?,?,?,?,?)',
      )
      .bind(
        owner,
        input.id,
        input.projectId,
        input.projectRevision,
        text,
        sha,
        Number(input.maximumInputLamports),
        Number(input.maximumFeeAndRentLamports),
        input.expiresAt,
      )
      .run();
  } catch {
    const saved = await session(db, owner, input.id);
    if (!saved || JSON.stringify(await terms(saved)) !== JSON.stringify(input))
      throw new AutoBuyBudgetError(
        'Budget context changed or storage refused the request. Recover its ID before retrying.',
      );
  }
  return (await readAutoBuyBudget(db, owner, input.id))!;
}
export async function readAutoBuyBudgetClaim(
  db: D1Database,
  owner: string,
  id: string,
) {
  const row = await claim(db, owner, id);
  if (!row) return null;
  if (row.owner_id !== owner || row.id !== id) return unavailable();
  const doc = await document(row, 'auto-buy-budget-claim-v1');
  let input: AutoBuyBudgetClaim;
  try {
    input = autoBuyBudgetClaim(doc.request);
  } catch {
    return unavailable();
  }
  if (
    input.id !== row.id ||
    input.sessionId !== row.session_id ||
    input.strategyId !== row.strategy_id ||
    input.wallet !== row.wallet ||
    input.walletRevision !== row.wallet_revision ||
    input.candidateKey !== row.candidate_key ||
    input.kind !== row.kind ||
    input.sourceSha256 !== row.source_sha256 ||
    input.packetSha256 !== row.packet_sha256 ||
    input.minimumOutputTokenRaw !== row.minimum_output_token_raw ||
    input.maximumInputLamports !== String(row.maximum_input_lamports) ||
    input.maximumFeeAndRentLamports !==
      String(row.maximum_fee_and_rent_lamports) ||
    input.expiresAt !== row.expires_at ||
    !['held', 'uncertain', 'released'].includes(row.state)
  )
    return unavailable();
  return {
    request: input,
    inputMint: AUTO_BUY_BUDGET_SOL,
    state: row.state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...AUTO_BUY_BUDGET_AUTHORITY,
  };
}
/** A bounded accounting claim, not a verified order or financial reservation. */
export async function retainAutoBuyBudgetClaim(
  db: D1Database,
  owner: string,
  value: unknown,
) {
  const input = autoBuyBudgetClaim(value);
  await installed(db);
  const old = await readAutoBuyBudgetClaim(db, owner, input.id);
  if (old) {
    if (JSON.stringify(old.request) !== JSON.stringify(input))
      throw new AutoBuyBudgetError(
        'Original candidate budget differs. Recover its saved ID.',
      );
    return old;
  }
  const parent = await session(db, owner, input.sessionId);
  if (!parent)
    throw new AutoBuyBudgetError(
      'Saved budget unavailable. Recover its original ID.',
    );
  await terms(parent);
  const text = JSON.stringify({
    format: 'auto-buy-budget-claim-v1',
    inputMint: AUTO_BUY_BUDGET_SOL,
    request: input,
    ...AUTO_BUY_BUDGET_AUTHORITY,
  });
  try {
    await db
      .prepare(
        'INSERT INTO auto_buy_budget_claims(owner_id,id,session_id,strategy_id,wallet,wallet_revision,candidate_key,kind,source_sha256,packet_sha256,minimum_output_token_raw,maximum_input_lamports,maximum_fee_and_rent_lamports,document,document_sha256,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      )
      .bind(
        owner,
        input.id,
        input.sessionId,
        input.strategyId,
        input.wallet,
        input.walletRevision,
        input.candidateKey,
        input.kind,
        input.sourceSha256,
        input.packetSha256,
        input.minimumOutputTokenRaw,
        Number(input.maximumInputLamports),
        Number(input.maximumFeeAndRentLamports),
        text,
        await digest(text),
        input.expiresAt,
      )
      .run();
  } catch {
    const saved = await readAutoBuyBudgetClaim(db, owner, input.id);
    if (!saved || JSON.stringify(saved.request) !== JSON.stringify(input))
      throw new AutoBuyBudgetError(
        'Budget is closed, stale, duplicated or exhausted. Recover the original candidate before another request.',
      );
    return saved;
  }
  return (await readAutoBuyBudgetClaim(db, owner, input.id))!;
}
export async function controlAutoBuyBudget(
  db: D1Database,
  owner: string,
  id: string,
  revision: number,
  state: 'open' | 'paused' | 'stopped',
) {
  await installed(db);
  if (
    !Number.isSafeInteger(revision) ||
    revision < 0 ||
    !['open', 'paused', 'stopped'].includes(state)
  )
    throw new AutoBuyBudgetError('Choose exact saved budget control.', 400);
  const parent = await session(db, owner, id);
  if (!parent)
    throw new AutoBuyBudgetError(
      'Budget control was not confirmed. Recover saved status.',
    );
  await terms(parent);
  try {
    await db
      .prepare(
        `UPDATE auto_buy_budgets SET state=?,revision=revision+1,updated_at=${now} WHERE owner_id=? AND id=? AND revision=?`,
      )
      .bind(state, owner, id, revision)
      .run();
  } catch {
    /* A committed write may have lost its reply. Read exact state. */
  }
  const latest = await readAutoBuyBudget(db, owner, id);
  if (latest?.revision === revision + 1 && latest.state === state)
    return latest;
  throw new AutoBuyBudgetError(
    'Budget control was not confirmed. Recover saved status.',
  );
}
/** Recovery may return released/uncertain; success is never a holding grant. */
export async function changeAutoBuyBudgetClaim(
  db: D1Database,
  owner: string,
  id: string,
  state: 'uncertain' | 'released',
) {
  await installed(db);
  if (!['uncertain', 'released'].includes(state))
    throw new AutoBuyBudgetError(
      'Choose a supported accounting transition.',
      400,
    );
  const current = await readAutoBuyBudgetClaim(db, owner, id);
  if (!current)
    throw new AutoBuyBudgetError('Saved candidate budget unavailable.', 404);
  if (current.state === state) return current;
  try {
    await db
      .prepare(
        `UPDATE auto_buy_budget_claims SET state=?,updated_at=${now} WHERE owner_id=? AND id=? AND state='held'`,
      )
      .bind(state, owner, id)
      .run();
  } catch {
    /* No claim about release until its saved state is recovered. */
  }
  const latest = await readAutoBuyBudgetClaim(db, owner, id);
  if (latest?.state === state) return latest;
  throw new AutoBuyBudgetError(
    'Candidate transition was not confirmed. Recover its original status.',
  );
}
