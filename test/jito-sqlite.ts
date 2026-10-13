import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import type { JitoBundleManifest } from '../lib/jito-bundle';
export function jitoDatabase(manifest: JitoBundleManifest, withEvents = true) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`CREATE TABLE warmup_signing_intents(id TEXT,owner_id TEXT,preparation_id TEXT,wallet_address TEXT,document TEXT,state TEXT,signature TEXT);
    CREATE TABLE imported_swap_preparations(id TEXT,owner_id TEXT,project_id TEXT,project_revision INTEGER,wallet_revision INTEGER,wallet_address TEXT,document TEXT,created_at TEXT);
    CREATE TABLE imported_token_projects(owner_id TEXT,id TEXT,revision INTEGER,archived INTEGER,chain TEXT,address TEXT);
    CREATE TABLE workspace_wallets(owner_id TEXT,address TEXT,revision INTEGER,archived INTEGER,chain TEXT);
    CREATE TABLE imported_trade_sessions(owner_id TEXT,id TEXT,project_id TEXT,revision INTEGER,state TEXT,document TEXT);
    CREATE TABLE imported_trade_session_controls(owner_id TEXT,session_id TEXT,state TEXT,revision INTEGER);`);
  sqlite.exec(
    readFileSync('drizzle/0047_shared_swap_reservations.sql', 'utf8'),
  );
  sqlite.exec(
    readFileSync('drizzle/0068_remarkable_frightful_four.sql', 'utf8'),
  );
  if (withEvents)
    sqlite.exec(readFileSync('drizzle/0069_amusing_viper.sql', 'utf8'));
  sqlite.exec(readFileSync('drizzle/0070_overjoyed_betty_ross.sql', 'utf8'));
  sqlite
    .prepare('INSERT INTO imported_token_projects VALUES(?,?,?,?,?,?)')
    .run(
      'owner',
      manifest.projectId,
      1,
      0,
      'Solana',
      manifest.swaps[0].outputMint,
    );
  sqlite
    .prepare('INSERT INTO imported_trade_sessions VALUES(?,?,?,?,?,?)')
    .run('owner', manifest.sessionId, manifest.projectId, 1, 'active', '{}');
  sqlite
    .prepare('INSERT INTO imported_trade_session_controls VALUES(?,?,?,?)')
    .run('owner', manifest.sessionId, 'ready', 1);
  for (const r of manifest.swaps) {
    sqlite
      .prepare('INSERT INTO workspace_wallets VALUES(?,?,?,?,?)')
      .run('owner', r.wallet, 1, 0, 'Solana');
    sqlite
      .prepare('INSERT INTO imported_swap_preparations VALUES(?,?,?,?,?,?,?,?)')
      .run(
        r.preparationId,
        'owner',
        manifest.projectId,
        1,
        1,
        r.wallet,
        '{}',
        manifest.createdAt,
      );
    sqlite
      .prepare(
        'INSERT INTO imported_swap_signing_intents VALUES(?,?,?,?,?,?,NULL,?,?)',
      )
      .run(
        r.id,
        'owner',
        r.preparationId,
        r.wallet,
        JSON.stringify(r),
        'awaiting_signature',
        manifest.createdAt,
        manifest.createdAt,
      );
  }
  type Statement = {
    sql: string;
    values: (string | number | null)[];
    bind: (...values: (string | number | null)[]) => Statement;
    first: () => Promise<unknown>;
    all: () => Promise<unknown>;
    run: () => Promise<unknown>;
  };
  const adapter = {
    prepare(sql: string) {
      const s: Statement = {
        sql,
        values: [],
        bind(...values) {
          s.values = values;
          return s;
        },
        async first() {
          return sqlite.prepare(sql).get(...s.values) ?? null;
        },
        async all() {
          return { results: sqlite.prepare(sql).all(...s.values) };
        },
        async run() {
          const r = sqlite.prepare(sql).run(...s.values);
          return { meta: { changes: Number(r.changes) } };
        },
      };
      return s;
    },
    async batch(statements: Statement[]) {
      sqlite.exec('BEGIN');
      try {
        const results = [];
        for (const s of statements) results.push(await s.run());
        sqlite.exec('COMMIT');
        return results;
      } catch (e) {
        sqlite.exec('ROLLBACK');
        throw e;
      }
    },
  };
  const attach = () => {
    sqlite.exec('BEGIN');
    try {
      sqlite
        .prepare(
          "INSERT INTO jito_bundles VALUES(?,?,?,?,?,'reviewed',NULL,?,?)",
        )
        .run(
          'owner',
          manifest.id,
          manifest.projectId,
          manifest.sessionId,
          JSON.stringify(manifest),
          manifest.createdAt,
          manifest.createdAt,
        );
      for (let i = 0; i <= manifest.swaps.length; i++)
        sqlite
          .prepare('INSERT INTO jito_bundle_packets VALUES(?,?,?,?,NULL,NULL)')
          .run('owner', manifest.id, i, manifest.swaps[i]?.id ?? null);
      sqlite.exec('COMMIT');
    } catch (e) {
      sqlite.exec('ROLLBACK');
      throw e;
    }
  };
  return { sqlite, db: adapter as unknown as D1Database, attach };
}
