import { describe, expect, it } from 'vitest';

import { setupHarness } from './helpers.js';

const h = setupHarness();

async function seedUser(
  opts: { username?: string; roles?: string[] } = {}
): Promise<{ userId: string; token: string }> {
  const created = await h.call('/v1/admin/users', {
    method: 'POST',
    body: JSON.stringify({
      username: opts.username ?? 'ron',
      email: `${opts.username ?? 'ron'}@gl3.dev`,
      roles: opts.roles ?? ['admin'],
    }),
  });
  const { userId } = (await created.json()) as { userId: string };

  const minted = await h.call(`/v1/admin/users/${userId}/tokens`, {
    method: 'POST',
    body: JSON.stringify({ name: 'laptop' }),
  });
  const { token } = (await minted.json()) as { token: string };

  return { userId, token };
}

describe('internal API key', () => {
  it('rejects a request with no key', async () => {
    const res = await h.call('/v1/auth/authenticate', {
      method: 'POST',
      key: null,
      body: JSON.stringify({ username: 'ron', token: 'x' }),
    });
    expect(res.status).toBe(401);
  });

  it('rejects a wrong key', async () => {
    const res = await h.call('/v1/auth/authenticate', {
      method: 'POST',
      key: 'not-the-key-but-also-long-enough-to-pass-0',
      body: JSON.stringify({ username: 'ron', token: 'x' }),
    });
    expect(res.status).toBe(401);
  });
});

describe('POST /v1/auth/authenticate', () => {
  it('returns the user id and roles for a valid token', async () => {
    const { userId, token } = await seedUser({ roles: ['admin', 'gl3-dev-lead'] });

    const res = await h.call('/v1/auth/authenticate', {
      method: 'POST',
      body: JSON.stringify({ username: 'ron', token }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      userId,
      username: 'ron',
      groups: ['admin', 'gl3-dev-lead'],
    });
  });

  it('rejects a token that does not exist', async () => {
    await seedUser();
    const res = await h.call('/v1/auth/authenticate', {
      method: 'POST',
      body: JSON.stringify({ username: 'ron', token: 'gl3_nope' }),
    });
    expect(res.status).toBe(401);
  });

  it('rejects a valid token presented under someone else’s username', async () => {
    // The escalation this guards: Verdaccio matches `name === group`, so
    // logging in as "admin" would satisfy `publish: admin` on name alone.
    const { token } = await seedUser({ username: 'ron', roles: [] });

    const res = await h.call('/v1/auth/authenticate', {
      method: 'POST',
      body: JSON.stringify({ username: 'admin', token }),
    });

    expect(res.status).toBe(401);
  });

  it('rejects a revoked token', async () => {
    const { userId, token } = await seedUser();
    const minted = await h.call(`/v1/admin/users/${userId}/tokens`, {
      method: 'POST',
      body: JSON.stringify({ name: 'second' }),
    });
    const { tokenId } = (await minted.json()) as { tokenId: string };

    await h.call(`/v1/admin/tokens/${tokenId}`, { method: 'DELETE' });

    // The first token still works; only the revoked one is dead.
    const ok = await h.call('/v1/auth/authenticate', {
      method: 'POST',
      body: JSON.stringify({ username: 'ron', token }),
    });
    expect(ok.status).toBe(200);
  });

  it('rejects an expired token', async () => {
    const created = await h.call('/v1/admin/users', {
      method: 'POST',
      body: JSON.stringify({ username: 'ron', email: 'ron@gl3.dev' }),
    });
    const { userId } = (await created.json()) as { userId: string };

    const minted = await h.call(`/v1/admin/users/${userId}/tokens`, {
      method: 'POST',
      body: JSON.stringify({ name: 'old', expiresAt: '2020-01-01T00:00:00Z' }),
    });
    const { token } = (await minted.json()) as { token: string };

    const res = await h.call('/v1/auth/authenticate', {
      method: 'POST',
      body: JSON.stringify({ username: 'ron', token }),
    });
    expect(res.status).toBe(401);
  });

  it('never stores the plaintext token', async () => {
    const { token } = await seedUser();
    const { rows } = await h.db.query<{ token_hash: Buffer }>('select token_hash from tokens');
    for (const row of rows) {
      expect(row.token_hash.toString('utf8')).not.toContain(token);
    }
  });
});
