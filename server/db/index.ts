/**
 * Tiny database layer with two interchangeable backends:
 *  - real PostgreSQL via `pg` when DATABASE_URL is set (production);
 *  - PGlite (Postgres compiled to WebAssembly) otherwise, so the project runs
 *    with zero setup on any machine and tests get a fresh database each time.
 *
 * Both speak the same SQL with $1, $2 parameters.
 */
import { SCHEMA } from './schema.ts';

export interface Db {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  /** Run `fn` inside a transaction; rolls back if it throws. */
  transaction<R>(fn: (tx: Db) => Promise<R>): Promise<R>;
  close(): Promise<void>;
}

export async function connect(opts: { databaseUrl?: string; pgliteDir?: string }): Promise<Db> {
  const db = opts.databaseUrl ? await connectPostgres(opts.databaseUrl) : await connectPglite(opts.pgliteDir);
  await db.query(SCHEMA);
  return db;
}

async function connectPostgres(url: string): Promise<Db> {
  const pg = await import('pg');
  const pool = new pg.default.Pool({
    connectionString: url,
    ssl: url.includes('localhost') ? undefined : { rejectUnauthorized: false },
  });

  type Runner = { query: (s: string, p?: unknown[]) => Promise<unknown> };
  const run = async <T>(runner: Runner, sql: string, params?: unknown[]): Promise<T[]> => {
    // Without params, pg allows several statements (the schema) and returns an array of results.
    const res = (params ? await runner.query(sql, params) : await runner.query(sql)) as
      | { rows: T[] }
      | Array<{ rows: T[] }>;
    return Array.isArray(res) ? (res.at(-1)?.rows ?? []) : res.rows;
  };
  const wrap = (runner: Runner): Db => ({
    query: (sql, params) => run(runner, sql, params),
    async transaction() {
      throw new Error('nested transactions are not supported');
    },
    async close() {},
  });

  return {
    query: (sql, params) => run(pool, sql, params),
    async transaction<R>(fn: (tx: Db) => Promise<R>) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn(wrap(client));
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

async function connectPglite(dir?: string): Promise<Db> {
  const { PGlite } = await import('@electric-sql/pglite');
  const pglite = dir ? new PGlite(dir) : new PGlite();
  await pglite.waitReady;

  type Runner = {
    query: (s: string, p?: unknown[]) => Promise<{ rows: unknown[] }>;
    exec: (s: string) => Promise<Array<{ rows: unknown[] }>>;
  };
  const wrap = (runner: Runner): Db => ({
    async query<T>(sql: string, params?: unknown[]) {
      if (!params) {
        const results = await runner.exec(sql);
        return (results.at(-1)?.rows ?? []) as T[];
      }
      return (await runner.query(sql, params)).rows as T[];
    },
    async transaction() {
      throw new Error('nested transactions are not supported');
    },
    async close() {},
  });

  return {
    ...wrap(pglite as unknown as Runner),
    transaction: <R>(fn: (tx: Db) => Promise<R>) =>
      pglite.transaction((tx) => fn(wrap(tx as unknown as Runner))),
    close: () => pglite.close(),
  };
}
