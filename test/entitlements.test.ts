import { describe, expect, it } from 'vitest';

import { setupHarness } from './helpers.js';

const h = setupHarness();

async function seedUser(username = 'ron'): Promise<string> {
  const res = await h.call('/v1/admin/users', {
    method: 'POST',
    body: JSON.stringify({ username, email: `${username}@gl3.dev` }),
  });
  const { userId } = (await res.json()) as { userId: string };
  return userId;
}

function authorize(userId: string, pkg: string) {
  return h.call('/v1/auth/authorize-package', {
    method: 'POST',
    body: JSON.stringify({ userId, package: pkg }),
  });
}

function grant(userId: string, body: Record<string, unknown>) {
  return h.call(`/v1/admin/users/${userId}/entitlements`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

describe('POST /v1/auth/authorize-package', () => {
  it('denies a package the user has not bought', async () => {
    const userId = await seedUser();
    expect((await authorize(userId, '@gl3/plugin-a')).status).toBe(403);
  });

  it('allows an exactly entitled package', async () => {
    const userId = await seedUser();
    await grant(userId, { package: '@gl3/plugin-a' });

    expect((await authorize(userId, '@gl3/plugin-a')).status).toBe(200);
    expect((await authorize(userId, '@gl3/plugin-b')).status).toBe(403);
  });

  it('allows any package in the scope for a wildcard entitlement', async () => {
    const userId = await seedUser();
    await grant(userId, { package: '@gl3/*', source: 'all-access' });

    expect((await authorize(userId, '@gl3/plugin-a')).status).toBe(200);
    expect((await authorize(userId, '@gl3/anything-else')).status).toBe(200);
  });

  it('denies after the entitlement is revoked', async () => {
    const userId = await seedUser();
    await grant(userId, { package: '@gl3/plugin-a' });
    expect((await authorize(userId, '@gl3/plugin-a')).status).toBe(200);

    await h.call(`/v1/admin/users/${userId}/entitlements`, {
      method: 'DELETE',
      body: JSON.stringify({ package: '@gl3/plugin-a' }),
    });

    expect((await authorize(userId, '@gl3/plugin-a')).status).toBe(403);
  });

  it('reinstates a revoked entitlement when it is granted again', async () => {
    const userId = await seedUser();
    await grant(userId, { package: '@gl3/plugin-a' });
    await h.call(`/v1/admin/users/${userId}/entitlements`, {
      method: 'DELETE',
      body: JSON.stringify({ package: '@gl3/plugin-a' }),
    });

    await grant(userId, { package: '@gl3/plugin-a', source: 'resubscribed' });
    expect((await authorize(userId, '@gl3/plugin-a')).status).toBe(200);
  });

  it('denies an expired entitlement', async () => {
    const userId = await seedUser();
    await grant(userId, { package: '@gl3/plugin-a', expiresAt: '2020-01-01T00:00:00Z' });

    expect((await authorize(userId, '@gl3/plugin-a')).status).toBe(403);
  });

  it('denies a disabled user who still holds the entitlement', async () => {
    const userId = await seedUser();
    await grant(userId, { package: '@gl3/*' });
    await h.db.query('update users set disabled_at = now() where id = $1', [userId]);

    expect((await authorize(userId, '@gl3/plugin-a')).status).toBe(403);
  });

  it('denies packages outside the sellable scope', async () => {
    const userId = await seedUser();
    await grant(userId, { package: '@gl3/*' });

    // The plugin never asks about these, but the endpoint must not answer "yes"
    // for a name a wildcard row was never meant to cover.
    expect((await authorize(userId, 'lodash')).status).toBe(403);
    expect((await authorize(userId, '@other/pkg')).status).toBe(403);
  });

  it('rejects granting a pattern that is not exact-or-scope', async () => {
    const userId = await seedUser();
    expect((await grant(userId, { package: '@gl3/plugin-*' })).status).toBe(400);
    expect((await grant(userId, { package: '@other/*' })).status).toBe(400);
    expect((await grant(userId, { package: '**' })).status).toBe(400);
  });

  it('does not leak one user’s entitlements to another', async () => {
    const ron = await seedUser('ron');
    const mallory = await seedUser('mallory');
    await grant(ron, { package: '@gl3/plugin-a' });

    expect((await authorize(mallory, '@gl3/plugin-a')).status).toBe(403);
  });
});
