import { expect, it, vi } from 'vitest';
import { warmupV2RuntimeFixture } from '@/test/warmup-session-v2-runtime-fixture';
import { warmupV2AttemptProviderFixture } from '@/test/warmup-session-v2-attempt-provider-fixture';
import { installWarmupRuntime } from '@/test/warmup-session-v2-runtime-fixture';
import { warmupPurposeInsert } from './wallet-warmup-session-v2-runtime-storage';
import { WalletRpcError } from './wallet-balances';
import {
  prepareWalletWarmupV2RuntimeAttempt as prepare,
  readWalletWarmupV2RuntimeAttempt as read,
  publicWalletWarmupV2RuntimeAttempt as project,
  prepareWalletWarmupV2Attempt as preview,
} from './wallet-warmup-session-v2-attempts';
const signal = () => new AbortController().signal;
it('connects the actual runtime provider, immutable purpose and atomic sidecar to saved-only recovery', async () => {
  const f = await warmupV2RuntimeFixture();
  try {
    const input = f.selection();
    const saved = await prepare(
      f.db,
      'owner',
      input,
      true,
      signal(),
      'synthetic-key',
      f.factory,
    );
    expect(saved.outcome?.kind).toBe('prepared');
    const recovered = await read(f.db, 'owner', input.id, signal());
    expect(recovered?.runtime.observation).toBeTruthy();
    expect(f.factory).toHaveBeenCalledOnce();
    expect(f.raw.prepare).toHaveBeenCalledOnce();
    expect(
      f.raw.rpc.mock.calls.filter(
        ([method]) => method === 'simulateTransaction',
      ),
    ).toHaveLength(1);
    const value = project(recovered!);
    expect(value.runtime).toMatchObject({
      mode: 'runtime-observation-v1',
      observation: { codeScans: 2, referenceMinimum: 'order-self' },
      signingAllowed: false,
      executionAllowed: false,
      automaticExecutionAllowed: false,
    });
    expect(value.runtime.effectiveExpiresAt).toBe(
      value.runtime.observation!.expiresAt,
    );
    expect(saved.summary!.simulation).toMatchObject({
      routeStatus: 'Unavailable',
      bindingStatus: 'Unavailable',
    });
    expect(JSON.stringify(value)).not.toContain(
      saved.outcome!.unsigned_transaction,
    );
    await f.control('stop');
    const later = await read(f.db, 'owner', input.id, signal());
    expect(later?.runtime).toEqual(recovered?.runtime);
    expect(later?.attempt.journal.snapshot.phase).toBe('stopped');
    await prepare(f.db, 'owner', input, true, signal(), undefined, f.factory);
    expect(f.factory).toHaveBeenCalledOnce();
    await expect(
      preview(f.db, 'owner', input, true, signal(), 'synthetic-key'),
    ).rejects.toMatchObject({ status: 409 });
    expect(await read(f.db, 'other', input.id, signal())).toBeNull();
  } finally {
    f.client.close();
  }
});

async function counts(db: D1Database) {
  return Promise.all(
    [
      'wallet_warmup_session_v2_attempt_purposes',
      'wallet_warmup_session_v2_attempts',
      'wallet_warmup_session_v2_attempt_outcomes',
      'wallet_warmup_session_v2_runtime_observations',
    ].map(
      async (t) =>
        (await db
          .prepare(`SELECT count(*) AS n FROM ${t}`)
          .first<{ n: number }>())!.n,
    ),
  );
}
const native = (statement: D1PreparedStatement) =>
  statement as unknown as { sql: string; args: unknown[] };
const withBatch = (db: D1Database, batch: D1Database['batch']) =>
  Object.assign(Object.create(db) as D1Database, { batch });
function withFirst(
  db: D1Database,
  change: (sql: string, row: unknown) => unknown,
): D1Database {
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement =>
    Object.assign(Object.create(statement) as D1PreparedStatement, {
      bind: (...args: unknown[]) => wrap(statement.bind(...args)),
      first: async <T>() =>
        change(native(statement).sql, await statement.first()) as T | null,
    });
  return Object.assign(Object.create(db) as D1Database, {
    prepare: (sql: string) => wrap(db.prepare(sql)),
  });
}
it('re-reads a result committed between the outcome and sidecar reads without rerunning providers', async () => {
  const f = await warmupV2RuntimeFixture();
  try {
    const input = f.selection();
    await prepare(
      f.db,
      'owner',
      input,
      true,
      signal(),
      'synthetic-key',
      f.factory,
    );
    let stale = 1;
    const db = withFirst(f.db, (sql, row) =>
      sql.startsWith(
        'SELECT * FROM wallet_warmup_session_v2_attempt_outcomes',
      ) && stale-- > 0
        ? null
        : row,
    );
    expect(
      (await read(db, 'owner', input.id, signal()))?.attempt.outcome?.kind,
    ).toBe('prepared');
    expect(f.factory).toHaveBeenCalledOnce();
    const inconsistent = withFirst(f.db, (sql, row) =>
      sql.startsWith('SELECT * FROM wallet_warmup_session_v2_attempt_outcomes')
        ? null
        : row,
    );
    await expect(
      read(inconsistent, 'owner', input.id, signal()),
    ).rejects.toMatchObject({ status: 503 });
    expect(f.factory).toHaveBeenCalledOnce();
  } finally {
    f.client.close();
  }
});
it('malformed saved purpose, row and document are storage errors rather than client errors', async () => {
  const f = await warmupV2RuntimeFixture();
  try {
    const input = f.selection();
    await prepare(
      f.db,
      'owner',
      input,
      true,
      signal(),
      'synthetic-key',
      f.factory,
    );
    for (const target of ['purpose', 'row', 'document']) {
      const db = withFirst(f.db, (sql, row) => {
        if (!row) return row;
        if (
          target === 'purpose' &&
          sql.startsWith(
            'SELECT * FROM wallet_warmup_session_v2_attempt_purposes',
          )
        )
          return { ...(row as object), mode: 'invalid' };
        if (
          sql.startsWith(
            'SELECT * FROM wallet_warmup_session_v2_runtime_observations',
          )
        )
          return target === 'row'
            ? { ...(row as object), created_at: 'invalid' }
            : target === 'document'
              ? { ...(row as object), document: '{}' }
              : row;
        return row;
      });
      await expect(read(db, 'owner', input.id, signal())).rejects.toMatchObject(
        { status: 503 },
      );
    }
    expect(f.factory).toHaveBeenCalledOnce();
  } finally {
    f.client.close();
  }
});
it('refuses incomplete schema and disabled foreign-key enforcement before provider work', async () => {
  const f = await warmupV2RuntimeFixture();
  try {
    const input = f.selection();
    await f.client.execute('PRAGMA foreign_keys=OFF');
    await expect(
      prepare(f.db, 'owner', input, true, signal(), 'synthetic-key', f.factory),
    ).rejects.toMatchObject({ status: 503 });
    await f.client.execute('PRAGMA foreign_keys=ON');
    await f.db.prepare('DROP TRIGGER warmup_v2_runtime_insert').run();
    await expect(
      prepare(f.db, 'owner', input, true, signal(), 'synthetic-key', f.factory),
    ).rejects.toMatchObject({ status: 503 });
    expect(f.factory).not.toHaveBeenCalled();
  } finally {
    f.client.close();
  }
});
it('a purpose cannot commit without its lease, and deferred failure rolls it back', async () => {
  const f = await warmupV2RuntimeFixture();
  try {
    const input = f.selection(),
      statement = await warmupPurposeInsert(
        f.db,
        'owner',
        input,
        f.v2Journal.termsSha256,
        'runtime',
      );
    await expect(f.db.batch([statement])).rejects.toThrow(/foreign key/i);
    expect(await counts(f.db)).toEqual([0, 0, 0, 0]);
  } finally {
    f.client.close();
  }
});
it('recovers an unknown purpose/lease commit without executing a provider', async () => {
  const f = await warmupV2RuntimeFixture();
  try {
    const input = f.selection();
    let lost = true;
    const db = withBatch(f.db, async <T>(statements: D1PreparedStatement[]) => {
      const rows = await f.db.batch<T>(statements);
      if (
        lost &&
        native(statements[0]).sql.includes(
          'INSERT INTO wallet_warmup_session_v2_attempt_purposes',
        )
      ) {
        lost = false;
        throw Error('synthetic lost acknowledgement');
      }
      return rows;
    });
    const saved = await prepare(
      db,
      'owner',
      input,
      true,
      signal(),
      'synthetic-key',
      f.factory,
    );
    expect(saved.outcome).toBeNull();
    expect(await counts(f.db)).toEqual([1, 1, 0, 0]);
    expect(f.factory).not.toHaveBeenCalled();
    await prepare(db, 'owner', input, true, signal(), undefined, f.factory);
    expect(f.factory).not.toHaveBeenCalled();
  } finally {
    f.client.close();
  }
});
for (const failure of [
  'second-statement',
  'sidecar-only',
  'outcome-only',
] as const)
  it(`atomically rejects ${failure} publication and never repeats its provider`, async () => {
    const f = await warmupV2RuntimeFixture();
    try {
      const input = f.selection();
      let errorText = '';
      const db = withBatch(
        f.db,
        async <T>(statements: D1PreparedStatement[]) => {
          if (
            native(statements[0]).sql.includes(
              'INSERT INTO wallet_warmup_session_v2_runtime_observations',
            )
          ) {
            const last = native(statements[1]),
              args = [...last.args];
            args[10] = 'f'.repeat(64);
            const changed =
              failure === 'second-statement'
                ? [statements[0], f.db.prepare(last.sql).bind(...args)]
                : failure === 'sidecar-only'
                  ? [statements[0]]
                  : [statements[1]];
            try {
              return await f.db.batch<T>(changed);
            } catch (error) {
              errorText = String(error);
              throw error;
            }
          }
          return f.db.batch<T>(statements);
        },
      );
      const saved = await prepare(
        db,
        'owner',
        input,
        true,
        signal(),
        'synthetic-key',
        f.factory,
      );
      expect(saved.outcome).toBeNull();
      expect(errorText).toMatch(
        failure === 'sidecar-only'
          ? /foreign key/i
          : /matching atomic observations/,
      );
      expect(await counts(f.db)).toEqual([1, 1, 0, 0]);
      expect(f.factory).toHaveBeenCalledOnce();
      await prepare(db, 'owner', input, true, signal(), undefined, f.factory);
      expect(f.factory).toHaveBeenCalledOnce();
    } finally {
      f.client.close();
    }
  });
for (const field of [
  'signingAllowed',
  'programCodeAttested',
  'nested-signing',
  'code-vector',
  'wallet',
] as const)
  it(`SQL refuses a forged ${field} observation and rolls both result rows back`, async () => {
    const f = await warmupV2RuntimeFixture();
    try {
      let rejected = '';
      const db = withBatch(
        f.db,
        async <T>(statements: D1PreparedStatement[]) => {
          if (
            native(statements[0]).sql.includes(
              'INSERT INTO wallet_warmup_session_v2_runtime_observations',
            )
          ) {
            const first = native(statements[0]),
              args = [...first.args],
              doc = JSON.parse(String(args[4]));
            if (field === 'nested-signing') doc.runtime.signingAllowed = true;
            else if (field === 'code-vector')
              doc.codeScans[1][0].codeSha256 = '0'.repeat(64);
            else if (field === 'wallet')
              doc.wallet = '11111111111111111111111111111111';
            else doc[field] = 0;
            args[4] = JSON.stringify(doc);
            try {
              return await f.db.batch<T>([
                f.db.prepare(first.sql).bind(...args),
                statements[1],
              ]);
            } catch (error) {
              rejected = String(error);
              throw error;
            }
          }
          return f.db.batch<T>(statements);
        },
      );
      const saved = await prepare(
        db,
        'owner',
        f.selection(),
        true,
        signal(),
        'synthetic-key',
        f.factory,
      );
      expect(saved.outcome).toBeNull();
      expect(rejected).toContain('runtime observation expired or changed');
      expect(await counts(f.db)).toEqual([1, 1, 0, 0]);
    } finally {
      f.client.close();
    }
  });
it('keeps pre-migration previews readable and permanently refuses retrofitting a runtime purpose', async () => {
  const f = await warmupV2AttemptProviderFixture();
  try {
    const { previewRequested: _approved, ...input } = f.input();
    const saved = await preview(
      f.db,
      'owner',
      input,
      true,
      signal(),
      'synthetic-key',
      () => async () => {
        throw Error('synthetic refusal');
      },
    );
    expect(saved.outcome?.kind).toBe('refused');
    await installWarmupRuntime(f.db);
    await expect(
      prepare(f.db, 'owner', input, true, signal(), 'synthetic-key'),
    ).rejects.toMatchObject({ status: 409 });
    const purpose = await warmupPurposeInsert(
      f.db,
      'owner',
      input,
      f.v2Journal.termsSha256,
      'runtime',
    );
    await expect(f.db.batch([purpose])).rejects.toThrow(
      'purpose is unavailable',
    );
    expect(
      (await preview(f.db, 'owner', input, true, signal(), undefined)).outcome,
    ).toEqual(saved.outcome);
  } finally {
    f.client.close();
  }
});
it('new previews have an immutable preview purpose and cannot change modes', async () => {
  const f = await warmupV2RuntimeFixture();
  try {
    const input = f.selection(),
      factory = vi.fn(() => async () => {
        throw Error('synthetic refusal');
      });
    await preview(
      f.db,
      'owner',
      input,
      true,
      signal(),
      'synthetic-key',
      factory,
    );
    expect(await counts(f.db)).toEqual([1, 1, 1, 0]);
    await expect(
      prepare(f.db, 'owner', input, true, signal(), 'synthetic-key', f.factory),
    ).rejects.toMatchObject({ status: 409 });
    expect(f.factory).not.toHaveBeenCalled();
  } finally {
    f.client.close();
  }
});
it('concurrent same-ID runtime requests produce one provider invocation', async () => {
  const f = await warmupV2RuntimeFixture();
  try {
    const input = f.selection(),
      results = await Promise.all([
        prepare(
          f.db,
          'owner',
          input,
          true,
          signal(),
          'synthetic-key',
          f.factory,
        ),
        prepare(
          f.db,
          'owner',
          input,
          true,
          signal(),
          'synthetic-key',
          f.factory,
        ),
      ]);
    expect(results.every((r) => r.lease.id === input.id)).toBe(true);
    expect(f.factory).toHaveBeenCalledOnce();
    expect(await counts(f.db)).toEqual([1, 1, 1, 1]);
  } finally {
    f.client.close();
  }
});
it('a429 is retained once and the shared cooldown blocks switching to preview', async () => {
  const f = await warmupV2RuntimeFixture();
  try {
    f.raw.rpc.mockRejectedValue(new WalletRpcError(429));
    const input = f.selection();
    const saved = await prepare(
      f.db,
      'owner',
      input,
      true,
      signal(),
      'synthetic-key',
      f.factory,
    );
    expect(saved.outcome).toMatchObject({
      kind: 'refused',
      refusal_code: 'provider-limited',
    });
    expect(await counts(f.db)).toEqual([1, 1, 1, 0]);
    const other = vi.fn(() => async () => {
      throw Error('must not run');
    });
    await expect(
      preview(
        f.db,
        'owner',
        f.selection(),
        true,
        signal(),
        'synthetic-key',
        other,
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(other).not.toHaveBeenCalled();
    await prepare(f.db, 'owner', input, true, signal(), undefined, f.factory);
    expect(f.factory).toHaveBeenCalledOnce();
  } finally {
    f.client.close();
  }
});
it('Stop during the order prevents any late result from being retained', async () => {
  const f = await warmupV2RuntimeFixture();
  try {
    f.raw.prepare.mockImplementation(async () => {
      await f.control('stop');
      return structuredClone(f.raw.order);
    });
    const input = f.selection(),
      saved = await prepare(
        f.db,
        'owner',
        input,
        true,
        signal(),
        'synthetic-key',
        f.factory,
      );
    expect(saved.outcome).toBeNull();
    expect(await counts(f.db)).toEqual([1, 1, 0, 0]);
    const recovered = await read(f.db, 'owner', input.id, signal());
    expect(recovered?.runtime.observation).toBeNull();
    expect(recovered?.attempt.journal.snapshot.phase).toBe('stopped');
  } finally {
    f.client.close();
  }
});

it('an unknown result acknowledgement recovers both committed rows without rerunning providers', async () => {
  const f = await warmupV2RuntimeFixture();
  try {
    const input = f.selection();
    let lost = true;
    const db = withBatch(f.db, async <T>(statements: D1PreparedStatement[]) => {
      const rows = await f.db.batch<T>(statements);
      if (
        lost &&
        native(statements[0]).sql.includes(
          'INSERT INTO wallet_warmup_session_v2_runtime_observations',
        )
      ) {
        lost = false;
        throw Error('synthetic lost result acknowledgement');
      }
      return rows;
    });
    const saved = await prepare(
      db,
      'owner',
      input,
      true,
      signal(),
      'synthetic-key',
      f.factory,
    );
    expect(saved.outcome?.kind).toBe('prepared');
    expect(await counts(f.db)).toEqual([1, 1, 1, 1]);
    await prepare(db, 'owner', input, true, signal(), undefined, f.factory);
    expect(f.factory).toHaveBeenCalledOnce();
  } finally {
    f.client.close();
  }
});
it('retained purpose and runtime observations refuse UPDATE, DELETE and REPLACE', async () => {
  const f = await warmupV2RuntimeFixture();
  try {
    const input = f.selection();
    await prepare(
      f.db,
      'owner',
      input,
      true,
      signal(),
      'synthetic-key',
      f.factory,
    );
    const original = await read(f.db, 'owner', input.id, signal());
    for (const table of [
      'wallet_warmup_session_v2_attempt_purposes',
      'wallet_warmup_session_v2_runtime_observations',
    ])
      for (const sql of [
        `UPDATE ${table} SET created_at=created_at`,
        `DELETE FROM ${table}`,
        `INSERT OR REPLACE INTO ${table} SELECT * FROM ${table}`,
      ])
        await expect(f.db.prepare(sql).run()).rejects.toThrow();
    expect((await read(f.db, 'owner', input.id, signal()))?.runtime).toEqual(
      original?.runtime,
    );
    expect(await counts(f.db)).toEqual([1, 1, 1, 1]);
  } finally {
    f.client.close();
  }
});
it.skipIf(process.env.BUNDLE_WARMUP_DB_CLOCK_QA !== '1')(
  'recovers expired runtime observations against the real SQL clock without renewing or rerunning',
  async () => {
    const f = await warmupV2RuntimeFixture();
    try {
      const input = f.selection();
      await prepare(
        f.db,
        'owner',
        input,
        true,
        signal(),
        'synthetic-key',
        f.factory,
      );
      const before = await read(f.db, 'owner', input.id, signal()),
        expiry = before!.runtime.observation!.runtimeExpiresAt;
      await new Promise((resolve) => setTimeout(resolve, 26050));
      const clock = await f.db
        .prepare("SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS at")
        .first<{ at: string }>();
      expect(clock!.at > expiry).toBe(true);
      expect((await read(f.db, 'owner', input.id, signal()))?.runtime).toEqual(
        before?.runtime,
      );
      await prepare(f.db, 'owner', input, true, signal(), undefined, f.factory);
      expect(f.factory).toHaveBeenCalledOnce();
    } finally {
      f.client.close();
    }
  },
);
