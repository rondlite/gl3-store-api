import { describe, expect, it } from 'vitest';

import { setupHarness } from './helpers.js';

const h = setupHarness();

function addPkg(body: Record<string, unknown>) {
  return h.call('/v1/admin/catalog', { method: 'POST', body: JSON.stringify(body) });
}

describe('POST /v1/admin/catalog', () => {
  it('accepts a paid-scope package', async () => {
    const res = await addPkg({ package: '@gl3-plugins/plugin-a', position: 10 });
    expect(res.status).toBe(201);

    const { rows } = await h.db.query<{ package: string; position: number }>(
      'select package, position from catalog_packages'
    );
    expect(rows).toEqual([{ package: '@gl3-plugins/plugin-a', position: 10 }]);
  });

  it('accepts a public-scope package', async () => {
    // The site is GL3's actual website, so the SDK belongs in the directory too.
    expect((await addPkg({ package: '@gl3/plugin-sdk', position: 1 })).status).toBe(201);
  });

  it('rejects a package outside both GL3 scopes', async () => {
    const res = await addPkg({ package: 'lodash', position: 1 });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid_package' });
  });

  it('upserts rather than duplicating, so a repeat call repositions', async () => {
    await addPkg({ package: '@gl3-plugins/plugin-a', position: 10 });
    await addPkg({ package: '@gl3-plugins/plugin-a', position: 3 });

    const { rows } = await h.db.query<{ position: number }>(
      'select position from catalog_packages'
    );
    expect(rows).toEqual([{ position: 3 }]);
  });
});

describe('DELETE /v1/admin/catalog/:package', () => {
  it('removes a package', async () => {
    await addPkg({ package: '@gl3-plugins/plugin-a', position: 1 });

    const res = await h.call(
      `/v1/admin/catalog/${encodeURIComponent('@gl3-plugins/plugin-a')}`,
      { method: 'DELETE' }
    );
    expect(res.status).toBe(200);

    const { rows } = await h.db.query('select 1 from catalog_packages');
    expect(rows).toHaveLength(0);
  });

  it('404s on a package that is not catalogued', async () => {
    const res = await h.call(
      `/v1/admin/catalog/${encodeURIComponent('@gl3-plugins/nope')}`,
      { method: 'DELETE' }
    );
    expect(res.status).toBe(404);
  });
});

describe('entitlement validators stay narrow', () => {
  it('refuses to authorize a public-scope package', async () => {
    // The catalogue admits @gl3/*; the entitlement check must not. Widening
    // this would push free packages through the paid authorization path.
    const created = await h.call('/v1/admin/users', {
      method: 'POST',
      body: JSON.stringify({ username: 'ron', email: 'ron@gl3.dev' }),
    });
    const { userId } = (await created.json()) as { userId: string };

    const res = await h.call('/v1/auth/authorize-package', {
      method: 'POST',
      body: JSON.stringify({ userId, package: '@gl3/plugin-sdk' }),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ reason: 'out_of_scope' });
  });

  it('refuses to grant an entitlement on the public scope', async () => {
    const created = await h.call('/v1/admin/users', {
      method: 'POST',
      body: JSON.stringify({ username: 'ron2', email: 'ron2@gl3.dev' }),
    });
    const { userId } = (await created.json()) as { userId: string };

    const res = await h.call(`/v1/admin/users/${userId}/entitlements`, {
      method: 'POST',
      body: JSON.stringify({ package: '@gl3/*' }),
    });
    expect(res.status).toBe(400);
  });
});
