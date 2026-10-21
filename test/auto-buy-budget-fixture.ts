import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import type {
  AutoBuyBudgetTerms,
  AutoBuyBudgetClaim,
} from '../lib/auto-buy-budget';
export const budgetId = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const budgetWallet = '11111111111111111111111111111111';
export const budgetMint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export function autoBuyBudgetFixture({
  full = true,
  controlledClock = true,
  file = ':memory:',
  initialize = true,
}: {
  full?: boolean;
  controlledClock?: boolean;
  file?: string;
  initialize?: boolean;
} = {}) {
  const sqlite = new DatabaseSync(file);
  sqlite.exec('PRAGMA foreign_keys=ON');
  let clock = Date.now();
  if (controlledClock)
    sqlite.function('strftime', { varargs: true }, (format, ...args) => {
      let time = args[0] === 'now' ? clock : Date.parse(String(args[0]));
      for (const modifier of args.slice(1)) {
        const match = /^\+(\d+) (days|seconds)$/.exec(String(modifier));
        if (!match) throw Error('Unsupported test clock modifier');
        time += Number(match[1]) * (match[2] === 'days' ? 86400000 : 1000);
      }
      if (!Number.isFinite(time)) return null;
      if (format === '%s') return String(Math.floor(time / 1000));
      if (format !== '%Y-%m-%dT%H:%M:%fZ')
        throw Error('Unsupported test clock format');
      return new Date(time).toISOString();
    });
  if (initialize && full) {
    const journal = JSON.parse(
      readFileSync('drizzle/meta/_journal.json', 'utf8'),
    ).entries as { tag: string }[];
    for (const { tag } of journal)
      sqlite.exec(readFileSync(`drizzle/${tag}.sql`, 'utf8'));
  } else if (initialize) {
    // Read-side parent/sink projections only, not a proof of legacy signing.
    sqlite.exec(`CREATE TABLE imported_token_projects(owner_id TEXT,id TEXT,chain TEXT,address TEXT,document TEXT,revision INTEGER,archived INTEGER);
      CREATE TABLE workspace_wallets(owner_id TEXT,chain TEXT,address TEXT,revision INTEGER,archived INTEGER);
      CREATE TABLE wallet_ownership_proofs(owner_id TEXT,chain TEXT,address TEXT);
      CREATE TABLE imported_swap_signing_intents(id TEXT,owner_id TEXT,preparation_id TEXT,wallet_address TEXT,document TEXT,state TEXT);
      CREATE TABLE warmup_signing_intents(id TEXT,owner_id TEXT,preparation_id TEXT,wallet_address TEXT,document TEXT,state TEXT);`);
    sqlite.exec(
      readFileSync('drizzle/0136_auto_buy_budget_ledger.sql', 'utf8'),
    );
  }
  const project = JSON.stringify({
    token: {
      chain: 'Solana',
      address: budgetMint,
      decimals: 6,
      symbol: 'TEST',
    },
  });
  if (initialize && full) {
    sqlite
      .prepare(
        'INSERT INTO imported_token_projects(owner_id,id,chain,address,document,mutation_id,updated_at) VALUES(?,?,?,?,?,?,?)',
      )
      .run(
        'owner',
        budgetId(1),
        'Solana',
        budgetMint,
        project,
        budgetId(99),
        new Date(clock).toISOString(),
      );
    sqlite
      .prepare(
        "INSERT INTO workspace_wallets(owner_id,chain,address,folder_id,label,role,updated_at) VALUES(?,'Solana',?,'test','Synthetic','trading',?)",
      )
      .run('owner', budgetWallet, new Date(clock).toISOString());
    sqlite
      .prepare(
        "INSERT INTO wallet_ownership_proofs(owner_id,chain,address,verified_at,challenge_id) VALUES(?,'Solana',?,?,?)",
      )
      .run('owner', budgetWallet, new Date(clock).toISOString(), budgetId(98));
  } else if (initialize) {
    sqlite
      .prepare(
        "INSERT INTO imported_token_projects VALUES(?,?,'Solana',?,?,1,0)",
      )
      .run('owner', budgetId(1), budgetMint, project);
    sqlite
      .prepare("INSERT INTO workspace_wallets VALUES(?,'Solana',?,1,0)")
      .run('owner', budgetWallet);
    sqlite
      .prepare("INSERT INTO wallet_ownership_proofs VALUES(?,'Solana',?)")
      .run('owner', budgetWallet);
  }
  const prepare = (sql: string) => {
    const statement = {
      sql,
      args: [] as SQLInputValue[],
      bind(...args: SQLInputValue[]) {
        return Object.assign(prepare(sql), { args });
      },
      async first() {
        return sqlite.prepare(sql).get(...statement.args) ?? null;
      },
      async all() {
        return { results: sqlite.prepare(sql).all(...statement.args) };
      },
      async run() {
        const r = sqlite.prepare(sql).run(...statement.args);
        return { meta: { changes: Number(r.changes) } };
      },
    };
    return statement;
  };
  const db = { prepare } as unknown as D1Database;
  const terms = (): AutoBuyBudgetTerms => ({
    id: budgetId(2),
    projectId: budgetId(1),
    projectRevision: 1,
    mint: budgetMint,
    tokenDecimals: 6,
    maximumInputLamports: '100',
    maximumFeeAndRentLamports: '20',
    expiresAt: new Date(clock + 3600000).toISOString(),
    wallets: [
      {
        address: budgetWallet,
        revision: 1,
        maximumInputLamports: '100',
        maximumFeeAndRentLamports: '20',
      },
    ],
    strategies: [
      {
        id: budgetId(3),
        kind: 'DCA',
        sourceSha256: 'a'.repeat(64),
        maximumInputLamports: '100',
        maximumFeeAndRentLamports: '20',
      },
      {
        id: budgetId(4),
        kind: 'Limit',
        sourceSha256: 'b'.repeat(64),
        maximumInputLamports: '100',
        maximumFeeAndRentLamports: '20',
      },
      {
        id: budgetId(5),
        kind: 'Counter',
        sourceSha256: 'c'.repeat(64),
        maximumInputLamports: '100',
        maximumFeeAndRentLamports: '20',
      },
    ],
  });
  const request = (n = 10): AutoBuyBudgetClaim => ({
    id: budgetId(n),
    sessionId: budgetId(2),
    sessionRevision: 0,
    strategyId: budgetId(3),
    wallet: budgetWallet,
    walletRevision: 1,
    candidateKey: String(n),
    kind: 'ExactIn',
    minimumOutputTokenRaw: '1',
    sourceSha256: 'a'.repeat(64),
    packetSha256: n.toString(16).padStart(64, '0'),
    maximumInputLamports: '60',
    maximumFeeAndRentLamports: '5',
    expiresAt: new Date(clock + 15000).toISOString(),
  });
  return {
    sqlite,
    db,
    terms,
    request,
    advance: (ms: number) => {
      clock += ms;
    },
    clock: () => clock,
  };
}
