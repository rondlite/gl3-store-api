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
    expect((await authorize(userId, '@gl3-plugins/plugin-a')).status).toBe(403);
  });

  it('staff read every paid package without an entitlement row', async () => {
    // Publish rights already come from these roles; without implicit read the
    // publisher publishes blind (Verdaccio hides UI/search/install via
    // allow_access).
    const adminRes = await h.call('/v1/admin/users', {
      method: 'POST',
      body: JSON.stringify({ username: 'boss', email: 'boss@gl3.dev', roles: ['admin'] }),
    });
    const { userId: adminId } = (await adminRes.json()) as { userId: string };
    expect((await authorize(adminId, '@gl3-plugins/plugin-a')).status).toBe(200);

    const leadRes = await h.call('/v1/admin/users', {
      method: 'POST',
      body: JSON.stringify({ username: 'lead', email: 'lead@gl3.dev', roles: ['gl3-dev-lead'] }),
    });
    const { userId: leadId } = (await leadRes.json()) as { userId: string };
    expect((await authorize(leadId, '@gl3-plugins/anything')).status).toBe(200);

    // An unrelated role grants nothing.
    const modRes = await h.call('/v1/admin/users', {
      method: 'POST',
      body: JSON.stringify({ username: 'mod', email: 'mod@gl3.dev', roles: ['moderator'] }),
    });
    const { userId: modId } = (await modRes.json()) as { userId: string };
    expect((await authorize(modId, '@gl3-plugins/plugin-a')).status).toBe(403);
  });

  it('allows an exactly entitled package', async () => {
    const userId = await seedUser();
    await grant(userId, { package: '@gl3-plugins/plugin-a' });

    expect((await authorize(userId, '@gl3-plugins/plugin-a')).status).toBe(200);
    expect((await authorize(userId, '@gl3-plugins/plugin-b')).status).toBe(403);
  });

  it('allows any package in the scope for a wildcard entitlement', async () => {
    const userId = await seedUser();
    await grant(userId, { package: '@gl3-plugins/*', source: 'all-access' });

    expect((await authorize(userId, '@gl3-plugins/plugin-a')).status).toBe(200);
    expect((await authorize(userId, '@gl3-plugins/anything-else')).status).toBe(200);
  });

  it('denies after the entitlement is revoked', async () => {
    const userId = await seedUser();
    await grant(userId, { package: '@gl3-plugins/plugin-a' });
    expect((await authorize(userId, '@gl3-plugins/plugin-a')).status).toBe(200);

    await h.call(`/v1/admin/users/${userId}/entitlements`, {
      method: 'DELETE',
      body: JSON.stringify({ package: '@gl3-plugins/plugin-a' }),
    });

    expect((await authorize(userId, '@gl3-plugins/plugin-a')).status).toBe(403);
  });

  it('reinstates a revoked entitlement when it is granted again', async () => {
    const userId = await seedUser();
    await grant(userId, { package: '@gl3-plugins/plugin-a' });
    await h.call(`/v1/admin/users/${userId}/entitlements`, {
      method: 'DELETE',
      body: JSON.stringify({ package: '@gl3-plugins/plugin-a' }),
    });

    await grant(userId, { package: '@gl3-plugins/plugin-a', source: 'resubscribed' });
    expect((await authorize(userId, '@gl3-plugins/plugin-a')).status).toBe(200);
  });

  it('denies an expired entitlement', async () => {
    const userId = await seedUser();
    await grant(userId, { package: '@gl3-plugins/plugin-a', expiresAt: '2020-01-01T00:00:00Z' });

    expect((await authorize(userId, '@gl3-plugins/plugin-a')).status).toBe(403);
  });

  it('denies a disabled user who still holds the entitlement', async () => {
    const userId = await seedUser();
    await grant(userId, { package: '@gl3-plugins/*' });
    await h.db.query('update users set disabled_at = now() where id = $1', [userId]);

    expect((await authorize(userId, '@gl3-plugins/plugin-a')).status).toBe(403);
  });

  it('denies packages outside the sellable scope', async () => {
    const userId = await seedUser();
    await grant(userId, { package: '@gl3-plugins/*' });

    // The plugin never asks about these, but the endpoint must not answer "yes"
    // for a name a wildcard row was never meant to cover.
    expect((await authorize(userId, 'lodash')).status).toBe(403);
    expect((await authorize(userId, '@other/pkg')).status).toBe(403);
  });

  it('rejects granting a pattern that is not exact-or-scope', async () => {
    const userId = await seedUser();
    expect((await grant(userId, { package: '@gl3-plugins/plugin-*' })).status).toBe(400);
    expect((await grant(userId, { package: '@other/*' })).status).toBe(400);
    expect((await grant(userId, { package: '**' })).status).toBe(400);
  });

  it('rejects the public engine-core scope — @gl3 is not sellable', async () => {
    // The paid scope is @gl3-plugins; @gl3 (plugin-sdk, shared) is public by
    // construction and the registry never asks this service about it. A grant
    // under it would be dead weight at best and confusing at worst.
    const userId = await seedUser();
    expect((await grant(userId, { package: '@gl3/plugin-fixer' })).status).toBe(400);
    expect((await grant(userId, { package: '@gl3/*' })).status).toBe(400);
  });

  it('does not leak one user’s entitlements to another', async () => {
    const ron = await seedUser('ron');
    const mallory = await seedUser('mallory');
    await grant(ron, { package: '@gl3-plugins/plugin-a' });

    expect((await authorize(mallory, '@gl3-plugins/plugin-a')).status).toBe(403);
  });
});
