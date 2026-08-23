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

  it('400s on a name outside both GL3 scopes, rather than 404', async () => {
    const res = await h.call(`/v1/admin/catalog/${encodeURIComponent('lodash')}`, {
      method: 'DELETE',
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid_package' });
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

async function seedRow(pkg: string, position: number, fields: Record<string, unknown> = {}) {
  await addPkg({ package: pkg, position });
  const sets: string[] = [];
  const vals: unknown[] = [pkg];
  for (const [k, v] of Object.entries(fields)) {
    vals.push(v);
    sets.push(`${k} = $${vals.length}`);
  }
  if (sets.length > 0) {
    await h.db.query(`update catalog_packages set ${sets.join(', ')} where package = $1`, vals);
  }
}

describe('GET /v1/catalog/packages', () => {
  it('orders by position then package', async () => {
    await seedRow('@gl3-plugins/b', 2);
    await seedRow('@gl3/sdk', 1);
    await seedRow('@gl3-plugins/a', 1);

    const res = await h.call('/v1/catalog/packages');
    expect(res.status).toBe(200);
    const { packages } = (await res.json()) as { packages: { package: string }[] };
    expect(packages.map((p) => p.package)).toEqual([
      '@gl3-plugins/a',
      '@gl3/sdk',
      '@gl3-plugins/b',
    ]);
  });

  it('derives paid from the scope', async () => {
    await seedRow('@gl3-plugins/a', 1);
    await seedRow('@gl3/sdk', 2);

    const { packages } = (await (await h.call('/v1/catalog/packages')).json()) as {
      packages: { package: string; paid: boolean }[];
    };
    expect(packages.map((p) => [p.package, p.paid])).toEqual([
      ['@gl3-plugins/a', true],
      ['@gl3/sdk', false],
    ]);
  });

  it('omits the readme from the list', async () => {
    await seedRow('@gl3-plugins/a', 1, { readme: '# hello' });

    const { packages } = (await (await h.call('/v1/catalog/packages')).json()) as {
      packages: Record<string, unknown>[];
    };
    expect(packages[0]).not.toHaveProperty('readme');
    expect(packages[0]).toMatchObject({ package: '@gl3-plugins/a' });
  });

  it('marks a never-fetched package stale', async () => {
    await seedRow('@gl3-plugins/a', 1);

    const { packages } = (await (await h.call('/v1/catalog/packages')).json()) as {
      packages: { stale: boolean; fetchedAt: string | null }[];
    };
    expect(packages[0].stale).toBe(true);
    expect(packages[0].fetchedAt).toBeNull();
  });

  it('marks a freshly fetched package not stale', async () => {
    await seedRow('@gl3-plugins/a', 1, { version: '1.0.0' });
    await h.db.query("update catalog_packages set fetched_at = now() where package = $1", [
      '@gl3-plugins/a',
    ]);

    const { packages } = (await (await h.call('/v1/catalog/packages')).json()) as {
      packages: { stale: boolean; version: string }[];
    };
    expect(packages[0].stale).toBe(false);
    expect(packages[0].version).toBe('1.0.0');
  });

  it('marks a package with a recorded fetch error stale even when recently fetched', async () => {
    await seedRow('@gl3-plugins/a', 1, { fetch_error: 'not_published' });
    await h.db.query("update catalog_packages set fetched_at = now() where package = $1", [
      '@gl3-plugins/a',
    ]);

    const { packages } = (await (await h.call('/v1/catalog/packages')).json()) as {
      packages: { stale: boolean }[];
    };
    expect(packages[0].stale).toBe(true);
  });

  it('marks a package not stale when just under the threshold (20 minutes)', async () => {
    await seedRow('@gl3-plugins/a', 1, { version: '1.0.0' });
    await h.db.query(
      "update catalog_packages set fetched_at = now() - interval '20 minutes' where package = $1",
      ['@gl3-plugins/a']
    );

    const { packages } = (await (await h.call('/v1/catalog/packages')).json()) as {
      packages: { stale: boolean }[];
    };
    expect(packages[0].stale).toBe(false);
  });

  it('marks a package stale when over the threshold (40 minutes)', async () => {
    await seedRow('@gl3-plugins/a', 1);
    await h.db.query(
      "update catalog_packages set fetched_at = now() - interval '40 minutes' where package = $1",
      ['@gl3-plugins/a']
    );

    const { packages } = (await (await h.call('/v1/catalog/packages')).json()) as {
      packages: { stale: boolean }[];
    };
    expect(packages[0].stale).toBe(true);
  });
});

describe('GET /v1/catalog/packages/:package', () => {
  it('includes the readme', async () => {
    await seedRow('@gl3-plugins/a', 1, { readme: '# hello', description: 'd' });

    const res = await h.call(
      `/v1/catalog/packages/${encodeURIComponent('@gl3-plugins/a')}`
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      package: '@gl3-plugins/a',
      paid: true,
      description: 'd',
      readme: '# hello',
    });
  });

  it('404s on a package that is not catalogued', async () => {
    const res = await h.call(
      `/v1/catalog/packages/${encodeURIComponent('@gl3-plugins/missing')}`
    );
    expect(res.status).toBe(404);
  });

  it('400s on a name outside both GL3 scopes, rather than 404', async () => {
    const res = await h.call(`/v1/catalog/packages/${encodeURIComponent('lodash')}`);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid_package' });
  });
});

describe('internal API key', () => {
  it('rejects a request with no key', async () => {
    const res = await h.call('/v1/catalog/packages', { key: null });
    expect(res.status).toBe(401);
  });
});
