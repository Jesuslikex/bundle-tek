import {
  createClient,
  type Client,
  type InValue,
  type ResultSet,
} from '@libsql/client';
let client: Client | undefined;
export function getTursoClient(): Client {
  if (client) return client;
  const url = process.env.TURSO_DATABASE_URL,
    authToken = process.env.TURSO_AUTH_TOKEN;
  if (!url || !authToken)
    throw new Error('Database configuration is unavailable.');
  const parsed = new URL(url);
  if (
    !['libsql:', 'https:'].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password
  )
    throw new Error('Invalid database endpoint.');
  return (client = createClient({ url, authToken, intMode: 'number' }));
}
function integer(value: number | bigint | undefined) {
  const n = Number(value ?? 0);
  if (!Number.isSafeInteger(n))
    throw new Error('Database integer exceeds the safe range.');
  return n;
}
function result<T>(r: ResultSet): D1Result<T> {
  return {
    success: true,
    results: r.rows.map((row) =>
      Object.fromEntries(r.columns.map((c) => [c, row[c]])),
    ) as T[],
    meta: {
      changes: integer(r.rowsAffected),
      last_row_id: integer(r.lastInsertRowid),
      duration: 0,
      size_after: 0,
      rows_read: r.rows.length,
      rows_written: integer(r.rowsAffected),
      changed_db: r.rowsAffected !== 0,
    },
  };
}
function argument(value: unknown): InValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'bigint' ||
    value instanceof ArrayBuffer ||
    value instanceof Uint8Array
  )
    return value;
  if (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    (!Number.isInteger(value) || Number.isSafeInteger(value))
  )
    return value;
  throw new Error('Invalid database parameter.');
}
class Statement {
  constructor(
    readonly db: Client,
    readonly sql: string,
    readonly args: InValue[] = [],
  ) {
    if (!sql.trim()) throw new Error('Empty database statement.');
  }
  bind(...args: unknown[]) {
    return new Statement(this.db, this.sql, args.map(argument));
  }
  async all<T>() {
    return result<T>(await this.db.execute({ sql: this.sql, args: this.args }));
  }
  async run<T>() {
    return this.all<T>();
  }
  async first<T>(column?: string): Promise<T | null> {
    const r = await this.all<Record<string, unknown>>();
    const row = r.results[0];
    if (!row) return null;
    if (column !== undefined) {
      if (!Object.hasOwn(row, column))
        throw new Error('Database column is unavailable.');
      return row[column] as T;
    }
    return row as T;
  }
  async raw<T>({ columnNames = false }: { columnNames?: boolean } = {}) {
    const r = await this.db.execute({ sql: this.sql, args: this.args });
    const rows = r.rows.map((row) => r.columns.map((c) => row[c]));
    return (columnNames ? [r.columns, ...rows] : rows) as T[];
  }
}
/** Existing APIs retain their prepared statements; multi-write batches remain atomic. */
export function createTursoDatabase(db: Client): D1Database {
  return {
    prepare(sql: string) {
      return new Statement(db, sql);
    },
    async batch<T>(statements: Statement[]) {
      if (statements.some((s) => !(s instanceof Statement) || s.db !== db))
        throw new Error('Database batch contains a foreign statement.');
      return (
        await db.batch(
          statements.map((s) => ({ sql: s.sql, args: s.args })),
          'write',
        )
      ).map((r) => result<T>(r));
    },
  } as unknown as D1Database;
}
export function getTursoDatabase() {
  return createTursoDatabase(getTursoClient());
}
