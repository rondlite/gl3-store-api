import { describe, expect, it } from 'vitest';

import { refreshCatalog } from '../src/catalog-refresh.js';
import { silentLogger } from '../src/log.js';
import type { Manifest } from '../src/registry.js';
import { setupHarness } from './helpers.js';

const h = setupHarness();

const MANIFEST: Manifest = {
  version: '1.2.3',
  description: 'a paid plugin',
  keywords: ['gl3'],
  license: 'UNLICENSED',
  readme: '# plugin-a',
};

async function catalogue(pkg: string, position = 1) {
  await h.call('/v1/admin/catalog', {
    method: 'POST',
    body: JSON.stringify({ package: pkg, position }),
  });
}

function row(pkg: string) {
  return h.db
    .query<{
      version: string | null;
      description: string | null;
      fetched_at: Date | null;
      fetch_error: string | null;
    }>(
      'select version, description, fetched_at, fetch_error from catalog_packages where package = $1',
      [pkg]
    )
    .then((r) => r.rows[0]);
}

describe('refreshCatalog', () => {
  it('writes the manifest fields and stamps the fetch', async () => {
    await catalogue('@gl3-plugins/a');

    const result = await refreshCatalog(h.db, async () => MANIFEST, silentLogger());

    expect(result).toEqual({ refreshed: 1, failed: 0, skipped: 0 });
    const r = await row('@gl3-plugins/a');
    expect(r.version).toBe('1.2.3');
    expect(r.description).toBe('a paid plugin');
    expect(r.fetch_error).toBeNull();
    expect(r.fetched_at).not.toBeNull();
  });

  it('keeps the last good value when a fetch throws', async () => {
    // A registry outage must never blank the website's catalogue.
    await catalogue('@gl3-plugins/a');
    await refreshCatalog(h.db, async () => MANIFEST, silentLogger());
    const before = await row('@gl3-plugins/a');

    const result = await refreshCatalog(
      h.db,
      async () => {
        throw new Error('connect ECONNREFUSED');
      },
      silentLogger()
    );

    expect(result).toEqual({ refreshed: 0, failed: 1, skipped: 0 });
    const after = await row('@gl3-plugins/a');
    expect(after.version).toBe('1.2.3');
    expect(after.description).toBe('a paid plugin');
    expect(after.fetch_error).toMatch(/ECONNREFUSED/);
    // fetched_at is deliberately NOT stamped on failure, so staleness keeps
    // growing instead of being masked by a fresh timestamp on a failed attempt.
    expect(after.fetched_at?.getTime()).toBe(before.fetched_at?.getTime());
  });

  it('records not_published for a 404 without clearing cached values', async () => {
    await catalogue('@gl3-plugins/a');
    await refreshCatalog(h.db, async () => MANIFEST, silentLogger());

    const result = await refreshCatalog(h.db, async () => null, silentLogger());

    expect(result).toEqual({ refreshed: 0, failed: 0, skipped: 1 });
    const r = await row('@gl3-plugins/a');
    expect(r.version).toBe('1.2.3');
    expect(r.fetch_error).toBe('not_published');
  });

  it('one failure does not abort the pass', async () => {
    await catalogue('@gl3-plugins/a', 1);
    await catalogue('@gl3-plugins/b', 2);
    await catalogue('@gl3-plugins/c', 3);

    const result = await refreshCatalog(
      h.db,
      async (name) => {
        if (name === '@gl3-plugins/b') {
          throw new Error('boom');
        }
        return MANIFEST;
      },
      silentLogger()
    );

    expect(result).toEqual({ refreshed: 2, failed: 1, skipped: 0 });
    expect((await row('@gl3-plugins/c')).version).toBe('1.2.3');
  });

  it('never throws, even when every fetch fails', async () => {
    // It runs from a timer callback; an escaping rejection would be unhandled.
    await catalogue('@gl3-plugins/a');

    await expect(
      refreshCatalog(
        h.db,
        async () => {
          throw new Error('boom');
        },
        silentLogger()
      )
    ).resolves.toEqual({ refreshed: 0, failed: 1, skipped: 0 });
  });

  it('is a no-op on an empty catalogue', async () => {
    expect(await refreshCatalog(h.db, async () => MANIFEST, silentLogger())).toEqual({
      refreshed: 0,
      failed: 0,
      skipped: 0,
    });
  });
});
