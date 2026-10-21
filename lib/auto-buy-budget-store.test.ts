import { expect, it } from 'vitest';
import { mkdtempSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AUTO_BUY_BUDGET_AUTHORITY } from './auto-buy-budget';
import {
  autoBuyBudgetFixture,
  budgetId,
  budgetWallet,
} from '../test/auto-buy-budget-fixture';
import {
  retainAutoBuyBudget,
  retainAutoBuyBudgetClaim,
  readAutoBuyBudget,
  changeAutoBuyBudgetClaim,
  readAutoBuyBudgetClaim,
  controlAutoBuyBudget,
} from './auto-buy-budget-store';
type Fixture = ReturnType<typeof autoBuyBudgetFixture>;
async function ready(f: Fixture) {
  await retainAutoBuyBudget(f.db, 'owner', f.terms());
}
function insertCopy(
  f: Fixture,
  table: string,
  row: Record<string, unknown>,
  replace = false,
) {
  const keys = Object.keys(row);
  return f.sqlite
    .prepare(
      `INSERT ${replace ? 'OR REPLACE ' : ''}INTO ${table}(${keys.join(',')}) VALUES(${keys.map(() => '?').join(',')})`,
    )
    .run(...(keys.map((k) => row[k]) as (string | number | null)[]));
}
it('serializes competing claims in SQL rather than a browser-memory balance', async () => {
  const f = autoBuyBudgetFixture();
  try {
    await ready(f);
    const results = await Promise.allSettled([
      retainAutoBuyBudgetClaim(f.db, 'owner', f.request(10)),
      retainAutoBuyBudgetClaim(f.db, 'owner', f.request(11)),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect(
      (await readAutoBuyBudget(f.db, 'owner', f.terms().id))?.heldInputLamports,
    ).toBe('60');
  } finally {
    f.sqlite.close();
  }
});
it('deduplicates Counter source identities owner-wide without treating DCA slots as global', async () => {
  const f = autoBuyBudgetFixture();
  try {
    const first = f.terms(),
      second = f.terms();
    second.id = budgetId(22);
    second.strategies[2].id = budgetId(25);
    await retainAutoBuyBudget(f.db, 'owner', first);
    await retainAutoBuyBudget(f.db, 'owner', second);
    const one = {
      ...f.request(),
      strategyId: budgetId(5),
      candidateKey: 'd'.repeat(64),
      kind: 'ExactOut' as const,
      sourceSha256: 'c'.repeat(64),
    };
    const two = {
      ...one,
      id: budgetId(11),
      sessionId: second.id,
      strategyId: budgetId(25),
      packetSha256: 'e'.repeat(64),
    };
    await retainAutoBuyBudgetClaim(f.db, 'owner', one);
    await expect(
      retainAutoBuyBudgetClaim(f.db, 'owner', two),
    ).rejects.toMatchObject({ status: 409 });
    f.advance(15001);
    await changeAutoBuyBudgetClaim(f.db, 'owner', one.id, 'released');
    await retainAutoBuyBudgetClaim(f.db, 'owner', {
      ...two,
      expiresAt: f.request().expiresAt,
    });
    expect(
      (await readAutoBuyBudget(f.db, 'owner', second.id))?.heldInputLamports,
    ).toBe('60');
  } finally {
    f.sqlite.close();
  }
});
it('permits separate-session DCA slots but refuses a duplicate packet across sessions', async () => {
  const f = autoBuyBudgetFixture();
  try {
    const terms = f.terms(),
      second = { ...f.terms(), id: budgetId(22) };
    await retainAutoBuyBudget(f.db, 'owner', terms);
    await retainAutoBuyBudget(f.db, 'owner', second);
    const request = f.request();
    await retainAutoBuyBudgetClaim(f.db, 'owner', request);
    await expect(
      retainAutoBuyBudgetClaim(f.db, 'owner', {
        ...request,
        id: budgetId(11),
        sessionId: second.id,
      }),
    ).rejects.toMatchObject({ status: 409 });
    await retainAutoBuyBudgetClaim(f.db, 'owner', {
      ...f.request(11),
      sessionId: second.id,
      candidateKey: request.candidateKey,
    });
    expect(
      (await readAutoBuyBudget(f.db, 'owner', second.id))?.heldInputLamports,
    ).toBe('60');
  } finally {
    f.sqlite.close();
  }
});
it.each([
  'wallet-input',
  'wallet-fee',
  'strategy-input',
  'strategy-fee',
] as const)(
  'sums prior charges for %s while keeping other dimensions independent',
  async (dimension) => {
    const f = autoBuyBudgetFixture();
    try {
      const terms = f.terms();
      terms.maximumInputLamports = '200';
      terms.maximumFeeAndRentLamports = '40';
      for (const row of [...terms.wallets, ...terms.strategies]) {
        row.maximumInputLamports = '200';
        row.maximumFeeAndRentLamports = '40';
      }
      const limited = dimension.startsWith('wallet')
        ? terms.wallets[0]
        : terms.strategies[0];
      if (dimension.endsWith('input')) limited.maximumInputLamports = '100';
      else limited.maximumFeeAndRentLamports = '9';
      await retainAutoBuyBudget(f.db, 'owner', terms);
      await retainAutoBuyBudgetClaim(f.db, 'owner', f.request());
      await expect(
        retainAutoBuyBudgetClaim(f.db, 'owner', f.request(11)),
      ).rejects.toMatchObject({ status: 409 });
      expect(
        (await readAutoBuyBudget(f.db, 'owner', terms.id))?.heldInputLamports,
      ).toBe('60');
    } finally {
      f.sqlite.close();
    }
  },
);
it('all selected wallet revisions remain part of the immutable context, including an unused wallet', async () => {
  const f = autoBuyBudgetFixture();
  try {
    const address = 'So11111111111111111111111111111111111111112',
      terms = f.terms();
    const wallet = {
      ...f.sqlite.prepare('SELECT * FROM workspace_wallets').get()!,
      address,
    };
    const proof = {
      ...f.sqlite.prepare('SELECT * FROM wallet_ownership_proofs').get()!,
      address,
    };
    insertCopy(f, 'workspace_wallets', wallet);
    insertCopy(f, 'wallet_ownership_proofs', proof);
    terms.wallets.push({ ...terms.wallets[0], address });
    await retainAutoBuyBudget(f.db, 'owner', terms);
    f.sqlite
      .prepare('UPDATE workspace_wallets SET revision=2 WHERE address=?')
      .run(address);
    await expect(
      retainAutoBuyBudgetClaim(f.db, 'owner', f.request()),
    ).rejects.toMatchObject({ status: 409 });
    expect(
      (await readAutoBuyBudget(f.db, 'owner', terms.id))?.heldInputLamports,
    ).toBe('0');
  } finally {
    f.sqlite.close();
  }
});
it.each([
  'session-input',
  'session-fee',
  'wallet-input',
  'wallet-fee',
  'strategy-input',
  'strategy-fee',
] as const)('enforces the independent %s ceiling', async (dimension) => {
  const f = autoBuyBudgetFixture();
  try {
    const terms = f.terms();
    const limit = dimension.startsWith('wallet')
      ? terms.wallets[0]
      : dimension.startsWith('strategy')
        ? terms.strategies[0]
        : terms;
    if (dimension.endsWith('input')) limit.maximumInputLamports = '59';
    else limit.maximumFeeAndRentLamports = '4';
    if (dimension.startsWith('session')) {
      for (const v of [...terms.wallets, ...terms.strategies]) {
        v.maximumInputLamports = terms.maximumInputLamports;
        v.maximumFeeAndRentLamports = terms.maximumFeeAndRentLamports;
      }
    }
    await retainAutoBuyBudget(f.db, 'owner', terms);
    await expect(
      retainAutoBuyBudgetClaim(f.db, 'owner', f.request()),
    ).rejects.toMatchObject({ status: 409 });
    expect(
      f.sqlite
        .prepare('SELECT count(*) AS n FROM auto_buy_budget_claims')
        .get(),
    ).toEqual({ n: 0 });
  } finally {
    f.sqlite.close();
  }
});
it('keeps token target units distinct from the SOL ceiling and refuses wrong mode/hash identity', async () => {
  const f = autoBuyBudgetFixture();
  try {
    await ready(f);
    const counter = {
      ...f.request(),
      strategyId: budgetId(5),
      candidateKey: 'd'.repeat(64),
      kind: 'ExactOut' as const,
      sourceSha256: 'c'.repeat(64),
      minimumOutputTokenRaw: '18446744073709551615',
    };
    const saved = await retainAutoBuyBudgetClaim(f.db, 'owner', counter);
    expect(saved.request.minimumOutputTokenRaw).toBe('18446744073709551615');
    expect(
      (await readAutoBuyBudget(f.db, 'owner', f.terms().id))?.heldInputLamports,
    ).toBe('60');
    await expect(
      retainAutoBuyBudgetClaim(f.db, 'owner', {
        ...f.request(11),
        kind: 'ExactOut',
        candidateKey: 'e'.repeat(64),
      }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      retainAutoBuyBudgetClaim(f.db, 'owner', {
        ...f.request(12),
        sourceSha256: 'f'.repeat(64),
      }),
    ).rejects.toMatchObject({ status: 409 });
  } finally {
    f.sqlite.close();
  }
});
it('retains exact same-ID recovery after expiry and controls, rejecting changed terms', async () => {
  const f = autoBuyBudgetFixture();
  try {
    const terms = f.terms(),
      request = f.request();
    await retainAutoBuyBudget(f.db, 'owner', terms);
    await retainAutoBuyBudgetClaim(f.db, 'owner', request);
    await controlAutoBuyBudget(f.db, 'owner', terms.id, 0, 'paused');
    f.advance(20000);
    expect((await retainAutoBuyBudgetClaim(f.db, 'owner', request)).state).toBe(
      'held',
    );
    expect((await retainAutoBuyBudget(f.db, 'owner', terms)).state).toBe(
      'paused',
    );
    await expect(
      retainAutoBuyBudget(f.db, 'owner', {
        ...terms,
        maximumInputLamports: '101',
      }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      retainAutoBuyBudgetClaim(f.db, 'owner', {
        ...request,
        maximumInputLamports: '59',
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(
      f.sqlite
        .prepare('SELECT count(*) AS n FROM auto_buy_budget_claims')
        .get(),
    ).toEqual({ n: 1 });
  } finally {
    f.sqlite.close();
  }
});
it('Pause, resume, stale control and permanent Stop never reset charged capacity', async () => {
  const f = autoBuyBudgetFixture();
  try {
    await ready(f);
    await retainAutoBuyBudgetClaim(f.db, 'owner', f.request());
    expect(
      (await controlAutoBuyBudget(f.db, 'owner', budgetId(2), 0, 'paused'))
        .heldInputLamports,
    ).toBe('60');
    await expect(
      retainAutoBuyBudgetClaim(f.db, 'owner', {
        ...f.request(11),
        sessionRevision: 1,
      }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      controlAutoBuyBudget(f.db, 'owner', budgetId(2), 0, 'open'),
    ).rejects.toMatchObject({ status: 409 });
    expect(
      (await controlAutoBuyBudget(f.db, 'owner', budgetId(2), 1, 'open'))
        .heldInputLamports,
    ).toBe('60');
    await controlAutoBuyBudget(f.db, 'owner', budgetId(2), 2, 'stopped');
    await expect(
      controlAutoBuyBudget(f.db, 'owner', budgetId(2), 3, 'open'),
    ).rejects.toMatchObject({ status: 409 });
    expect(
      (await readAutoBuyBudget(f.db, 'owner', budgetId(2)))?.heldInputLamports,
    ).toBe('60');
  } finally {
    f.sqlite.close();
  }
});
it.each([
  'project-revision',
  'project-document',
  'project-archive',
  'wallet-revision',
  'wallet-archive',
  'ownership-proof',
] as const)(
  'refuses a new claim on changed %s, leaving saved recovery readable',
  async (change) => {
    const f = autoBuyBudgetFixture();
    try {
      await ready(f);
      if (change === 'project-revision')
        f.sqlite.exec('UPDATE imported_token_projects SET revision=2');
      if (change === 'project-document')
        f.sqlite.exec(
          "UPDATE imported_token_projects SET document=json_set(document,'$.token.symbol','CHANGED')",
        );
      if (change === 'project-archive')
        f.sqlite.exec('UPDATE imported_token_projects SET archived=1');
      if (change === 'wallet-revision')
        f.sqlite.exec('UPDATE workspace_wallets SET revision=2');
      if (change === 'wallet-archive')
        f.sqlite.exec('UPDATE workspace_wallets SET archived=1');
      if (change === 'ownership-proof')
        f.sqlite.exec('DELETE FROM wallet_ownership_proofs');
      await expect(
        retainAutoBuyBudgetClaim(f.db, 'owner', f.request()),
      ).rejects.toMatchObject({ status: 409 });
      expect(
        (await readAutoBuyBudget(f.db, 'owner', budgetId(2)))
          ?.remainingInputLamports,
      ).toBe('100');
    } finally {
      f.sqlite.close();
    }
  },
);
it('scopes all reads and writes to the owner', async () => {
  const f = autoBuyBudgetFixture();
  try {
    await ready(f);
    await retainAutoBuyBudgetClaim(f.db, 'owner', f.request());
    expect(await readAutoBuyBudget(f.db, 'other', budgetId(2))).toBeNull();
    expect(
      await readAutoBuyBudgetClaim(f.db, 'other', budgetId(10)),
    ).toBeNull();
    await expect(
      retainAutoBuyBudget(f.db, 'other', f.terms()),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      retainAutoBuyBudgetClaim(f.db, 'other', f.request()),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      controlAutoBuyBudget(f.db, 'other', budgetId(2), 0, 'stopped'),
    ).rejects.toMatchObject({ status: 409 });
  } finally {
    f.sqlite.close();
  }
});
it.each([
  'auto_buy_budget_claim_insert',
  'auto_buy_budgets_update',
  'imported_swap_signing_intents_auto_buy_budget_isolation',
] as const)('fails closed before writing when %s is missing', async (name) => {
  const f = autoBuyBudgetFixture();
  try {
    await ready(f);
    f.sqlite.exec(`DROP TRIGGER ${name}`);
    await expect(
      retainAutoBuyBudgetClaim(f.db, 'owner', f.request()),
    ).rejects.toMatchObject({ status: 503 });
    expect(
      f.sqlite
        .prepare('SELECT count(*) AS n FROM auto_buy_budget_claims')
        .get(),
    ).toEqual({ n: 0 });
    expect(
      (await readAutoBuyBudget(f.db, 'owner', budgetId(2)))?.signingAllowed,
    ).toBe(false);
  } finally {
    f.sqlite.close();
  }
});
it.each(['session', 'candidate-key', 'packet'] as const)(
  'refuses INSERT OR REPLACE against retained %s identity',
  async (target) => {
    const f = autoBuyBudgetFixture();
    try {
      const terms = f.terms();
      terms.maximumInputLamports = '200';
      terms.maximumFeeAndRentLamports = '40';
      await retainAutoBuyBudget(f.db, 'owner', terms);
      await retainAutoBuyBudgetClaim(f.db, 'owner', f.request());
      const table =
        target === 'session' ? 'auto_buy_budgets' : 'auto_buy_budget_claims';
      const original = f.sqlite.prepare(`SELECT * FROM ${table}`).all();
      const row = { ...original[0] };
      if (target !== 'session') {
        row.id = budgetId(11);
        const doc = JSON.parse(row.document as string);
        doc.request.id = row.id;
        if (target === 'candidate-key') {
          row.packet_sha256 = 'e'.repeat(64);
          doc.request.packetSha256 = row.packet_sha256;
        } else {
          row.candidate_key = '11';
          doc.request.candidateKey = '11';
        }
        row.document = JSON.stringify(doc);
      }
      expect(() => insertCopy(f, table, row, true)).toThrow();
      expect(f.sqlite.prepare(`SELECT * FROM ${table}`).all()).toEqual(
        original,
      );
    } finally {
      f.sqlite.close();
    }
  },
);
it('rejects deletion and terms mutation, and permits released unsigned-key reuse without erasing history', async () => {
  const f = autoBuyBudgetFixture();
  try {
    await ready(f);
    const request = f.request();
    await retainAutoBuyBudgetClaim(f.db, 'owner', request);
    expect(() => f.sqlite.exec('DELETE FROM auto_buy_budgets')).toThrow();
    expect(() => f.sqlite.exec('DELETE FROM auto_buy_budget_claims')).toThrow();
    expect(() =>
      f.sqlite.exec('UPDATE auto_buy_budgets SET maximum_input_lamports=200'),
    ).toThrow();
    expect(() =>
      f.sqlite.exec(
        "UPDATE auto_buy_budget_claims SET packet_sha256='invalid'",
      ),
    ).toThrow();
    f.advance(15001);
    await changeAutoBuyBudgetClaim(f.db, 'owner', request.id, 'released');
    await retainAutoBuyBudgetClaim(f.db, 'owner', {
      ...f.request(11),
      candidateKey: request.candidateKey,
    });
    expect(
      f.sqlite
        .prepare('SELECT count(*) AS n FROM auto_buy_budget_claims')
        .get(),
    ).toEqual({ n: 2 });
    expect(
      (await readAutoBuyBudget(f.db, 'owner', budgetId(2)))?.heldInputLamports,
    ).toBe('60');
  } finally {
    f.sqlite.close();
  }
});
it.each(['imported_swap_signing_intents', 'warmup_signing_intents'] as const)(
  'hard-isolates bookkeeping IDs and packet aliases from %s in minimal sinks',
  async (table) => {
    // These partial sink projections isolate the NEW migration's guard. They do
    // not prove legacy signing or the not-yet-implemented authorization bridge.
    const f = autoBuyBudgetFixture({ full: false });
    try {
      await ready(f);
      await retainAutoBuyBudgetClaim(f.db, 'owner', f.request());
      for (const alias of ['id', 'packet']) {
        expect(() =>
          f.sqlite
            .prepare(
              `INSERT INTO ${table}(id,owner_id,preparation_id,wallet_address,document,state) VALUES(?,?,?,?,?,?)`,
            )
            .run(
              budgetId(50),
              'owner',
              alias === 'id' ? budgetId(10) : budgetId(51),
              budgetWallet,
              JSON.stringify({
                sha256:
                  alias === 'packet'
                    ? f.request().packetSha256
                    : 'f'.repeat(64),
              }),
              'awaiting_signature',
            ),
        ).toThrow(/does not authorize signing/);
      }
      f.sqlite
        .prepare(`INSERT INTO ${table} VALUES(?,?,?,?,?,?)`)
        .run(
          budgetId(52),
          'owner',
          budgetId(53),
          budgetWallet,
          JSON.stringify({ sha256: 'f'.repeat(64) }),
          'signed',
        );
      expect(() =>
        f.sqlite
          .prepare(`UPDATE ${table} SET document=?`)
          .run(JSON.stringify({ sha256: f.request().packetSha256 })),
      ).toThrow(/does not authorize signing/);
    } finally {
      f.sqlite.close();
    }
  },
);
it('keeps a conservative claim and all limits across an actual database close/reopen', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'bundle-autobuy-budget-')),
    file = join(folder, 'ledger.sqlite');
  let f = autoBuyBudgetFixture({ file });
  try {
    const terms = f.terms(),
      request = f.request();
    await retainAutoBuyBudget(f.db, 'owner', terms);
    await retainAutoBuyBudgetClaim(f.db, 'owner', request);
    await changeAutoBuyBudgetClaim(f.db, 'owner', request.id, 'uncertain');
    f.sqlite.close();
    f = autoBuyBudgetFixture({ file, initialize: false });
    expect(
      (await retainAutoBuyBudget(f.db, 'owner', terms)).remainingInputLamports,
    ).toBe('40');
    expect((await retainAutoBuyBudgetClaim(f.db, 'owner', request)).state).toBe(
      'uncertain',
    );
    expect(
      (await readAutoBuyBudget(f.db, 'owner', terms.id))?.uncertainClaims,
    ).toBe(1);
  } finally {
    f.sqlite.close();
    unlinkSync(file);
    rmdirSync(folder);
  }
});
it('uses SQLite real time in the normal production clock mode', async () => {
  const f = autoBuyBudgetFixture({ controlledClock: false });
  try {
    await ready(f);
    const row = await retainAutoBuyBudgetClaim(f.db, 'owner', f.request());
    expect(Math.abs(Date.parse(row.createdAt) - Date.now())).toBeLessThan(5000);
    await expect(
      changeAutoBuyBudgetClaim(f.db, 'owner', row.request.id, 'released'),
    ).rejects.toMatchObject({ status: 409 });
  } finally {
    f.sqlite.close();
  }
});
it.each([0, 30000, 30001] as const)(
  'uses the SQL clock for a claim expiry offset of %s ms',
  async (offset) => {
    const f = autoBuyBudgetFixture();
    try {
      await ready(f);
      const request = {
        ...f.request(),
        expiresAt: new Date(f.clock() + offset).toISOString(),
      };
      if (offset === 30000)
        expect(
          (await retainAutoBuyBudgetClaim(f.db, 'owner', request)).state,
        ).toBe('held');
      else
        await expect(
          retainAutoBuyBudgetClaim(f.db, 'owner', request),
        ).rejects.toMatchObject({ status: 409 });
    } finally {
      f.sqlite.close();
    }
  },
);
it.each(
  Object.keys(AUTO_BUY_BUDGET_AUTHORITY).flatMap((flag) =>
    ['true', 'null', 'missing'].map((value) => ({ flag, value })),
  ),
)(
  'SQL refuses $flag=$value even with no duplicate identity conflict',
  async ({ flag, value }) => {
    const f = autoBuyBudgetFixture();
    try {
      await ready(f);
      const row = {
        ...f.sqlite.prepare('SELECT * FROM auto_buy_budgets').get()!,
      };
      const doc = JSON.parse(row.document as string);
      row.id = budgetId(30);
      doc.terms.id = row.id;
      if (value === 'missing') delete doc[flag];
      else doc[flag] = value === 'true' ? true : null;
      row.document = JSON.stringify(doc);
      expect(() => insertCopy(f, 'auto_buy_budgets', row)).toThrow();
      expect(
        f.sqlite.prepare('SELECT count(*) AS n FROM auto_buy_budgets').get(),
      ).toEqual({ n: 1 });
    } finally {
      f.sqlite.close();
    }
  },
);
it('recovers a lost database write response by exact ID without a second charge', async () => {
  const f = autoBuyBudgetFixture();
  try {
    let writes = 0;
    const wrap = (
      statement: D1PreparedStatement,
      sql: string,
    ): D1PreparedStatement =>
      Object.assign(Object.create(statement) as D1PreparedStatement, {
        bind: (...args: unknown[]) => wrap(statement.bind(...args), sql),
        run: async () => {
          const result = await statement.run();
          if (sql.startsWith('INSERT INTO auto_buy_')) {
            writes++;
            throw Error('Synthetic lost write response');
          }
          return result;
        },
      });
    const db = {
      prepare: (sql: string) => wrap(f.db.prepare(sql), sql),
    } as unknown as D1Database;
    const terms = f.terms(),
      request = f.request();
    await retainAutoBuyBudget(db, 'owner', terms);
    await retainAutoBuyBudgetClaim(db, 'owner', request);
    await retainAutoBuyBudget(db, 'owner', terms);
    await retainAutoBuyBudgetClaim(db, 'owner', request);
    expect(writes).toBe(2);
    expect(
      (await readAutoBuyBudget(f.db, 'owner', terms.id))?.heldInputLamports,
    ).toBe('60');
  } finally {
    f.sqlite.close();
  }
});
it('SQL refuses a null candidate authority flag without relying on the TypeScript reader', async () => {
  const f = autoBuyBudgetFixture();
  try {
    await ready(f);
    await retainAutoBuyBudgetClaim(f.db, 'owner', f.request());
    const row = {
        ...f.sqlite.prepare('SELECT * FROM auto_buy_budget_claims').get()!,
      },
      doc = JSON.parse(row.document as string);
    Object.assign(row, {
      id: budgetId(11),
      candidate_key: '11',
      packet_sha256: 'f'.repeat(64),
      maximum_input_lamports: 10,
    });
    Object.assign(doc.request, {
      id: row.id,
      candidateKey: row.candidate_key,
      packetSha256: row.packet_sha256,
      maximumInputLamports: '10',
    });
    doc.sourceVerified = null;
    row.document = JSON.stringify(doc);
    expect(() => insertCopy(f, 'auto_buy_budget_claims', row)).toThrow();
    expect(
      f.sqlite
        .prepare('SELECT count(*) AS n FROM auto_buy_budget_claims')
        .get(),
    ).toEqual({ n: 1 });
  } finally {
    f.sqlite.close();
  }
});
it.each(['imported_swap_signing_intents', 'warmup_signing_intents'] as const)(
  'a corrupt out-of-band %s row still blocks raw SQL expiry release',
  async (table) => {
    const f = autoBuyBudgetFixture({ full: false });
    try {
      await ready(f);
      const request = f.request();
      await retainAutoBuyBudgetClaim(f.db, 'owner', request);
      f.advance(15001);
      // Deliberately inconsistent read-model fixture: remove ONLY the new sink
      // insertion guard. This does not exercise or qualify an actual signer.
      f.sqlite.exec(`DROP TRIGGER ${table}_auto_buy_budget_isolation`);
      f.sqlite
        .prepare(`INSERT INTO ${table} VALUES(?,?,?,?,?,?)`)
        .run(
          budgetId(50),
          'owner',
          request.id,
          budgetWallet,
          JSON.stringify({ sha256: request.packetSha256 }),
          'signed',
        );
      expect(() =>
        f.sqlite
          .prepare(
            "UPDATE auto_buy_budget_claims SET state='released',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?",
          )
          .run(request.id),
      ).toThrow();
      expect(
        f.sqlite.prepare('SELECT state FROM auto_buy_budget_claims').get(),
      ).toEqual({ state: 'held' });
      expect(() =>
        f.sqlite.prepare(`DELETE FROM ${table} WHERE id=?`).run(budgetId(50)),
      ).toThrow();
    } finally {
      f.sqlite.close();
    }
  },
);
it('retains immutable terms and atomically charges input and fee ceilings on the complete migrated schema', async () => {
  const f = autoBuyBudgetFixture();
  try {
    const saved = await retainAutoBuyBudget(f.db, 'owner', f.terms());
    expect(saved.remainingInputLamports).toBe('100');
    const held = await retainAutoBuyBudgetClaim(f.db, 'owner', f.request());
    expect(held.state).toBe('held');
    expect(held.signingAllowed).toBe(false);
    expect(held.walletFundsReserved).toBe(false);
    expect(
      (await readAutoBuyBudget(f.db, 'owner', saved.terms.id))
        ?.remainingInputLamports,
    ).toBe('40');
    await expect(
      retainAutoBuyBudgetClaim(f.db, 'owner', f.request(11)),
    ).rejects.toMatchObject({ status: 409 });
    expect(f.sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  } finally {
    f.sqlite.close();
  }
});
it.each([
  'maximumInputLamports',
  'walletRevision',
  'minimumOutputTokenRaw',
  'candidateKey',
] as const)(
  'SQL rejects JSON coercion of %s without another conflicting key',
  async (key) => {
    const f = autoBuyBudgetFixture();
    try {
      await ready(f);
      await retainAutoBuyBudgetClaim(f.db, 'owner', f.request());
      const row = {
          ...f.sqlite.prepare('SELECT * FROM auto_buy_budget_claims').get()!,
        },
        doc = JSON.parse(row.document as string);
      Object.assign(row, {
        id: budgetId(11),
        candidate_key: '11',
        packet_sha256: 'f'.repeat(64),
        maximum_input_lamports: 10,
      });
      Object.assign(doc.request, {
        id: row.id,
        candidateKey: row.candidate_key,
        packetSha256: row.packet_sha256,
        maximumInputLamports: '10',
      });
      doc.request[key] =
        key === 'walletRevision' ? '1' : Number(doc.request[key]);
      row.document = JSON.stringify(doc);
      expect(() => insertCopy(f, 'auto_buy_budget_claims', row)).toThrow();
      expect(
        f.sqlite
          .prepare('SELECT count(*) AS n FROM auto_buy_budget_claims')
          .get(),
      ).toEqual({ n: 1 });
    } finally {
      f.sqlite.close();
    }
  },
);
it('refuses corrupt parent bytes before adding a claim or changing control state', async () => {
  const f = autoBuyBudgetFixture();
  try {
    await ready(f);
    const trigger = f.sqlite
      .prepare(
        "SELECT name,sql FROM sqlite_master WHERE type='trigger' AND tbl_name='auto_buy_budgets' AND sql LIKE '%BEFORE UPDATE%'",
      )
      .get()!;
    if (typeof trigger.name !== 'string') throw Error('Missing test trigger');
    f.sqlite.exec(`DROP TRIGGER ${trigger.name}`);
    f.sqlite
      .prepare('UPDATE auto_buy_budgets SET document_sha256=?')
      .run('0'.repeat(64));
    f.sqlite.exec(trigger.sql as string);
    await expect(
      retainAutoBuyBudgetClaim(f.db, 'owner', f.request()),
    ).rejects.toMatchObject({ status: 503 });
    await expect(
      controlAutoBuyBudget(f.db, 'owner', budgetId(2), 0, 'paused'),
    ).rejects.toMatchObject({ status: 503 });
    expect(
      f.sqlite
        .prepare('SELECT count(*) AS n FROM auto_buy_budget_claims')
        .get(),
    ).toEqual({ n: 0 });
    expect(
      f.sqlite.prepare('SELECT state,revision FROM auto_buy_budgets').get(),
    ).toEqual({ state: 'open', revision: 0 });
  } finally {
    f.sqlite.close();
  }
});
it('recovers lost control and release replies from exact saved state', async () => {
  const f = autoBuyBudgetFixture();
  try {
    await ready(f);
    const request = f.request();
    await retainAutoBuyBudgetClaim(f.db, 'owner', request);
    f.advance(15001);
    let writes = 0;
    const wrap = (
      statement: D1PreparedStatement,
      sql: string,
    ): D1PreparedStatement =>
      Object.assign(Object.create(statement) as D1PreparedStatement, {
        bind: (...args: unknown[]) => wrap(statement.bind(...args), sql),
        run: async () => {
          const result = await statement.run();
          if (sql.startsWith('UPDATE auto_buy_')) {
            writes++;
            throw Error('Synthetic lost response');
          }
          return result;
        },
      });
    const db = {
      prepare: (sql: string) => wrap(f.db.prepare(sql), sql),
    } as unknown as D1Database;
    expect(
      (await controlAutoBuyBudget(db, 'owner', budgetId(2), 0, 'paused')).state,
    ).toBe('paused');
    expect(
      (await changeAutoBuyBudgetClaim(db, 'owner', request.id, 'released'))
        .state,
    ).toBe('released');
    expect(writes).toBe(2);
    const recovered = await retainAutoBuyBudgetClaim(f.db, 'owner', request);
    expect(recovered.state).toBe('released');
    expect(recovered.signingAllowed).toBe(false);
    expect(
      (await readAutoBuyBudget(f.db, 'owner', budgetId(2)))?.heldInputLamports,
    ).toBe('0');
  } finally {
    f.sqlite.close();
  }
});
it.each(['chain', 'address'] as const)(
  'refuses a project whose token %s disagrees with its indexed fields',
  async (field) => {
    const f = autoBuyBudgetFixture();
    try {
      const row = f.sqlite
          .prepare('SELECT document FROM imported_token_projects')
          .get()!,
        doc = JSON.parse(row.document as string);
      doc.token[field] = field === 'chain' ? 'Base' : budgetWallet;
      f.sqlite
        .prepare('UPDATE imported_token_projects SET document=?')
        .run(JSON.stringify(doc));
      await expect(ready(f)).rejects.toMatchObject({ status: 409 });
    } finally {
      f.sqlite.close();
    }
  },
);
it('does not admit claims or resume an expired session but permits permanent Stop', async () => {
  const f = autoBuyBudgetFixture();
  try {
    await ready(f);
    f.advance(3600001);
    await expect(
      retainAutoBuyBudgetClaim(f.db, 'owner', f.request()),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      controlAutoBuyBudget(f.db, 'owner', budgetId(2), 0, 'paused'),
    ).rejects.toMatchObject({ status: 409 });
    expect(
      (await controlAutoBuyBudget(f.db, 'owner', budgetId(2), 0, 'stopped'))
        .state,
    ).toBe('stopped');
  } finally {
    f.sqlite.close();
  }
});
it.each(['imported_swap_signing_intents', 'warmup_signing_intents'] as const)(
  'existing %s evidence prevents a new accounting claim',
  async (table) => {
    const f = autoBuyBudgetFixture({ full: false });
    try {
      await ready(f);
      const request = f.request();
      f.sqlite
        .prepare(`INSERT INTO ${table} VALUES(?,?,?,?,?,?)`)
        .run(
          budgetId(50),
          'owner',
          request.id,
          budgetWallet,
          JSON.stringify({ sha256: request.packetSha256 }),
          'signed',
        );
      await expect(
        retainAutoBuyBudgetClaim(f.db, 'owner', request),
      ).rejects.toMatchObject({ status: 409 });
    } finally {
      f.sqlite.close();
    }
  },
);
it('only releases an expired held accounting claim, never uncertain capacity', async () => {
  const f = autoBuyBudgetFixture();
  try {
    await retainAutoBuyBudget(f.db, 'owner', f.terms());
    await retainAutoBuyBudgetClaim(f.db, 'owner', f.request());
    await expect(
      changeAutoBuyBudgetClaim(f.db, 'owner', f.request().id, 'released'),
    ).rejects.toMatchObject({ status: 409 });
    f.advance(15001);
    await changeAutoBuyBudgetClaim(f.db, 'owner', f.request().id, 'released');
    expect(
      (await readAutoBuyBudget(f.db, 'owner', f.terms().id))
        ?.remainingInputLamports,
    ).toBe('100');
    await retainAutoBuyBudgetClaim(f.db, 'owner', f.request(12));
    await changeAutoBuyBudgetClaim(
      f.db,
      'owner',
      f.request(12).id,
      'uncertain',
    );
    f.advance(60000);
    await expect(
      changeAutoBuyBudgetClaim(f.db, 'owner', f.request(12).id, 'released'),
    ).rejects.toMatchObject({ status: 409 });
    expect(
      (await readAutoBuyBudget(f.db, 'owner', f.terms().id))
        ?.remainingInputLamports,
    ).toBe('40');
  } finally {
    f.sqlite.close();
  }
});
