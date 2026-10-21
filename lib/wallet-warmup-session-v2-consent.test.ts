import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { canonicalPumpHolderJson as canonical } from './pump-holder-review';
import { warmupSessionV2ConsentFixture } from '@/test/warmup-session-v2-consent-fixture';
import {
  reviewWalletWarmupV2Consent as review,
  retainWalletWarmupV2Consent as save,
  readWalletWarmupV2Consent as read,
  warmupV2QualificationPolicy,
} from './wallet-warmup-session-v2-consent';
import {
  retainWalletWarmupSessionConsent as saveLegacy,
  reviewWalletWarmupSessionConsent as reviewLegacy,
} from './wallet-warmup-session-consent';
import { loadWalletWarmupProgress } from './wallet-warmup-progress-server';
import { reviewWalletWarmupSession } from './wallet-warmup-session-review';
import { retainWalletWarmupSessionReview } from './wallet-warmup-session-storage';
import { walletWarmupSessionDigest } from './wallet-warmup-session-digest';
let f: Awaited<ReturnType<typeof warmupSessionV2ConsentFixture>>;
const signal = () => new AbortController().signal;
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  f = await warmupSessionV2ConsentFixture();
});
afterEach(() => {
  f?.client.close();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
const retain = () => save(f.db, 'owner', f.v2Input, true, signal());
async function anotherReview() {
  vi.setSystemTime(Date.now() + 10);
  const current = await loadWalletWarmupProgress(
    f.db,
    'owner',
    f.plan.id,
    1,
    false,
    true,
  );
  const body = reviewWalletWarmupSession(
    current.plan,
    current.progress,
    current.performance,
  );
  const kept = await retainWalletWarmupSessionReview(
    f.db,
    'owner',
    {
      id: crypto.randomUUID(),
      planId: f.plan.id,
      revision: 1,
      reviewedAt: body.reviewedAt,
      reviewSha256: await walletWarmupSessionDigest(body.contextKey),
    },
    true,
    signal(),
  );
  const selected = {
    reviewId: kept.id,
    reviewSha256: kept.reviewSha256,
    sessionExpiresAt: f.selection.sessionExpiresAt,
  };
  return {
    selected,
    v1: await reviewLegacy(f.db, 'owner', selected, signal()),
    v2: await review(f.db, 'owner', selected, signal()),
  };
}
function interceptInsert(
  run: (statement: D1PreparedStatement) => Promise<D1Result>,
) {
  return {
    prepare: (sql: string) => {
      const statement = f.db.prepare(sql);
      if (!sql.startsWith('INSERT INTO wallet_warmup_session_consents_v2'))
        return statement;
      return {
        bind: (...args: unknown[]) => {
          const bound = statement.bind(...args);
          return { run: () => run(bound) };
        },
      } as unknown as D1PreparedStatement;
    },
  } as unknown as D1Database;
}
async function direct(
  document: unknown = f.v2Prepared.terms,
  id = crypto.randomUUID(),
) {
  return f.db
    .prepare(
      'INSERT INTO wallet_warmup_session_consents_v2 VALUES(?,?,?,?,?,?)',
    )
    .bind(
      'owner',
      id,
      f.selection.reviewId,
      f.v2Input.termsSha256,
      canonical(document),
      new Date().toISOString(),
    )
    .run();
}
it('records exact new finite read-policy terms with false authority and keeps all legacy trigger bodies unchanged', async () => {
  const value = await retain();
  expect(value.terms).toEqual(f.v2Prepared.terms);
  expect(value.terms.policy).toEqual({
    qualificationTtlMs: 60000,
    minimumGapMs: 30000,
    maxAttemptsPerAction: 3,
    maxPendingActions: 1,
    maxQualifications: 12,
  });
  expect(value.terms).toMatchObject({
    format: 'wallet-warmup-session-consent-v2',
    executionAllowed: false,
    signingAllowed: false,
    automaticExecutionAllowed: false,
  });
  const rows = (
    await f.db
      .prepare(
        "SELECT name,sql FROM sqlite_master WHERE type='trigger' ORDER BY name",
      )
      .all<{ name: string; sql: string }>()
  ).results;
  for (const old of f.legacy)
    expect(rows.find((r) => r.name === old.name)).toEqual(old);
  expect(
    await f.db
      .prepare('SELECT count(*) AS n FROM wallet_warmup_session_consents')
      .first(),
  ).toEqual({ n: 0 });
});
it('requires exact separately approved policy and rejects a v1 digest', async () => {
  await expect(save(f.db, 'owner', f.v2Input, false, signal())).rejects.toThrow(
    'separately',
  );
  await expect(
    save(
      f.db,
      'owner',
      { ...f.v2Input, termsSha256: f.input.termsSha256 },
      true,
      signal(),
    ),
  ).rejects.toThrow('changed');
  expect(
    await f.db
      .prepare('SELECT count(*) AS n FROM wallet_warmup_session_consents_v2')
      .first(),
  ).toEqual({ n: 0 });
});
it('keeps count and byte capacity distinct at the 4800-action boundary', () => {
  expect(warmupV2QualificationPolicy(4800).maxQualifications).toBe(14400);
  for (const n of [0, 4801, 1.5, NaN])
    expect(() => warmupV2QualificationPolicy(n)).toThrow(
      'No actions were dropped',
    );
  const manifest = JSON.parse(f.v2Prepared.terms.reviewDocument);
  manifest.actions = Array.from({ length: 4800 }, (_, i) => ({
    ...manifest.actions[0],
    id: manifest.actions[0].id + ':' + i,
  }));
  expect(
    new TextEncoder().encode(JSON.stringify(manifest)).byteLength,
  ).toBeGreaterThan(1048576);
});
it('enforces the SQL action-count boundary without treating a shape-only parent as admitted source evidence', async () => {
  const row = await f.db
    .prepare(
      'SELECT * FROM wallet_warmup_session_reviews WHERE owner_id=? AND id=?',
    )
    .bind('owner', f.selection.reviewId)
    .first<Record<string, string | number>>();
  expect(row).toBeTruthy();
  const document = JSON.parse(row!.document as string),
    id = crypto.randomUUID(),
    sha = 'd'.repeat(64);
  document.contextSha256 = sha;
  document.actions = Array.from({ length: 4800 }, (_, i) => ({
    id: String(i),
    cycle: 1,
    side: 'Buy',
    wallet: f.plan.document.addresses[0],
    walletRevision: 1,
    mint: 'shape-only',
    scheduledAt: document.reviewedAt,
  }));
  const insert = (parentId: string, doc: unknown, reviewSha: string) =>
    f.db
      .prepare(
        'INSERT INTO wallet_warmup_session_reviews VALUES(?,?,?,?,?,?,?,?,?,?,?)',
      )
      .bind(
        'owner',
        parentId,
        row!.plan_id,
        row!.plan_revision,
        reviewSha,
        row!.source_sha256,
        canonical(doc),
        row!.source,
        row!.reviewed_at,
        row!.review_expires_at,
        new Date().toISOString(),
      )
      .run();
  await insert(id, document, sha);
  const terms = {
    ...f.v2Prepared.terms,
    reviewId: id,
    reviewSha256: sha,
    reviewDocument: canonical(document),
    policy: warmupV2QualificationPolicy(4800),
  };
  const consentId = crypto.randomUUID();
  await f.db
    .prepare(
      'INSERT INTO wallet_warmup_session_consents_v2 VALUES(?,?,?,?,?,?)',
    )
    .bind(
      'owner',
      consentId,
      id,
      'e'.repeat(64),
      canonical(terms),
      new Date().toISOString(),
    )
    .run();
  // SQL validates shape and relationships; only the server can reconstruct truth.
  await expect(read(f.db, 'owner', consentId, signal())).rejects.toMatchObject({
    status: 503,
  });
  document.contextSha256 = 'f'.repeat(64);
  document.actions.push({ id: '4800', scheduledAt: document.reviewedAt });
  await expect(
    insert(crypto.randomUUID(), document, 'f'.repeat(64)),
  ).rejects.toThrow('Invalid warmup session review');
});
it.each([
  'qualificationTtlMs',
  'minimumGapMs',
  'maxAttemptsPerAction',
  'maxPendingActions',
  'maxQualifications',
] as const)('SQL refuses changed policy %s', async (key) => {
  const value = structuredClone(f.v2Prepared.terms);
  (value.policy as Record<string, number>)[key]++;
  await expect(direct(value)).rejects.toThrow();
});
it.each([
  'executionAllowed',
  'signingAllowed',
  'automaticExecutionAllowed',
] as const)('SQL refuses authority flag %s', async (key) => {
  const value = { ...f.v2Prepared.terms, [key]: true };
  await expect(direct(value)).rejects.toThrow();
});
it('SQL refuses unknown keys, wrong format and excessive approved finish', async () => {
  for (const value of [
    { ...f.v2Prepared.terms, unknown: true },
    {
      ...f.v2Prepared.terms,
      policy: { ...f.v2Prepared.terms.policy, unknown: 1 },
    },
    { ...f.v2Prepared.terms, format: 'wallet-warmup-session-consent-v1' },
    {
      ...f.v2Prepared.terms,
      sessionExpiresAt: new Date(Date.now() + 3600000).toISOString(),
    },
  ])
    await expect(direct(value)).rejects.toThrow();
});
it.each(['plan', 'wallet', 'receipt', 'swap', 'execution'] as const)(
  'refuses changed source or active work: %s',
  async (kind) => {
    if (kind === 'plan')
      await f.db.prepare('UPDATE wallet_warmup_plans SET revision=2').run();
    if (kind === 'wallet')
      await f.db.prepare('UPDATE workspace_wallets SET archived=1').run();
    if (kind === 'receipt')
      await f.db
        .prepare(
          "INSERT INTO warmup_buy_receipts VALUES('owner',?,'new',1,1,1,?,'synthetic','1','{}')",
        )
        .bind(f.plan.id, f.plan.document.addresses[0])
        .run();
    if (kind === 'swap')
      await f.db
        .prepare('INSERT INTO solana_swap_reservations VALUES(?,?,?,?)')
        .bind('owner', 'other', f.plan.document.addresses[0], 'submitted')
        .run();
    if (kind === 'execution')
      await f.db
        .prepare('INSERT INTO solana_execution_reservations VALUES(?,?,?)')
        .bind('owner', f.plan.document.addresses[0], 'submitted')
        .run();
    await expect(retain()).rejects.toThrow();
    expect(
      await f.db
        .prepare('SELECT count(*) AS n FROM wallet_warmup_session_consents_v2')
        .first(),
    ).toEqual({ n: 0 });
  },
);
it.each(['v1-first', 'v2-first'] as const)(
  'isolates policies in both insertion orders: %s',
  async (order) => {
    if (order === 'v1-first') {
      await saveLegacy(f.db, 'owner', f.input, true, signal());
      await expect(
        review(f.db, 'owner', f.selection, signal()),
      ).rejects.toThrow('already has legacy approval');
      await expect(retain()).rejects.toThrow('already has legacy approval');
      await expect(direct()).rejects.toThrow(
        'Versioned warmup policy or approval differs',
      );
      expect(
        await f.db
          .prepare('SELECT count(*) AS n FROM wallet_warmup_session_consents')
          .first(),
      ).toEqual({ n: 1 });
      expect(
        await f.db
          .prepare(
            'SELECT count(*) AS n FROM wallet_warmup_session_consents_v2',
          )
          .first(),
      ).toEqual({ n: 0 });
    } else {
      await retain();
      await expect(
        saveLegacy(f.db, 'owner', f.input, true, signal()),
      ).rejects.toThrow();
      await expect(
        f.db
          .prepare(
            'INSERT INTO wallet_warmup_session_consents VALUES(?,?,?,?,?,?)',
          )
          .bind(
            'owner',
            f.input.id,
            f.input.reviewId,
            f.input.termsSha256,
            canonical(f.prepared.terms),
            new Date().toISOString(),
          )
          .run(),
      ).rejects.toThrow('This review already has versioned warmup approval');
      expect(
        await f.db
          .prepare('SELECT count(*) AS n FROM wallet_warmup_session_consents')
          .first(),
      ).toEqual({ n: 0 });
      expect(
        await f.db
          .prepare(
            'SELECT count(*) AS n FROM wallet_warmup_session_consents_v2',
          )
          .first(),
      ).toEqual({ n: 1 });
    }
  },
);
it.each(['v1-first', 'v2-first'] as const)(
  'refuses cross-policy ID reuse even with different valid review parents: %s',
  async (order) => {
    if (order === 'v1-first') {
      await saveLegacy(f.db, 'owner', f.input, true, signal());
      const next = await anotherReview();
      await expect(
        save(
          f.db,
          'owner',
          {
            ...next.selected,
            id: f.input.id,
            termsSha256: next.v2.termsSha256,
          },
          true,
          signal(),
        ),
      ).rejects.toThrow('already has legacy approval');
      await expect(
        f.db
          .prepare(
            'INSERT INTO wallet_warmup_session_consents_v2 VALUES(?,?,?,?,?,?)',
          )
          .bind(
            'owner',
            f.input.id,
            next.selected.reviewId,
            next.v2.termsSha256,
            canonical(next.v2.terms),
            new Date().toISOString(),
          )
          .run(),
      ).rejects.toThrow('Versioned warmup policy or approval differs');
      expect(
        await f.db
          .prepare(
            'SELECT count(*) AS n FROM wallet_warmup_session_consents_v2',
          )
          .first(),
      ).toEqual({ n: 0 });
    } else {
      await retain();
      const next = await anotherReview();
      await expect(
        f.db
          .prepare(
            'INSERT INTO wallet_warmup_session_consents VALUES(?,?,?,?,?,?)',
          )
          .bind(
            'owner',
            f.v2Input.id,
            next.selected.reviewId,
            next.v1.termsSha256,
            canonical(next.v1.terms),
            new Date().toISOString(),
          )
          .run(),
      ).rejects.toThrow('This review already has versioned warmup approval');
      expect(
        await f.db
          .prepare('SELECT count(*) AS n FROM wallet_warmup_session_consents')
          .first(),
      ).toEqual({ n: 0 });
    }
  },
);
it('recovers the same record after expiry, archive and wallet drift without renewing or writing', async () => {
  const first = await retain();
  vi.setSystemTime(Date.now() + 3600000);
  await f.db.prepare('UPDATE wallet_warmup_plans SET archived=1').run();
  await f.db.prepare('UPDATE workspace_wallets SET revision=2').run();
  expect(await read(f.db, 'owner', first.id, signal())).toEqual(first);
  expect(await retain()).toEqual(first);
  await expect(review(f.db, 'owner', f.selection, signal())).rejects.toThrow(
    'expired',
  );
  expect(await read(f.db, 'other', first.id, signal())).toBeNull();
  expect(
    await f.db
      .prepare('SELECT count(*) AS n FROM wallet_warmup_session_consents_v2')
      .first(),
  ).toEqual({ n: 1 });
});
it('returns the original saved ID for competing identities without a second write', async () => {
  const a = await retain();
  await expect(
    save(
      f.db,
      'owner',
      { ...f.v2Input, id: crypto.randomUUID() },
      true,
      signal(),
    ),
  ).rejects.toMatchObject({ status: 409, recoveryId: a.id });
});
it.each(['lost-reply', 'cancel-after-commit'] as const)(
  'recovers a committed insert without a replacement write: %s',
  async (kind) => {
    const c = new AbortController();
    let inserts = 0;
    const db = interceptInsert(async (statement) => {
      inserts++;
      const result = await statement.run();
      if (kind === 'cancel-after-commit') {
        c.abort();
        return result;
      }
      throw Error('Synthetic lost reply after commit');
    });
    const saved = await save(db, 'owner', f.v2Input, true, c.signal);
    expect(saved.id).toBe(f.v2Input.id);
    expect(inserts).toBe(1);
    expect(
      await f.db
        .prepare('SELECT count(*) AS n FROM wallet_warmup_session_consents_v2')
        .first(),
    ).toEqual({ n: 1 });
  },
);
it('refuses a source race exactly at insertion and never retries the write', async () => {
  let inserts = 0;
  const db = interceptInsert(async (statement) => {
    inserts++;
    await f.db.prepare('UPDATE wallet_warmup_plans SET revision=2').run();
    return statement.run();
  });
  await expect(save(db, 'owner', f.v2Input, true, signal())).rejects.toThrow(
    'could not be confirmed',
  );
  expect(inserts).toBe(1);
  expect(
    await f.db
      .prepare('SELECT count(*) AS n FROM wallet_warmup_session_consents_v2')
      .first(),
  ).toEqual({ n: 0 });
});
it('reports a definite legacy-policy race rather than an uncertain save outcome', async () => {
  const db = interceptInsert(async (statement) => {
    await saveLegacy(f.db, 'owner', f.input, true, signal());
    return statement.run();
  });
  await expect(save(db, 'owner', f.v2Input, true, signal())).rejects.toThrow(
    'already has legacy approval',
  );
  expect(
    await f.db
      .prepare('SELECT count(*) AS n FROM wallet_warmup_session_consents_v2')
      .first(),
  ).toEqual({ n: 0 });
});
it('refuses changed reuse of an ID and direct update/delete/replace', async () => {
  await retain();
  await expect(
    save(
      f.db,
      'owner',
      { ...f.v2Input, termsSha256: 'a'.repeat(64) },
      true,
      signal(),
    ),
  ).rejects.toThrow();
  await expect(
    f.db
      .prepare('UPDATE wallet_warmup_session_consents_v2 SET terms_sha256=?')
      .bind('a'.repeat(64))
      .run(),
  ).rejects.toThrow();
  await expect(
    f.db.prepare('DELETE FROM wallet_warmup_session_consents_v2').run(),
  ).rejects.toThrow();
  await expect(
    f.db
      .prepare(
        'INSERT OR REPLACE INTO wallet_warmup_session_consents_v2 SELECT * FROM wallet_warmup_session_consents_v2',
      )
      .run(),
  ).rejects.toThrow();
});
it('fails closed when policy storage guards are absent and before SQL on cancellation', async () => {
  const c = new AbortController();
  c.abort();
  await expect(
    save(f.db, 'owner', f.v2Input, true, c.signal),
  ).rejects.toThrow();
  await f.db
    .prepare('DROP TRIGGER wallet_warmup_session_consents_v2_policy')
    .run();
  await expect(retain()).rejects.toMatchObject({ status: 503 });
});
