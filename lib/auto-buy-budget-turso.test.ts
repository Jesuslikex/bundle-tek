import { readFileSync } from 'node:fs';
import { createClient } from '@libsql/client';
import { expect, it } from 'vitest';
import { createTursoDatabase } from '../db/turso';
import { autoBuyBudgetFixture } from '../test/auto-buy-budget-fixture';
import {
  retainAutoBuyBudget,
  retainAutoBuyBudgetClaim,
  readAutoBuyBudget,
  changeAutoBuyBudgetClaim,
} from './auto-buy-budget-store';
it('enforces the new migration through the production libSQL adapter with real SQL time', async () => {
  const f = autoBuyBudgetFixture({ full: false, controlledClock: false });
  const client = createClient({ url: 'file::memory:' });
  try {
    // Minimal parents/sinks isolate libSQL transport; the native suite applies the
    // entire real migration chain. Neither fixture authorizes legacy signing.
    for (const name of [
      'imported_token_projects',
      'workspace_wallets',
      'wallet_ownership_proofs',
      'imported_swap_signing_intents',
      'warmup_signing_intents',
    ]) {
      const row = f.sqlite
        .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?")
        .get(name)!;
      await client.execute(row.sql as string);
      for (const data of f.sqlite.prepare(`SELECT * FROM ${name}`).all()) {
        const cols = Object.keys(data);
        await client.execute({
          sql: `INSERT INTO ${name}(${cols.join(',')}) VALUES(${cols.map(() => '?').join(',')})`,
          args: Object.values(data),
        });
      }
    }
    for (const sql of readFileSync(
      'drizzle/0136_auto_buy_budget_ledger.sql',
      'utf8',
    ).split('--> statement-breakpoint'))
      if (sql.trim()) await client.execute(sql);
    const db = createTursoDatabase(client);
    await retainAutoBuyBudget(db, 'owner', f.terms());
    const outcomes = await Promise.allSettled([
      retainAutoBuyBudgetClaim(db, 'owner', f.request(10)),
      retainAutoBuyBudgetClaim(db, 'owner', f.request(11)),
    ]);
    expect(outcomes.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((r) => r.status === 'rejected')).toHaveLength(1);
    const saved = outcomes.find((r) => r.status === 'fulfilled');
    if (saved?.status !== 'fulfilled')
      throw Error('No retained synthetic claim');
    await changeAutoBuyBudgetClaim(
      db,
      'owner',
      saved.value.request.id,
      'uncertain',
    );
    expect(
      (await readAutoBuyBudget(db, 'owner', f.terms().id))
        ?.remainingInputLamports,
    ).toBe('40');
    expect(
      (await readAutoBuyBudget(db, 'owner', f.terms().id))?.uncertainClaims,
    ).toBe(1);
  } finally {
    client.close();
    f.sqlite.close();
  }
});
