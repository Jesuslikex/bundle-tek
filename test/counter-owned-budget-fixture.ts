import {
  autoBuyBudgetFixture,
  budgetId,
  budgetWallet,
  budgetMint,
} from './auto-buy-budget-fixture';
import { counterBuyFixture } from './counter-buy-fixture';
import { supplyWallet } from './supply-history-fixture';
import {
  initialCounterLedger,
  evaluateCounterTrade,
} from '../lib/counter-trade';
import type { CounterBudgetSelection } from '../lib/counter-owned-budget';
/** Actual unchanged0136 guards atop explicit parent projections, not full-schema proof. */
export function counterOwnedBudgetFixture() {
  const f = autoBuyBudgetFixture({ full: false });
  f.sqlite.exec(
    "ALTER TABLE workspace_wallets ADD COLUMN role TEXT DEFAULT 'Recipient'; ALTER TABLE workspace_wallets ADD COLUMN updated_at TEXT DEFAULT '2026-10-23T00:00:00.000Z'; CREATE TABLE counter_trade_plans(owner_id TEXT,project_id TEXT,id TEXT,revision INTEGER,state TEXT,document TEXT); CREATE TABLE imported_token_project_gates(owner_id TEXT PRIMARY KEY,next_allowed_at INTEGER NOT NULL);",
  );
  const seed = counterBuyFixture(supplyWallet(9));
  const plan = JSON.parse(
    JSON.stringify(seed.plan, (_key, value: unknown) =>
      value === seed.plan.ledger.scope.mint ? budgetMint : value,
    ),
  ) as typeof seed.plan;
  plan.projectDocument = (
    f.sqlite.prepare('SELECT document FROM imported_token_projects').get() as {
      document: string;
    }
  ).document;
  plan.rules.ignoredWallets = [budgetWallet];
  plan.ledger.scope.decimals = 6;
  const source = plan.ledger.decisions[0].source!;
  source.context.decimals = 6;
  source.movement.tokenChange!.decimals = 6;
  plan.ledger = evaluateCounterTrade(
    plan.rules,
    initialCounterLedger(plan.rules, plan.ledger.scope),
    source.movement,
    source.context,
  ).ledger;
  f.sqlite
    .prepare('INSERT INTO counter_trade_plans VALUES(?,?,?,?,?,?)')
    .run(
      'owner',
      plan.projectId,
      plan.id,
      plan.revision,
      plan.state,
      JSON.stringify(plan),
    );
  const selection: CounterBudgetSelection = {
    budgetId: budgetId(30),
    projectId: plan.projectId,
    projectRevision: plan.ledger.scope.revision,
    planId: plan.id,
    planRevision: plan.revision,
    decisionIdentity: plan.ledger.decisions[0].identity,
    wallet: budgetWallet,
    walletRevision: 1,
    maximumInputLamports: '1000000000',
    maximumFeeAndRentLamports: '10000000',
    expiresAt: new Date(f.clock() + 3600000).toISOString(),
  };
  const hooks: {
    beforeFirst?: (sql: string) => void;
    mapFirst?: (sql: string, result: unknown) => unknown;
    afterFirst?: (sql: string) => void;
    beforeRun?: (sql: string) => void;
    afterRun?: (sql: string) => void;
  } = {};
  const db = {
    prepare(sql: string) {
      let statement = f.db.prepare(sql);
      const proxy = {
        bind(...args: unknown[]) {
          statement = statement.bind(...args);
          return proxy;
        },
        async first() {
          hooks.beforeFirst?.(sql);
          const result = await statement.first();
          hooks.afterFirst?.(sql);
          return hooks.mapFirst ? hooks.mapFirst(sql, result) : result;
        },
        async all() {
          return statement.all();
        },
        async run() {
          hooks.beforeRun?.(sql);
          const result = await statement.run();
          hooks.afterRun?.(sql);
          return result;
        },
      };
      return proxy;
    },
  } as unknown as D1Database;
  const savePlan = () =>
    f.sqlite
      .prepare('UPDATE counter_trade_plans SET revision=?,state=?,document=?')
      .run(plan.revision, plan.state, JSON.stringify(plan));
  return { ...f, db, selection, plan, hooks, savePlan };
}
