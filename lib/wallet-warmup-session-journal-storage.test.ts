import { afterEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { warmupSessionConsentFixture } from '@/test/warmup-session-consent-fixture';
import { retainWalletWarmupSessionConsent } from './wallet-warmup-session-consent';
import {
  retainWalletWarmupSessionJournal as retain,
  readWalletWarmupSessionJournal as read,
  appendWalletWarmupSessionJournal as append,
} from './wallet-warmup-session-journal-storage';
import { walletWarmupSessionDigest as digest } from './wallet-warmup-session-digest';
const signal = () => new AbortController().signal;
const clients: { close(): void }[] = [];
afterEach(() => {
  for (const client of clients.splice(0)) client.close();
  vi.unstubAllGlobals();
});
async function fixture() {
  const f = await warmupSessionConsentFixture();
  clients.push(f.client);
  for (const sql of readFileSync(
    'drizzle/0124_wallet_warmup_session_journals.sql',
    'utf8',
  )
    .split('--> statement-breakpoint')
    .map((v) => v.trim())
    .filter(Boolean))
    await f.db.prepare(sql).run();
  const consent = await retainWalletWarmupSessionConsent(
    f.db,
    'owner',
    f.input,
    true,
    signal(),
  );
  const input = {
    id: crypto.randomUUID(),
    consentId: consent.id,
    termsSha256: consent.termsSha256,
  };
  const saved = await retain(f.db, 'owner', input, true, signal());
  const command = (operation: string, extra = {}, state = saved) => ({
    id: crypto.randomUUID(),
    journalId: input.id,
    expectedVersion: state.version,
    expectedHeadSha256: state.headSha256,
    command: { operation, ...extra },
  });
  return { ...f, consent, input, saved, command };
}
it('retains exactly one immutable owner-bound recovery root without execution authority', async () => {
  const f = await fixture();
  expect(f.saved).toMatchObject({
    id: f.input.id,
    consentId: f.consent.id,
    version: 0,
    recoveryRequired: false,
    executionAllowed: false,
    signingAllowed: false,
    automaticExecutionAllowed: false,
  });
  expect(await retain(f.db, 'owner', f.input, true, signal())).toEqual(f.saved);
  expect(await read(f.db, 'other', f.input.id, signal())).toBeNull();
  expect(
    (
      await f.db
        .prepare('SELECT count(*) AS n FROM wallet_warmup_session_journals')
        .first<{ n: number }>()
    )?.n,
  ).toBe(1);
});
it('requires explicit recording and the exact immutable consent binding', async () => {
  const f = await fixture();
  await expect(retain(f.db, 'owner', f.input, false, signal())).rejects.toThrow(
    'explicit',
  );
  await expect(
    retain(
      f.db,
      'owner',
      { ...f.input, termsSha256: 'a'.repeat(64) },
      true,
      signal(),
    ),
  ).rejects.toThrow();
  await expect(
    retain(
      f.db,
      'owner',
      { ...f.input, consentId: crypto.randomUUID() },
      true,
      signal(),
    ),
  ).rejects.toThrow();
  await expect(
    retain(
      f.db,
      'other',
      { ...f.input, id: crypto.randomUUID() },
      true,
      signal(),
    ),
  ).rejects.toThrow();
});
it('persists pause/resume/stop through authoritative reads without changing the original deadline', async () => {
  const f = await fixture();
  let state = f.saved;
  for (const operation of ['pause', 'resume', 'stop'])
    state = await append(
      f.db,
      'owner',
      f.command(operation, {}, state),
      signal(),
    );
  expect(state).toMatchObject({
    version: 3,
    snapshot: { stopped: true, phase: 'stopped' },
  });
  expect(state.snapshot.sourceReviewExpiresAt).toBe(
    f.saved.snapshot.sourceReviewExpiresAt,
  );
  expect((await read(f.db, 'owner', f.input.id, signal()))?.snapshot).toEqual(
    state.snapshot,
  );
  await expect(
    append(f.db, 'owner', f.command('resume', {}, state), signal()),
  ).rejects.toThrow();
});
it('retains the exact unknown action identity across expiry and does not open a replacement', async () => {
  const f = await fixture();
  const actionId =
    f.saved.snapshot.nextReviewAt &&
    JSON.parse(f.saved.sourceDocument).review.actions[0].id;
  let state = await append(
    f.db,
    'owner',
    f.command('begin-review', { actionId }),
    signal(),
  );
  state = await append(
    f.db,
    'owner',
    f.command('submitted', { actionId }, state),
    signal(),
  );
  state = await append(
    f.db,
    'owner',
    f.command('unknown', { actionId }, state),
    signal(),
  );
  const recovered = await read(
    f.db,
    'owner',
    f.input.id,
    signal(),
    Date.parse(state.snapshot.sourceReviewExpiresAt) + 1,
  );
  expect(recovered).toMatchObject({
    version: 3,
    recoveryRequired: true,
    snapshot: {
      phase: 'recovery-required',
      sourceReviewFresh: false,
      pending: { state: 'unknown', action: { id: actionId } },
    },
  });
  await expect(
    append(
      f.db,
      'owner',
      f.command('begin-review', { actionId }, state),
      signal(),
    ),
  ).rejects.toThrow();
});
it('admits at most one competing append against the same predecessor', async () => {
  const f = await fixture();
  const outcomes = await Promise.allSettled([
    append(f.db, 'owner', f.command('pause'), signal()),
    append(f.db, 'owner', f.command('stop'), signal()),
  ]);
  expect(outcomes.filter((v) => v.status === 'fulfilled')).toHaveLength(1);
  const saved = await read(f.db, 'owner', f.input.id, signal());
  expect(saved?.version).toBe(1);
  expect(saved?.events).toHaveLength(1);
});
it('recovers the same event after a committed response was lost, without a second INSERT', async () => {
  const f = await fixture();
  const request = f.command('pause');
  let inserts = 0;
  const wrapped = {
    batch: f.db.batch.bind(f.db),
    prepare(sql: string) {
      const original = f.db.prepare(sql);
      if (!sql.startsWith('INSERT INTO wallet_warmup_session_journal_events'))
        return original;
      return {
        bind(...args: unknown[]) {
          const bound = original.bind(...args);
          return {
            async run() {
              inserts++;
              await bound.run();
              throw Error('Lost response');
            },
          };
        },
      };
    },
  } as D1Database;
  const saved = await append(wrapped, 'owner', request, signal());
  expect(saved.version).toBe(1);
  expect(inserts).toBe(1);
  const recovered = await append(wrapped, 'owner', request, signal());
  expect(recovered.events).toEqual(saved.events);
  expect(inserts).toBe(1);
  await expect(
    append(
      f.db,
      'owner',
      { ...request, command: { operation: 'stop' } },
      signal(),
    ),
  ).rejects.toThrow();
});
it('preserves a committed event through cancellation and permits same-ID read recovery', async () => {
  const f = await fixture();
  const controller = new AbortController();
  const request = f.command('pause');
  let inserts = 0;
  const wrapped = {
    batch: f.db.batch.bind(f.db),
    prepare(sql: string) {
      const original = f.db.prepare(sql);
      if (!sql.startsWith('INSERT INTO wallet_warmup_session_journal_events'))
        return original;
      return {
        bind(...args: unknown[]) {
          const bound = original.bind(...args);
          return {
            async run() {
              inserts++;
              const result = await bound.run();
              controller.abort();
              return result;
            },
          };
        },
      };
    },
  } as D1Database;
  await expect(
    append(wrapped, 'owner', request, controller.signal),
  ).rejects.toThrow();
  expect(inserts).toBe(1);
  const saved = await read(f.db, 'owner', f.input.id, signal());
  expect(saved?.events[0].id).toBe(request.id);
  expect(saved?.version).toBe(1);
});
it('cannot substitute a different journal or reuse a stale predecessor', async () => {
  const f = await fixture();
  const request = f.command('pause');
  await append(f.db, 'owner', request, signal());
  await expect(
    append(f.db, 'owner', f.command('stop'), signal()),
  ).rejects.toThrow();
  await expect(append(f.db, 'other', request, signal())).rejects.toThrow();
  await expect(
    append(
      f.db,
      'owner',
      { ...request, journalId: crypto.randomUUID() },
      signal(),
    ),
  ).rejects.toThrow();
});
it.each(['at', 'version', 'previousSha256', 'executionAllowed', 'owner'])(
  'refuses caller override %s without an INSERT',
  async (key) => {
    const f = await fixture();
    await expect(
      append(f.db, 'owner', f.command('pause', { [key]: true }), signal()),
    ).rejects.toThrow();
    expect((await read(f.db, 'owner', f.input.id, signal()))?.version).toBe(0);
  },
);
it('blocks direct SQL rewrites, deletions, replacement and skipped predecessors', async () => {
  const f = await fixture();
  const saved = await append(f.db, 'owner', f.command('pause'), signal());
  for (const table of [
    'wallet_warmup_session_journals',
    'wallet_warmup_session_journal_events',
  ]) {
    await expect(
      f.db.prepare(`UPDATE ${table} SET created_at=created_at`).run(),
    ).rejects.toThrow('immutable');
    await expect(f.db.prepare(`DELETE FROM ${table}`).run()).rejects.toThrow(
      'immutable',
    );
    await expect(
      f.db
        .prepare(`INSERT OR REPLACE INTO ${table} SELECT * FROM ${table}`)
        .run(),
    ).rejects.toThrow();
  }
  const event = JSON.parse(saved.events[0].document);
  event.version = 3;
  event.previousSha256 = saved.headSha256;
  event.eventId = crypto.randomUUID();
  const doc = JSON.stringify(event);
  await expect(
    f.db
      .prepare(
        'INSERT INTO wallet_warmup_session_journal_events VALUES(?,?,?,?,?,?,?,?)',
      )
      .bind(
        'owner',
        f.input.id,
        event.eventId,
        3,
        saved.headSha256,
        doc,
        await digest(doc),
        event.at,
      )
      .run(),
  ).rejects.toThrow('predecessor');
});
it('withholds recovery when immutable guards are missing', async () => {
  const f = await fixture();
  await f.db
    .prepare('DROP TRIGGER wallet_warmup_session_journal_events_no_delete')
    .run();
  await expect(read(f.db, 'owner', f.input.id, signal())).rejects.toThrow(
    'not installed',
  );
});
it('detects corrupt event bytes after an out-of-band guard bypass', async () => {
  const f = await fixture();
  await append(f.db, 'owner', f.command('pause'), signal());
  await f.db
    .prepare('DROP TRIGGER wallet_warmup_session_journal_events_no_update')
    .run();
  await f.db
    .prepare(
      "UPDATE wallet_warmup_session_journal_events SET document=document||' '",
    )
    .run();
  await f.db
    .prepare(
      "CREATE TRIGGER wallet_warmup_session_journal_events_no_update BEFORE UPDATE ON wallet_warmup_session_journal_events BEGIN SELECT RAISE(ABORT,'immutable'); END",
    )
    .run();
  await expect(read(f.db, 'owner', f.input.id, signal())).rejects.toThrow(
    'unavailable or differs',
  );
});
it('cannot open a second recovery root under a different ID for the same consent', async () => {
  const f = await fixture();
  await expect(
    retain(
      f.db,
      'owner',
      { ...f.input, id: crypto.randomUUID() },
      true,
      signal(),
    ),
  ).rejects.toThrow();
  expect(
    (
      await f.db
        .prepare('SELECT count(*) AS n FROM wallet_warmup_session_journals')
        .first<{ n: number }>()
    )?.n,
  ).toBe(1);
});

it('refuses a finalized label through both the service and direct SQL', async () => {
  const f = await fixture();
  await expect(
    append(
      f.db,
      'owner',
      f.command('finalized', {
        actionId: 'fake',
        settlement: { verified: true },
      }),
      signal(),
    ),
  ).rejects.toThrow();
  const at = new Date().toISOString();
  const eventId = crypto.randomUUID();
  const document = JSON.stringify({
    eventId,
    version: 1,
    previousSha256: f.saved.headSha256,
    at,
    operation: 'finalized',
    actionId: 'fake',
    settlement: { verified: true },
  });
  await expect(
    f.db
      .prepare(
        'INSERT INTO wallet_warmup_session_journal_events VALUES(?,?,?,?,?,?,?,?)',
      )
      .bind(
        'owner',
        f.input.id,
        eventId,
        1,
        f.saved.headSha256,
        document,
        await digest(document),
        at,
      )
      .run(),
  ).rejects.toThrow();
  expect((await read(f.db, 'owner', f.input.id, signal()))?.version).toBe(0);
});

it.each(['version', 'previous_sha256', 'created_at', 'id'])(
  'refuses corrupt event metadata %s after an out-of-band guard bypass',
  async (field) => {
    const f = await fixture();
    await append(f.db, 'owner', f.command('pause'), signal());
    await f.db
      .prepare('DROP TRIGGER wallet_warmup_session_journal_events_no_update')
      .run();
    const value =
      field === 'id'
        ? crypto.randomUUID()
        : field === 'version'
          ? 100
          : field === 'previous_sha256'
            ? 'a'.repeat(64)
            : '2026-01-01T00:00:00.000Z';
    await f.db
      .prepare(`UPDATE wallet_warmup_session_journal_events SET ${field}=?`)
      .bind(value)
      .run();
    await f.db
      .prepare(
        "CREATE TRIGGER wallet_warmup_session_journal_events_no_update BEFORE UPDATE ON wallet_warmup_session_journal_events BEGIN SELECT RAISE(ABORT,'immutable'); END",
      )
      .run();
    await expect(read(f.db, 'owner', f.input.id, signal())).rejects.toThrow(
      'unavailable or differs',
    );
  },
);

it('recovers a root whose INSERT committed before its response was lost', async () => {
  // An independent disposable database has no journal yet; intercept only its INSERT.
  const g = await warmupSessionConsentFixture();
  clients.push(g.client);
  for (const sql of readFileSync(
    'drizzle/0124_wallet_warmup_session_journals.sql',
    'utf8',
  )
    .split('--> statement-breakpoint')
    .map((v) => v.trim())
    .filter(Boolean))
    await g.db.prepare(sql).run();
  const consent = await retainWalletWarmupSessionConsent(
    g.db,
    'owner',
    g.input,
    true,
    signal(),
  );
  const input = {
    id: crypto.randomUUID(),
    consentId: consent.id,
    termsSha256: consent.termsSha256,
  };
  let inserts = 0;
  const wrapped = {
    batch: g.db.batch.bind(g.db),
    prepare(sql: string) {
      const original = g.db.prepare(sql);
      if (!sql.startsWith('INSERT INTO wallet_warmup_session_journals('))
        return original;
      return {
        bind(...args: unknown[]) {
          const bound = original.bind(...args);
          return {
            async run() {
              inserts++;
              await bound.run();
              throw Error('Lost root response');
            },
          };
        },
      };
    },
  } as D1Database;
  expect((await retain(wrapped, 'owner', input, true, signal())).id).toBe(
    input.id,
  );
  expect((await retain(wrapped, 'owner', input, true, signal())).id).toBe(
    input.id,
  );
  expect(inserts).toBe(1);
});

it('atomically refuses one of two validated writers released at the INSERT boundary', async () => {
  const f = await fixture();
  let arrivals = 0;
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const wrapped = {
    batch: f.db.batch.bind(f.db),
    prepare(sql: string) {
      const original = f.db.prepare(sql);
      if (!sql.startsWith('INSERT INTO wallet_warmup_session_journal_events'))
        return original;
      return {
        bind(...args: unknown[]) {
          const bound = original.bind(...args);
          return {
            async run() {
              if (++arrivals === 2) release();
              await gate;
              return bound.run();
            },
          };
        },
      };
    },
  } as D1Database;
  const results = await Promise.allSettled([
    append(wrapped, 'owner', f.command('pause'), signal()),
    append(wrapped, 'owner', f.command('stop'), signal()),
  ]);
  expect(arrivals).toBe(2);
  expect(results.filter((v) => v.status === 'fulfilled')).toHaveLength(1);
  expect((await read(f.db, 'owner', f.input.id, signal()))?.version).toBe(1);
});

it('does not retry an event INSERT when the write outcome is unknown and its ID is absent', async () => {
  const f = await fixture();
  let inserts = 0;
  const wrapped = {
    batch: f.db.batch.bind(f.db),
    prepare(sql: string) {
      if (!sql.startsWith('INSERT INTO wallet_warmup_session_journal_events'))
        return f.db.prepare(sql);
      return {
        bind() {
          return {
            async run() {
              inserts++;
              throw Error('Connection lost');
            },
          };
        },
      };
    },
  } as D1Database;
  await expect(
    append(wrapped, 'owner', f.command('pause'), signal()),
  ).rejects.toThrow('Recover its original ID');
  expect(inserts).toBe(1);
  expect((await read(f.db, 'owner', f.input.id, signal()))?.version).toBe(0);
});

it('detects a missing tail event against the separately retained head', async () => {
  const f = await fixture();
  await append(f.db, 'owner', f.command('pause'), signal());
  await f.db
    .prepare('DROP TRIGGER wallet_warmup_session_journal_events_no_delete')
    .run();
  await f.db.prepare('DELETE FROM wallet_warmup_session_journal_events').run();
  await f.db
    .prepare(
      "CREATE TRIGGER wallet_warmup_session_journal_events_no_delete BEFORE DELETE ON wallet_warmup_session_journal_events BEGIN SELECT RAISE(ABORT,'immutable'); END",
    )
    .run();
  await expect(read(f.db, 'owner', f.input.id, signal())).rejects.toThrow(
    'unavailable or differs',
  );
});

it('protects the head against direct replacement, advancement, rewinding and deletion', async () => {
  const f = await fixture();
  const saved = await append(f.db, 'owner', f.command('pause'), signal());
  await expect(
    f.db.prepare('DELETE FROM wallet_warmup_session_journal_heads').run(),
  ).rejects.toThrow('retained');
  await expect(
    f.db
      .prepare(
        'INSERT OR REPLACE INTO wallet_warmup_session_journal_heads SELECT * FROM wallet_warmup_session_journal_heads',
      )
      .run(),
  ).rejects.toThrow();
  await expect(
    f.db
      .prepare(
        'UPDATE wallet_warmup_session_journal_heads SET version=version+1',
      )
      .run(),
  ).rejects.toThrow();
  await expect(
    f.db
      .prepare(
        'UPDATE wallet_warmup_session_journal_heads SET version=0,head_sha256=?',
      )
      .bind(f.saved.headSha256)
      .run(),
  ).rejects.toThrow();
  expect((await read(f.db, 'owner', f.input.id, signal()))?.headSha256).toBe(
    saved.headSha256,
  );
});

it('rolls back the event if advancing its head fails in the same INSERT transaction', async () => {
  const f = await fixture();
  await f.db
    .prepare(
      "CREATE TRIGGER test_head_failure BEFORE UPDATE ON wallet_warmup_session_journal_heads BEGIN SELECT RAISE(ABORT,'fixture head failure'); END",
    )
    .run();
  await expect(
    append(f.db, 'owner', f.command('pause'), signal()),
  ).rejects.toThrow();
  expect((await read(f.db, 'owner', f.input.id, signal()))?.version).toBe(0);
  expect(
    (
      await f.db
        .prepare(
          'SELECT count(*) AS n FROM wallet_warmup_session_journal_events',
        )
        .first<{ n: number }>()
    )?.n,
  ).toBe(0);
});

it('refuses a begin-review INSERT when the database sees an expired source', async () => {
  const f = await fixture();
  // Isolate the SQL wall-clock guard by changing only its deadline input after
  // bypassing/restoring the root update guard. This is not a valid recovered root.
  await f.db
    .prepare('DROP TRIGGER wallet_warmup_session_journals_no_update')
    .run();
  await f.db
    .prepare(
      "UPDATE wallet_warmup_session_journals SET source_document=json_set(source_document,'$.reviewExpiresAt','2000-01-01T00:00:00.000Z')",
    )
    .run();
  await f.db
    .prepare(
      "CREATE TRIGGER wallet_warmup_session_journals_no_update BEFORE UPDATE ON wallet_warmup_session_journals BEGIN SELECT RAISE(ABORT,'immutable'); END",
    )
    .run();
  const eventId = crypto.randomUUID();
  const at = new Date().toISOString();
  const document = JSON.stringify({
    eventId,
    version: 1,
    previousSha256: f.saved.headSha256,
    at,
    operation: 'begin-review',
    actionId: JSON.parse(f.saved.sourceDocument).review.actions[0].id,
  });
  await expect(
    f.db
      .prepare(
        'INSERT INTO wallet_warmup_session_journal_events VALUES(?,?,?,?,?,?,?,?)',
      )
      .bind(
        'owner',
        f.input.id,
        eventId,
        1,
        f.saved.headSha256,
        document,
        await digest(document),
        at,
      )
      .run(),
  ).rejects.toThrow('predecessor');
  expect(
    (
      await f.db
        .prepare(
          'SELECT count(*) AS n FROM wallet_warmup_session_journal_events',
        )
        .first<{ n: number }>()
    )?.n,
  ).toBe(0);
});

it('rechecks source expiry after asynchronous begin-review replay before inserting', async () => {
  const f = await fixture();
  const actionId = JSON.parse(f.saved.sourceDocument).review.actions[0].id;
  const expires = Date.parse(f.saved.snapshot.sourceReviewExpiresAt);
  let calls = 0;
  const clock = () => (++calls < 3 ? expires - 1 : expires);
  await expect(
    append(
      f.db,
      'owner',
      f.command('begin-review', { actionId }),
      signal(),
      clock,
    ),
  ).rejects.toThrow();
  expect((await read(f.db, 'owner', f.input.id, signal()))?.version).toBe(0);
});
