import { afterAll, beforeAll, beforeEach } from 'vitest';

import { createApp } from '../src/app.js';
import { createPool, type Db } from '../src/db.js';
import { migrate } from '../src/migrate.js';

export const INTERNAL_API_KEY = 'test-internal-key-that-is-long-enough-000';

export type Harness = {
  db: Db;
  app: ReturnType<typeof createApp>;
  call: (path: string, init?: RequestInit & { key?: string | null }) => Promise<Response>;
};

/**
 * Boots one pool and one migrated schema for the file, then truncates between
 * tests. Truncating is a lot faster than re-running migrations, and keeps each
 * test independent without needing transaction rollback plumbing.
 */
export function setupHarness(): Harness {
  const databaseUrl =
    process.env.TEST_DATABASE_URL ?? 'postgres://localhost:5432/gl3_store_test';
  const harness = {} as Harness;

  beforeAll(async () => {
    harness.db = createPool(databaseUrl);
    await migrate(harness.db, () => {});
    harness.app = createApp({ db: harness.db, internalApiKey: INTERNAL_API_KEY });
    harness.call = (path, init = {}) => {
      const { key, ...rest } = init;
      const headers = new Headers(rest.headers);
      headers.set('content-type', 'application/json');
      if (key !== null) {
        headers.set('authorization', `Bearer ${key ?? INTERNAL_API_KEY}`);
      }
      return harness.app.request(`http://test${path}`, { ...rest, headers });
    };
  });

  beforeEach(async () => {
    await harness.db.query('truncate users, user_roles, tokens, entitlements cascade');
  });

  afterAll(async () => {
    await harness.db?.end();
  });

  return harness;
}
