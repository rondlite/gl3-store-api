import { describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import type { Db } from '../src/db.js';
import type { Logger } from '../src/log.js';

const KEY = 'test-internal-key-that-is-long-enough-000';

type Recorded = { level: string; msg: string; fields: Record<string, unknown> };

function recordingLogger(into: Recorded[]): Logger {
  const at = (level: string) => (msg: string, fields: Record<string, unknown> = {}) => {
    into.push({ level, msg, fields });
  };
  return { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') };
}

/** A pool that fails the way an unmigrated database does. */
function brokenDb(): Db {
  const fail = () => {
    const err = new Error('relation "users" does not exist') as Error & { code: string };
    err.code = '42P01';
    return Promise.reject(err);
  };
  return { query: fail, connect: fail } as unknown as Db;
}

describe('unhandled errors', () => {
  it('logs the cause and returns an opaque 500', async () => {
    const logs: Recorded[] = [];
    const app = createApp({
      db: brokenDb(),
      internalApiKey: KEY,
      logger: recordingLogger(logs),
    });

    const res = await app.request('http://test/v1/admin/users', {
      method: 'POST',
      headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'ron', email: 'ron@gl3.dev' }),
    });

    expect(res.status).toBe(500);

    // The client must not learn the table name or the SQL.
    const body = await res.text();
    expect(body).toBe(JSON.stringify({ error: 'internal' }));

    // ...but the operator must.
    const logged = logs.find((entry) => entry.level === 'error');
    expect(logged?.fields.code).toBe('42P01');
    expect(logged?.fields.err).toContain('relation "users" does not exist');
    expect(logged?.fields.path).toBe('/v1/admin/users');
  });

  it('logs one request line per request, without secrets', async () => {
    const logs: Recorded[] = [];
    const app = createApp({ db: brokenDb(), internalApiKey: KEY, logger: recordingLogger(logs) });

    await app.request('http://test/v1/admin/users', {
      method: 'POST',
      headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'ron', email: 'ron@gl3.dev' }),
    });

    const requests = logs.filter((entry) => entry.msg === 'request');
    expect(requests).toHaveLength(1);
    expect(requests[0]?.fields.status).toBe(500);
    expect(JSON.stringify(requests[0])).not.toContain(KEY);
  });

  it('does not log the internal key when a caller sends a wrong one', async () => {
    const logs: Recorded[] = [];
    const app = createApp({ db: brokenDb(), internalApiKey: KEY, logger: recordingLogger(logs) });

    await app.request('http://test/v1/admin/users', {
      method: 'POST',
      headers: { authorization: 'Bearer wrong-key-wrong-key-wrong-key-wrong' },
    });

    expect(JSON.stringify(logs)).not.toContain('wrong-key');
  });
});
