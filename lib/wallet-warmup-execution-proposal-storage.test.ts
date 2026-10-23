import { afterEach, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { warmupReconstructionFixture } from '../test/warmup-reconstruction-fixture';
import { advanceFamilyExclusionClock } from '../test/solana-family-exclusion-fixture';
import {
  retainWarmupExecutionProposal as retain,
  readWarmupExecutionProposal as read,
} from './wallet-warmup-execution-proposal-storage';
import { reconstructWarmupExecutionProposal } from './wallet-warmup-execution-budget-review';
import { walletWarmupSessionDigest as digest } from './wallet-warmup-session-digest';
import { canonicalPumpHolderJson as canonical } from './pump-holder-review';
import { readFileSync } from 'node:fs';
import { createClient } from '@libsql/client';
import { Miniflare } from 'miniflare';
import { createTursoDatabase } from '../db/turso';
import { packWarmupExecutionProposal } from './wallet-warmup-execution-proposal-codec';
import { WARMUP_EXECUTION_SOURCE_CURRENT_SQL } from './wallet-warmup-execution-source';
import { WARMUP_RUNTIME_WALLET_BUSY_SQL } from './wallet-warmup-runtime-wallet-busy';
import { warmupProposalSqlTokens } from './wallet-warmup-execution-proposal-schema';

const { controlled } = vi.hoisted(() => ({
  controlled: {
    fetcher: undefined as typeof fetch | undefined,
    now: undefined as (() => number) | undefined,
  },
}));
vi.mock('./wallet-warmup-execution-budget-review', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('./wallet-warmup-execution-budget-review')
    >();
  return {
    ...actual,
    reviewWarmupExecutionBudget: vi.fn(
      (
        db: D1Database,
        owner: string,
        value: unknown,
        signal: AbortSignal,
        dependencies?: { fetcher?: typeof fetch; now?: () => number },
      ) =>
        actual.reviewWarmupExecutionBudget(
          db,
          owner,
          value,
          signal,
          dependencies ?? controlled,
        ),
    ),
  };
});
vi.mock('./wallet-rpc-pacing', () => ({
  paceWalletRpc: vi.fn(async () => {}),
}));
const fixtures: Awaited<ReturnType<typeof warmupReconstructionFixture>>[] = [];
const prior = env.SOLANA_INDEXER_RPC_URL;
afterEach(() => {
  for (const f of fixtures.splice(0)) f.dispose();
  if (prior === undefined) delete env.SOLANA_INDEXER_RPC_URL;
  else env.SOLANA_INDEXER_RPC_URL = prior;
  controlled.fetcher = undefined;
  controlled.now = undefined;
  vi.restoreAllMocks();
});
const signal = () => new AbortController().signal;
type Hook = (sql: string, operation: string) => void | Promise<void>;
async function fixture(maximum = false) {
  const f = await warmupReconstructionFixture('none', maximum);
  fixtures.push(f);
  env.SOLANA_INDEXER_RPC_URL = 'https://reconstruction.invalid/';
  controlled.fetcher = f.fetcher;
  controlled.now = f.clock;
  const request = {
    ...f.input,
    rootId: f.expected.id,
    consentId: f.expected.consentId,
    sessionExpiresAt: f.proposed.terms.intent.expiresAt,
    feeRentLimits: f.proposed.budget.feeRentLimits,
  };
  const statements: string[] = [];
  let hook: Hook | undefined;
  let afterHook: Hook | undefined;
  const db = {
    prepare(sql: string) {
      statements.push(sql);
      const statement = f.db.prepare(sql);
      const wrapper = {
        bind(...values: unknown[]) {
          statement.bind(
            ...values.map((v) =>
              v instanceof ArrayBuffer ? new Uint8Array(v) : v,
            ),
          );
          return wrapper;
        },
        async first<T>() {
          await hook?.(sql, 'first');
          return await statement.first<T>();
        },
        async all<T>() {
          await hook?.(sql, 'all');
          return { ...(await statement.all<T>()), success: true };
        },
        async run<T>() {
          await hook?.(sql, 'run');
          const result = { ...(await statement.run<T>()), success: true };
          await afterHook?.(sql, 'run');
          return result;
        },
      };
      return wrapper;
    },
  } as unknown as D1Database;
  return {
    ...f,
    db,
    request,
    statements,
    setHook: (h?: Hook) => {
      hook = h;
    },
    setAfterHook: (h?: Hook) => {
      afterHook = h;
    },
    save: () => retain(db, f.owner, request, signal()),
    read: () => read(db, f.owner, request.rootId, signal()),
  };
}

async function directStage(f: Awaited<ReturnType<typeof fixture>>) {
  const packed = await packWarmupExecutionProposal(
    {
      format: 'wallet-warmup-execution-proposal-content-v1',
      terms: f.proposed.terms,
      verifierEvidence: f.proposed.verifierEvidence,
    },
    signal(),
  );
  const values = [
    f.owner,
    f.request.rootId,
    f.request.consentId,
    f.request.reviewId,
    f.request.reviewSha256,
    f.proposed.budget.sourceSnapshotSha256,
    await digest(canonical(f.request)),
    canonical(packed.header),
    packed.headerSha256,
    packed.header.bytes,
    f.proposed.verifierEvidence.assets.checkedAt,
    packed.header.proposalExpiresAt,
  ];
  const sql =
    "INSERT INTO wallet_warmup_execution_proposal_stages(owner_id,id,consent_id,review_id,review_sha256,source_snapshot_sha256,request_sha256,header,header_sha256,byte_length,evidence_checked_at,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))";
  return { values, sql, packed };
}

function conjuncts(text: string, op: 'AND' | 'OR') {
  let quote = false,
    depth = 0,
    start = 0;
  const parts: string[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "'") {
      if (quote && text[i + 1] === "'") {
        i++;
        continue;
      }
      quote = !quote;
    } else if (!quote) {
      if (c === '(') depth++;
      else if (c === ')') depth--;
      else if (
        depth === 0 &&
        text.slice(i, i + op.length) === op &&
        !/[a-zA-Z_0-9]/.test(text[i - 1] ?? '') &&
        !/[a-zA-Z_0-9]/.test(text[i + op.length] ?? '')
      ) {
        parts.push(text.slice(start, i).trim());
        start = i + op.length;
        i += op.length - 1;
      }
    }
  }
  expect(quote).toBe(false);
  expect(depth).toBe(0);
  parts.push(text.slice(start).trim());
  return parts;
}

it('retains every original current-source conjunct and every exact non-null busy-family EXISTS predicate in both atomic insert phases', () => {
  const current = conjuncts(WARMUP_EXECUTION_SOURCE_CURRENT_SQL, 'AND');
  const busy = WARMUP_RUNTIME_WALLET_BUSY_SQL;
  const families = conjuncts(
    busy.slice(busy.indexOf(' WHERE ') + 7, busy.lastIndexOf('\n) THEN')),
    'OR',
  );
  expect(current).toHaveLength(10);
  expect(families).toHaveLength(11);
  expect(warmupProposalSqlTokens(current[5])).toBe(
    warmupProposalSqlTokens(
      `NOT EXISTS(SELECT 1 FROM (SELECT r.owner_id AS owner_id,r.document AS review_document) c WHERE (${busy}) IS NOT 0)`,
    ),
  );
  expect(warmupProposalSqlTokens(busy)).toBe(
    warmupProposalSqlTokens(
      `CASE WHEN EXISTS(SELECT 1 FROM json_each(c.review_document,'$.wallets') selected WHERE ${families.join(' OR ')}) THEN 1 ELSE 0 END`,
    ),
  );
  expect(families.every((f) => f.startsWith('EXISTS('))).toBe(true);
  const clauses = current.flatMap((clause, i) =>
    i === 5
      ? families.map((family, j) => ({
          key: `5_busy_${j}`,
          clause: `NOT EXISTS(SELECT 1 FROM (SELECT r.owner_id AS owner_id,r.document AS review_document) c, json_each(c.review_document,'$.wallets') selected WHERE ${family})`,
        }))
      : [{ key: String(i), clause }],
  );
  const statements = readFileSync(
    'drizzle/0139_wallet_warmup_execution_proposals.sql',
    'utf8',
  ).split('--> statement-breakpoint');
  for (const short of ['stage', 'publication']) {
    const table = `wallet_warmup_execution_proposal_${short === 'stage' ? 'stages' : 'publications'}`;
    const from =
      short === 'stage'
        ? 'FROM wallet_warmup_session_reviews r WHERE r.owner_id=NEW.owner_id AND r.id=NEW.review_id AND r.review_sha256=NEW.review_sha256'
        : 'FROM wallet_warmup_execution_proposal_stages ps JOIN wallet_warmup_session_reviews r ON r.owner_id=ps.owner_id AND r.id=ps.review_id AND r.review_sha256=ps.review_sha256 WHERE ps.owner_id=NEW.owner_id AND ps.id=NEW.proposal_id';
    const actual = statements.filter((s) =>
      s.includes(`CREATE TRIGGER warmup_proposal_${short}_current_`),
    );
    expect(actual).toHaveLength(20);
    for (const c of clauses) {
      const name = `warmup_proposal_${short}_current_${c.key}`;
      const found = actual.filter((s) => s.includes(`CREATE TRIGGER ${name} `));
      expect(found).toHaveLength(1);
      const expected = `CREATE TRIGGER ${name} BEFORE INSERT ON ${table} BEGIN SELECT CASE WHEN NOT EXISTS(SELECT 1 ${from} AND (${c.clause})) THEN RAISE(ABORT,'Warmup proposal source is no longer current') END; END;`;
      expect(warmupProposalSqlTokens(found[0])).toBe(
        warmupProposalSqlTokens(expected),
      );
    }
  }
});

it('collects real internal evidence once, immutably stores the complete proposal and records its actual SQL publication time', async () => {
  const f = await fixture(),
    calls = f.providerCalls(),
    saved = await f.save();
  expect(saved).toMatchObject({
    status: 'published',
    id: f.expected.id,
    humanApprovalVerified: false,
    signingAllowed: false,
    executionAllowed: false,
  });
  expect(
    saved?.status === 'published' && saved.proposal.terms.intent.actions,
  ).toEqual(f.proposed.terms.intent.actions);
  expect(f.providerCalls() - calls).toBe(4);
  expect(saved!.publishedAt! >= saved!.createdAt).toBe(true);
  expect(saved!.publishedAt! < saved!.proposalExpiresAt).toBe(true);
  expect(
    f.statements.filter((s) =>
      s.startsWith('INSERT INTO wallet_warmup_execution_proposal_publications'),
    ),
  ).toHaveLength(1);
  const recovered = await f.save();
  expect(recovered).toEqual(saved);
  expect(f.providerCalls() - calls).toBe(4);
  expect(
    f
      .actual!.sqlite.prepare(
        'SELECT count(*) AS n FROM wallet_warmup_session_consents',
      )
      .get()!.n,
  ).toBe(0);
  expect(
    f
      .actual!.sqlite.prepare(
        'SELECT count(*) AS n FROM wallet_warmup_session_consents_v2',
      )
      .get()!.n,
  ).toBe(0);
});

it('reconstructs a pre-approval proposal without inventing any approval record', async () => {
  const f = await fixture(),
    p = f.proposed;
  const out = await reconstructWarmupExecutionProposal(
    f.db,
    f.owner,
    { terms: p.terms, verifierEvidence: p.verifierEvidence },
    { ...f.expected, rootSha256: undefined, termsSha256: p.termsSha256 },
    signal(),
  ).catch(() => null);
  // Unknown root-domain fields refuse, even if explicitly undefined.
  expect(out).toBeNull();
  const replay = await reconstructWarmupExecutionProposal(
    f.db,
    f.owner,
    { terms: p.terms, verifierEvidence: p.verifierEvidence },
    {
      id: f.expected.id,
      consentId: f.expected.consentId,
      reviewId: f.expected.reviewId,
      termsSha256: p.termsSha256,
    },
    signal(),
  );
  expect(replay.terms).toEqual(p.terms);
  expect(replay.humanApprovalVerified).toBe(false);
  expect('approval' in replay).toBe(false);
});

it.each(['amount', 'consentId', 'reviewSha256', 'expiry'] as const)(
  'refuses conflicting same-ID %s without provider replacement or writes',
  async (kind) => {
    const f = await fixture();
    await f.save();
    const calls = f.providerCalls();
    const changed = structuredClone(f.request);
    if (kind === 'amount') changed.feeRentLimits[0].maximumLamports = '6000000';
    if (kind === 'consentId') changed.consentId = crypto.randomUUID();
    if (kind === 'reviewSha256') changed.reviewSha256 = '0'.repeat(64);
    if (kind === 'expiry')
      changed.sessionExpiresAt = new Date(
        Date.parse(changed.sessionExpiresAt) + 1,
      ).toISOString();
    f.statements.length = 0;
    await expect(retain(f.db, f.owner, changed, signal())).rejects.toThrow(
      'Recover the same proposal ID',
    );
    expect(f.providerCalls()).toBe(calls);
    expect(f.statements.some((s) => /INSERT|UPDATE|DELETE/.test(s))).toBe(
      false,
    );
  },
);

it('recovers published history after expiry and mutable plan changes, with no provider call or SQL write', async () => {
  const f = await fixture(),
    saved = await f.save(),
    calls = f.providerCalls();
  advanceFamilyExclusionClock(f.actual!.sqlite, 70000);
  f.actual!.advance(70000);
  f.actual!.sqlite.prepare(
    'UPDATE wallet_warmup_plans SET archived=1 WHERE owner_id=? AND id=?',
  ).run(f.owner, f.actual!.planId);
  f.statements.length = 0;
  expect(await f.read()).toEqual(saved);
  expect(await f.save()).toEqual(saved);
  expect(f.providerCalls()).toBe(calls);
  expect(f.statements.some((s) => /INSERT|UPDATE|DELETE/.test(s))).toBe(false);
});

it('does not disclose or fall back for missing/other-owner IDs', async () => {
  const f = await fixture();
  await f.save();
  const calls = f.providerCalls();
  expect(
    await read(f.db, 'other-owner', f.request.rootId, signal()),
  ).toBeNull();
  expect(await read(f.db, f.owner, crypto.randomUUID(), signal())).toBeNull();
  expect(f.providerCalls()).toBe(calls);
});

it('keeps an interrupted partial stage non-approvable and never recollects for that ID', async () => {
  const f = await fixture();
  let fired = false;
  f.setHook((sql, op) => {
    if (
      !fired &&
      op === 'run' &&
      sql.startsWith('INSERT INTO wallet_warmup_execution_proposal_chunks')
    ) {
      fired = true;
      throw Error('simulated write interruption');
    }
  });
  await expect(f.save()).rejects.toThrow('Recover the same proposal ID');
  f.setHook();
  const calls = f.providerCalls(),
    kept = await f.read();
  expect(kept).toMatchObject({
    status: 'incomplete',
    stagedChunks: 0,
    publishedAt: null,
    humanApprovalVerified: false,
  });
  expect(kept).not.toHaveProperty('proposal');
  expect(await f.save()).toEqual(kept);
  expect(f.providerCalls()).toBe(calls);
});

it('resumes complete staged publication after a lost pre-publication response without renewing or recollecting', async () => {
  const f = await fixture();
  let fired = false;
  f.setHook((sql, op) => {
    if (
      !fired &&
      op === 'run' &&
      sql.startsWith(
        'INSERT INTO wallet_warmup_execution_proposal_publications',
      )
    ) {
      fired = true;
      throw Error('simulated before publication');
    }
  });
  await expect(f.save()).rejects.toThrow();
  f.setHook();
  const calls = f.providerCalls(),
    staged = await f.read();
  expect(staged?.status).toBe('staged');
  const saved = await f.save();
  expect(saved?.status).toBe('published');
  expect(saved!.headerSha256).toBe(staged!.headerSha256);
  expect(saved!.proposalExpiresAt).toBe(staged!.proposalExpiresAt);
  expect(f.providerCalls()).toBe(calls);
});

it('refuses expired complete staging while preserving historical recovery and original expiry', async () => {
  const f = await fixture();
  f.setHook((sql, op) => {
    if (
      op === 'run' &&
      sql.startsWith(
        'INSERT INTO wallet_warmup_execution_proposal_publications',
      )
    )
      throw Error('stop before publication');
  });
  await expect(f.save()).rejects.toThrow();
  f.setHook();
  const staged = await f.read(),
    calls = f.providerCalls();
  advanceFamilyExclusionClock(f.actual!.sqlite, 25001);
  f.actual!.advance(25001);
  await expect(f.save()).rejects.toThrow('Recover the same proposal ID');
  expect(await f.read()).toEqual(staged);
  expect(f.providerCalls()).toBe(calls);
});

it.each(['plan', 'wallet', 'reservation', 'expiry'] as const)(
  'closes the final publication %s race inside SQL',
  async (kind) => {
    const f = await fixture();
    let fired = false;
    let mutationComplete = false;
    f.setHook((sql, op) => {
      if (
        fired ||
        op !== 'run' ||
        !sql.startsWith(
          'INSERT INTO wallet_warmup_execution_proposal_publications',
        )
      )
        return;
      fired = true;
      if (kind === 'plan')
        f.actual!.sqlite.prepare(
          'UPDATE wallet_warmup_plans SET archived=1 WHERE owner_id=? AND id=?',
        ).run(f.owner, f.actual!.planId);
      if (kind === 'wallet')
        f.actual!.sqlite.prepare(
          "UPDATE workspace_wallets SET archived=1 WHERE owner_id=? AND chain='Solana'",
        ).run(f.owner);
      if (kind === 'reservation')
        f.actual!.sqlite.prepare(
          "INSERT INTO solana_swap_reservations(owner_id,wallet_address,scope,intent_id,state) VALUES(?,?,'warmup',?,'awaiting_signature')",
        ).run(
          f.owner,
          f.source.retainedReview.document.wallets[0].wallet,
          crypto.randomUUID(),
        );
      if (kind === 'expiry')
        advanceFamilyExclusionClock(f.actual!.sqlite, 25001);
      mutationComplete = true;
    });
    await expect(f.save()).rejects.toThrow();
    f.setHook();
    expect(fired).toBe(true);
    expect(mutationComplete).toBe(true);
    expect((await f.read())?.status).toBe('staged');
    expect(
      f
        .actual!.sqlite.prepare(
          'SELECT count(*) AS n FROM wallet_warmup_execution_proposal_publications',
        )
        .get()!.n,
    ).toBe(0);
  },
);

it.each(['stage', 'chunk', 'publication'] as const)(
  'refuses updates and deletion of immutable %s rows',
  async (kind) => {
    const f = await fixture();
    await f.save();
    const table =
      kind === 'stage'
        ? 'wallet_warmup_execution_proposal_stages'
        : kind === 'chunk'
          ? 'wallet_warmup_execution_proposal_chunks'
          : 'wallet_warmup_execution_proposal_publications';
    const field =
      kind === 'stage'
        ? 'header_sha256'
        : kind === 'chunk'
          ? 'sha256'
          : 'header_sha256';
    expect(() =>
      f.actual!.sqlite.exec(`UPDATE ${table} SET ${field}='${'0'.repeat(64)}'`),
    ).toThrow('immutable');
    expect(() => f.actual!.sqlite.exec(`DELETE FROM ${table}`)).toThrow(
      'immutable',
    );
  },
);

it('refuses a corrupt published chunk rather than returning a partial or generic valid packet', async () => {
  const f = await fixture();
  await f.save();
  const guard = f
    .actual!.sqlite.prepare(
      "SELECT sql FROM sqlite_master WHERE name='warmup_proposal_chunk_no_update'",
    )
    .get()!.sql as string;
  f.actual!.sqlite.exec('DROP TRIGGER warmup_proposal_chunk_no_update');
  f.actual!.sqlite.exec(
    'UPDATE wallet_warmup_execution_proposal_chunks SET data=zeroblob(length(data))',
  );
  // Restore exact SQL so installed fingerprints pass and byte hashes refuse.
  f.actual!.sqlite.exec(guard);
  await expect(f.read()).rejects.toThrow('Recover the same proposal ID');
});

it.each(['request_sha256', 'source_snapshot_sha256'] as const)(
  'binds stored %s rather than trusting matching transport hashes',
  async (field) => {
    const f = await fixture(),
      saved = await f.save();
    expect(saved?.status).toBe('published');
    const guard = f
      .actual!.sqlite.prepare(
        "SELECT sql FROM sqlite_master WHERE name='warmup_proposal_stage_no_update'",
      )
      .get()!.sql as string;
    f.actual!.sqlite.exec('DROP TRIGGER warmup_proposal_stage_no_update');
    f.actual!.sqlite.prepare(
      `UPDATE wallet_warmup_execution_proposal_stages SET ${field}=?`,
    ).run(await digest(canonical({ fake: true })));
    f.actual!.sqlite.exec(guard);
    await expect(f.read()).rejects.toThrow();
  },
);

it('rejects caller evidence and forged approval flags before provider reads', async () => {
  const f = await fixture(),
    calls = f.providerCalls();
  await expect(
    retain(
      f.db,
      f.owner,
      { ...f.request, evidence: f.proposed.verifierEvidence, approved: true },
      signal(),
    ),
  ).rejects.toThrow();
  expect(f.providerCalls()).toBe(calls);
});

it('the database independently refuses publication after source drift, even without the service INSERT predicate', async () => {
  const f = await fixture();
  f.setHook((sql, op) => {
    if (
      op === 'run' &&
      sql.startsWith(
        'INSERT INTO wallet_warmup_execution_proposal_publications',
      )
    )
      throw Error('retain staged fixture only');
  });
  await expect(f.save()).rejects.toThrow();
  f.setHook();
  const staged = await f.read();
  expect(staged?.status).toBe('staged');
  f.actual!.sqlite.prepare(
    'UPDATE wallet_warmup_plans SET archived=1 WHERE owner_id=? AND id=?',
  ).run(f.owner, f.actual!.planId);
  expect(() =>
    f
      .actual!.sqlite.prepare(
        "INSERT INTO wallet_warmup_execution_proposal_publications VALUES(?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
      )
      .run(f.owner, f.request.rootId, staged!.headerSha256),
  ).toThrow('source is no longer current');
});

it('the database prevents publication of missing pieces and keeps new IDs isolated from legacy consent insertion', async () => {
  const f = await fixture();
  f.setHook((sql, op) => {
    if (
      op === 'run' &&
      sql.startsWith('INSERT INTO wallet_warmup_execution_proposal_chunks')
    )
      throw Error('retain empty staged fixture only');
  });
  await expect(f.save()).rejects.toThrow();
  f.setHook();
  const kept = await f.read();
  expect(kept?.status).toBe('incomplete');
  expect(() =>
    f
      .actual!.sqlite.prepare(
        "INSERT INTO wallet_warmup_execution_proposal_publications VALUES(?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
      )
      .run(f.owner, f.request.rootId, kept!.headerSha256),
  ).toThrow('publication refused');
  for (const table of [
    'wallet_warmup_session_consents',
    'wallet_warmup_session_consents_v2',
  ]) {
    // The NEW-row isolation guard must refuse before any legacy approval can
    // be admitted. Deliberately incomplete legacy bodies confer no authority.
    expect(() =>
      f
        .actual!.sqlite.prepare(
          `INSERT INTO ${table}(owner_id,id,review_id,terms_sha256,document,created_at) VALUES(?,?,?,?,'{}',?)`,
        )
        .run(
          f.owner,
          f.request.consentId,
          f.request.reviewId,
          '0'.repeat(64),
          new Date(f.clock()).toISOString(),
        ),
    ).toThrow('cannot become legacy approvals');
  }
});

it('a lost publication response recovers the exact published bytes once without repeating writes or providers', async () => {
  const f = await fixture();
  let fired = false;
  f.setAfterHook((sql, op) => {
    if (
      !fired &&
      op === 'run' &&
      sql.startsWith(
        'INSERT INTO wallet_warmup_execution_proposal_publications',
      )
    ) {
      fired = true;
      throw Error('lost committed response');
    }
  });
  const recovered = await f.save();
  expect(fired).toBe(true);
  expect(recovered?.status).toBe('published');
  f.setAfterHook();
  const calls = f.providerCalls(),
    kept = await f.read();
  expect(kept?.status).toBe('published');
  expect(kept).toEqual(recovered);
  f.statements.length = 0;
  expect(await f.save()).toEqual(kept);
  expect(f.providerCalls()).toBe(calls);
  expect(f.statements.some((s) => /INSERT|UPDATE|DELETE/.test(s))).toBe(false);
});

it('cancellation at the committed publication boundary leaves recoverable original metadata and grants no approval', async () => {
  const f = await fixture(),
    c = new AbortController();
  f.setAfterHook((sql, op) => {
    if (
      op === 'run' &&
      sql.startsWith(
        'INSERT INTO wallet_warmup_execution_proposal_publications',
      )
    )
      c.abort(Error('caller left after publication'));
  });
  await expect(retain(f.db, f.owner, f.request, c.signal)).rejects.toThrow(
    'caller left after publication',
  );
  f.setAfterHook();
  const kept = await f.read();
  expect(kept).toMatchObject({
    status: 'published',
    humanApprovalVerified: false,
    signingAllowed: false,
  });
});

it('concurrent same-ID requests admit exactly one original proposal without replacement', async () => {
  const f = await fixture();
  let arrivals = 0,
    release!: () => void;
  const barrier = new Promise<void>((r) => {
    release = r;
  });
  f.setHook(async (sql, op) => {
    if (
      op !== 'run' ||
      !sql.startsWith('INSERT INTO wallet_warmup_execution_proposal_stages')
    )
      return;
    arrivals++;
    if (arrivals === 2) release();
    await barrier;
  });
  const results = await Promise.allSettled([f.save(), f.save()]);
  f.setHook();
  expect(arrivals).toBe(2);
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
  const winning = results.find(
    (r) => r.status === 'fulfilled',
  ) as PromiseFulfilledResult<Awaited<ReturnType<typeof f.save>>>;
  expect(await f.read()).toEqual(winning.value);
  expect(
    f
      .actual!.sqlite.prepare(
        'SELECT count(*) AS n FROM wallet_warmup_execution_proposal_stages',
      )
      .get()!.n,
  ).toBe(1);
});

it('a read during active chunk staging is incomplete without claiming failure or fetching replacement facts', async () => {
  const f = await fixture();
  let reached!: () => void, release!: () => void;
  const atChunk = new Promise<void>((r) => {
      reached = r;
    }),
    hold = new Promise<void>((r) => {
      release = r;
    });
  f.setHook(async (sql, op) => {
    if (
      op === 'run' &&
      sql.startsWith('INSERT INTO wallet_warmup_execution_proposal_chunks')
    ) {
      reached();
      await hold;
    }
  });
  const writer = f.save();
  try {
    await Promise.race([
      atChunk,
      writer.then(() => {
        throw Error('writer unexpectedly finished before barrier');
      }),
    ]);
    const calls = f.providerCalls(),
      kept = await f.read();
    expect(kept?.status).toBe('incomplete');
    expect(kept).not.toHaveProperty('proposal');
    expect(kept?.status === 'incomplete' && kept.message).toContain(
      'Recover this same ID',
    );
    expect(f.providerCalls()).toBe(calls);
  } finally {
    release();
  }
  expect((await writer)?.status).toBe('published');
});

it('concurrent staged recoveries return the identical single published proposal with no provider replacement', async () => {
  const f = await fixture();
  f.setHook((sql, op) => {
    if (
      op === 'run' &&
      sql.startsWith(
        'INSERT INTO wallet_warmup_execution_proposal_publications',
      )
    )
      throw Error('hold staged fixture');
  });
  await expect(f.save()).rejects.toThrow();
  const calls = f.providerCalls();
  let arrivals = 0,
    release!: () => void;
  const barrier = new Promise<void>((r) => {
    release = r;
  });
  f.setHook(async (sql, op) => {
    if (
      op === 'run' &&
      sql.startsWith(
        'INSERT INTO wallet_warmup_execution_proposal_publications',
      )
    ) {
      if (++arrivals === 2) release();
      await barrier;
    }
  });
  const [a, b] = await Promise.all([f.save(), f.save()]);
  f.setHook();
  expect(arrivals).toBe(2);
  expect(a?.status).toBe('published');
  expect(a).toEqual(b);
  expect(f.providerCalls()).toBe(calls);
});

it('the original first writer recovers when a same-ID staged recovery publishes first', async () => {
  const f = await fixture();
  let reached!: () => void, release!: () => void;
  const atPublication = new Promise<void>((r) => {
      reached = r;
    }),
    hold = new Promise<void>((r) => {
      release = r;
    });
  f.setHook(async (sql, op) => {
    if (
      op === 'run' &&
      sql.startsWith(
        'INSERT INTO wallet_warmup_execution_proposal_publications',
      )
    ) {
      reached();
      await hold;
    }
  });
  const writer = f.save();
  let recovered;
  try {
    await Promise.race([
      atPublication,
      writer.then(() => {
        throw Error('writer unexpectedly finished before publication barrier');
      }),
    ]);
    f.setHook();
    const calls = f.providerCalls();
    recovered = await f.save();
    expect(recovered?.status).toBe('published');
    expect(f.providerCalls()).toBe(calls);
  } finally {
    release();
  }
  expect(await writer).toEqual(recovered);
});

it('rejects source drift after collection but before the first stage insert', async () => {
  const f = await fixture();
  let changed = false;
  f.setHook((sql, op) => {
    if (
      op === 'run' &&
      sql.startsWith('INSERT INTO wallet_warmup_execution_proposal_stages')
    ) {
      f.actual!.sqlite.prepare(
        'UPDATE wallet_warmup_plans SET archived=1 WHERE owner_id=? AND id=?',
      ).run(f.owner, f.actual!.planId);
      changed = true;
    }
  });
  await expect(f.save()).rejects.toThrow();
  expect(changed).toBe(true);
  expect(
    f
      .actual!.sqlite.prepare(
        'SELECT count(*) AS n FROM wallet_warmup_execution_proposal_stages',
      )
      .get()!.n,
  ).toBe(0);
});

it.each([
  'wallet_warmup_session_consents',
  'wallet_warmup_session_consents_v2',
] as const)(
  'blocks legacy-first namespace membership in %s before new provider work',
  async (table) => {
    const f = await fixture(),
      sqlite = f.actual!.sqlite,
      { sql, values } = await directStage(f);
    const guards = sqlite
      .prepare(
        "SELECT name,sql FROM sqlite_master WHERE type='trigger' AND tbl_name=? AND sql LIKE '%BEFORE INSERT%'",
      )
      .all(table);
    for (const g of guards) sqlite.exec(`DROP TRIGGER ${String(g.name)}`);
    // Adversarial existing legacy metadata, NOT a valid approval or signing
    // grant. Even corrupt old membership must not upgrade to new proposals.
    sqlite
      .prepare(`INSERT INTO ${table} VALUES(?,?,?,?,'{}',?)`)
      .run(
        f.owner,
        f.request.consentId,
        f.request.reviewId,
        '0'.repeat(64),
        new Date(f.clock()).toISOString(),
      );
    for (const g of guards) sqlite.exec(g.sql as string);
    const calls = f.providerCalls();
    await expect(f.save()).rejects.toThrow();
    expect(f.providerCalls()).toBe(calls);
    expect(() => sqlite.prepare(sql).run(...values)).toThrow('staging refused');
  },
);

it('persists and reconstructs the complete maximum 800-action proposal across multiple immutable pieces', async () => {
  const f = await fixture(true),
    saved = await f.save();
  expect(saved?.status).toBe('published');
  expect(saved!.totalChunks).toBeGreaterThan(1);
  expect(
    saved?.status === 'published' && saved.proposal.terms.intent.actions,
  ).toHaveLength(800);
  expect(await f.read()).toEqual(saved);
});

it('refuses INSERT OR REPLACE for original pieces and actual publication time even with recursive delete triggers disabled', async () => {
  const f = await fixture();
  f.setHook((sql, op) => {
    if (
      op === 'run' &&
      sql.startsWith(
        'INSERT INTO wallet_warmup_execution_proposal_publications',
      )
    )
      throw Error('hold complete staging');
  });
  await expect(f.save()).rejects.toThrow();
  f.setHook();
  f.actual!.sqlite.exec('PRAGMA recursive_triggers=OFF');
  expect(() =>
    f.actual!.sqlite.exec(
      'INSERT OR REPLACE INTO wallet_warmup_execution_proposal_stages SELECT * FROM wallet_warmup_execution_proposal_stages',
    ),
  ).toThrow('staging refused');
  expect(() =>
    f.actual!.sqlite.exec(
      'INSERT OR REPLACE INTO wallet_warmup_execution_proposal_chunks SELECT * FROM wallet_warmup_execution_proposal_chunks',
    ),
  ).toThrow('chunk refused');
  const saved = await f.save();
  advanceFamilyExclusionClock(f.actual!.sqlite, 1000);
  expect(() =>
    f
      .actual!.sqlite.prepare(
        "INSERT OR REPLACE INTO wallet_warmup_execution_proposal_publications VALUES(?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
      )
      .run(f.owner, f.request.rootId, saved!.headerSha256),
  ).toThrow('publication refused');
  expect(await f.read()).toEqual(saved);
});

it('refuses a same-name modified guard before provider collection', async () => {
  const f = await fixture(),
    calls = f.providerCalls();
  f.actual!.sqlite.exec('DROP TRIGGER warmup_proposal_publication_current_0');
  f.actual!.sqlite.exec(
    'CREATE TRIGGER warmup_proposal_publication_current_0 BEFORE INSERT ON wallet_warmup_execution_proposal_publications BEGIN SELECT 1; END',
  );
  await expect(f.save()).rejects.toThrow();
  expect(f.providerCalls()).toBe(calls);
});

it('refuses original evidence evaluated after SQL stage creation without moving either clock', async () => {
  const f = await fixture(),
    { sql, values } = await directStage(f);
  values[10] = new Date(f.clock() + 100).toISOString();
  expect(() => f.actual!.sqlite.prepare(sql).run(...values)).toThrow(
    'staging refused',
  );
  expect(
    f
      .actual!.sqlite.prepare(
        'SELECT count(*) AS n FROM wallet_warmup_execution_proposal_stages',
      )
      .get()!.n,
  ).toBe(0);
});

it('refuses a header exceeding 128KiB in SQL independently of canonical decoding', async () => {
  const f = await fixture(),
    { sql, values } = await directStage(f);
  values[7] = ' '.repeat(131072) + values[7];
  expect(() => f.actual!.sqlite.prepare(sql).run(...values)).toThrow(
    'staging refused',
  );
});

it.each(['count', 'declared-bytes'] as const)(
  'conservatively counts all pre-existing reserved metadata against the owner %s quota',
  async (kind) => {
    const f = await fixture(),
      { sql, values } = await directStage(f),
      sqlite = f.actual!.sqlite;
    const ddl = sqlite
      .prepare(
        "SELECT sql FROM sqlite_master WHERE name='warmup_proposal_stage_insert'",
      )
      .get()!.sql as string;
    // Deliberately orphaned quota-occupancy specimens, not admitted sources or
    // legitimate proposals. Corrupt/expired history must not free quota silently.
    const currentGuards = sqlite
      .prepare(
        "SELECT name,sql FROM sqlite_master WHERE name LIKE 'warmup_proposal_stage_current_%'",
      )
      .all();
    sqlite.exec(
      'PRAGMA foreign_keys=OFF; DROP TRIGGER warmup_proposal_stage_insert;',
    );
    for (const g of currentGuards)
      sqlite.exec(`DROP TRIGGER ${String(g.name)}`);
    const insert = sqlite.prepare(sql);
    for (let i = 0; i < (kind === 'count' ? 128 : 4); i++) {
      const v = [...values];
      v[1] = crypto.randomUUID();
      v[2] = crypto.randomUUID();
      v[3] = crypto.randomUUID();
      v[9] = kind === 'count' ? 1 : 67108864;
      insert.run(...v);
    }
    sqlite.exec(ddl);
    for (const g of currentGuards) sqlite.exec(g.sql as string);
    sqlite.exec('PRAGMA foreign_keys=ON');
    expect(() => sqlite.prepare(sql).run(...values)).toThrow('staging refused');
    const calls = f.providerCalls();
    await expect(f.save()).rejects.toThrow();
    expect(f.providerCalls()).toBe(calls);
  },
);

it.each(['turso', 'd1'] as const)(
  'runs actual private publication and saved-only owned recovery through disposable %s',
  async (platform) => {
    const client =
      platform === 'turso' ? createClient({ url: 'file::memory:' }) : null;
    const mf =
      platform === 'd1'
        ? new Miniflare({
            telemetry: { enabled: false },
            workers: [
              {
                config: {
                  name: 'warmup-proposal-storage-only',
                  type: 'worker',
                  compatibilityDate: '2026-09-01',
                  manifest: {
                    mainModule: 'index.js',
                    modules: {
                      'index.js': {
                        type: 'esm',
                        contents:
                          'export default {fetch(){return new Response("local fixture only")}}',
                      },
                    },
                  },
                  env: {
                    DB: { type: 'd1', id: 'warmup-proposal-storage-only' },
                  },
                },
              },
            ],
          })
        : null;
    try {
      const db = client
        ? createTursoDatabase(client)
        : ((await mf!.getD1Database(
            'DB',
            'warmup-proposal-storage-only',
          )) as unknown as D1Database);
      const journal = JSON.parse(
        readFileSync('drizzle/meta/_journal.json', 'utf8'),
      ) as { entries: { tag: string }[] };
      for (const e of journal.entries) {
        const sql = readFileSync(`drizzle/${e.tag}.sql`, 'utf8');
        await db.batch(
          sql
            .split('--> statement-breakpoint')
            .map((s) => s.trim())
            .filter(Boolean)
            .map((statement) => db.prepare(statement)),
        );
      }
      // Initialize the real adapters before creating time-bounded original source.
      const f = await fixture();
      for (const table of [
        'workspace_wallets',
        'wallet_warmup_plans',
        'wallet_warmup_session_reviews',
      ]) {
        const rows = f
          .actual!.sqlite.prepare(`SELECT * FROM ${table} WHERE owner_id=?`)
          .all(f.owner);
        for (const row of rows) {
          const keys = Object.keys(row);
          await db
            .prepare(
              `INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map(() => '?').join(',')})`,
            )
            .bind(...keys.map((k) => row[k]))
            .run();
        }
      }
      let saved, insertError: string | undefined;
      const traced = {
        prepare(sql: string) {
          const statement = db.prepare(sql);
          if (
            !sql.startsWith(
              'INSERT INTO wallet_warmup_execution_proposal_stages',
            )
          )
            return statement;
          return {
            bind(...values: unknown[]) {
              const bound = statement.bind(...values);
              return {
                async run() {
                  try {
                    return await bound.run();
                  } catch (e) {
                    insertError =
                      e instanceof Error
                        ? e.message.slice(0, 220)
                        : 'non-error refusal';
                    throw e;
                  }
                },
              };
            },
          };
        },
      } as unknown as D1Database;
      try {
        saved = await retain(traced, f.owner, f.request, signal());
      } catch {
        // Synthetic test diagnostics only; never log source documents, URLs,
        // credentials or provider responses through the product error path.
        const stageCount = await db
          .prepare(
            'SELECT count(*) AS n FROM wallet_warmup_execution_proposal_stages',
          )
          .first<{ n: number }>();
        const chunkCount = await db
          .prepare(
            'SELECT count(*) AS n FROM wallet_warmup_execution_proposal_chunks',
          )
          .first<{ n: number }>();
        const publicationCount = await db
          .prepare(
            'SELECT count(*) AS n FROM wallet_warmup_execution_proposal_publications',
          )
          .first<{ n: number }>();
        throw Error(
          JSON.stringify({
            syntheticAdapter: platform,
            insertError,
            stageCount: stageCount?.n,
            chunkCount: chunkCount?.n,
            publicationCount: publicationCount?.n,
            providerCalls: f.providerCalls(),
            fixtureClock: f.clock(),
            sqlClock: await db
              .prepare("SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS clock")
              .first(),
          }),
        );
      }
      expect(saved?.status).toBe('published');
      const calls = f.providerCalls();
      expect(await read(db, f.owner, f.request.rootId, signal())).toEqual(
        saved,
      );
      expect(await retain(db, f.owner, f.request, signal())).toEqual(saved);
      expect(f.providerCalls()).toBe(calls);
      const fk = await db.prepare('PRAGMA foreign_key_check').all();
      expect(fk.results).toHaveLength(0);
    } finally {
      client?.close();
      await mf?.dispose();
    }
  },
);
