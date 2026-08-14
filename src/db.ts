import pg from 'pg';

export type Db = pg.Pool;

export function createPool(databaseUrl: string): Db {
  return new pg.Pool({
    connectionString: databaseUrl,
    max: 10,
    // Every npm install hits /authenticate, so a stuck connection must fail
    // fast rather than pile requests up behind the pool.
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30_000,
  });
}
