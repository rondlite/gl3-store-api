import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createPool, type Db } from './db.js';

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

// Arbitrary but fixed: every process that migrates this database must use the
// same key for the lock to mean anything.
const MIGRATION_LOCK_KEY = 8675309;

/**
 * Applies every .sql file in migrations/ that is not yet recorded, in filename
 * order, each in its own transaction alongside its bookkeeping row -- so a
 * migration that fails halfway leaves no trace and can simply be re-run.
 *
 * The whole run is serialised behind an advisory lock. Postgres DDL is not
 * concurrency-safe in the way the name suggests: two processes calling
 * `create table if not exists` at the same instant race on the system catalog
 * and one loses with a duplicate-key error on pg_type. That happens whenever
 * two instances boot together, so the lock is not just for tests.
 */
export async function migrate(db: Db, log: (msg: string) => void = console.log): Promise<string[]> {
  const lock = await db.connect();
  try {
    await lock.query('select pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);

    await lock.query(`
      create table if not exists schema_migrations (
        name text primary key,
        applied_at timestamptz not null default now()
      )
    `);

    const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
    const { rows } = await lock.query<{ name: string }>('select name from schema_migrations');
    const applied = new Set(rows.map((row) => row.name));
    const ran: string[] = [];

    for (const file of files) {
      if (applied.has(file)) {
        continue;
      }

      const sql = await readFile(join(migrationsDir, file), 'utf8');
      try {
        await lock.query('begin');
        await lock.query(sql);
        await lock.query('insert into schema_migrations (name) values ($1)', [file]);
        await lock.query('commit');
        log(`applied ${file}`);
        ran.push(file);
      } catch (err) {
        await lock.query('rollback');
        throw new Error(`migration ${file} failed: ${(err as Error).message}`, { cause: err });
      }
    }

    return ran;
  } finally {
    await lock.query('select pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]).catch(() => {});
    lock.release();
  }
}

// Only run when invoked directly (`pnpm migrate`), not when imported by tests.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // Deliberately not loadEnv(): migrating needs a database and nothing else,
  // and requiring INTERNAL_API_KEY here would mean handing the deploy's admin
  // secret to a job that has no use for it.
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('DATABASE_URL is required');
    process.exit(1);
  }

  const db = createPool(databaseUrl);
  try {
    const ran = await migrate(db);
    console.log(ran.length === 0 ? 'nothing to apply' : `applied ${ran.length} migration(s)`);
  } finally {
    await db.end();
  }
}
