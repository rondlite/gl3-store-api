import { afterEach, describe, expect, it, vi } from 'vitest';

import { refreshCatalog, startCatalogRefresh } from '../src/catalog-refresh.js';
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

  it('stamps fetched_at on a 404, distinguishing "checked, not published" from "never ran"', async () => {
    await catalogue('@gl3-plugins/a');

    await refreshCatalog(h.db, async () => null, silentLogger());

    const r = await row('@gl3-plugins/a');
    expect(r.fetched_at).not.toBeNull();
    expect(r.fetch_error).toBe('not_published');
  });

  it('stays stale on a 404 even though fetched_at was just stamped', async () => {
    await catalogue('@gl3-plugins/a');
    await refreshCatalog(h.db, async () => null, silentLogger());

    const res = await h.call('/v1/catalog/packages');
    const { packages } = (await res.json()) as { packages: { stale: boolean }[] };
    expect(packages[0].stale).toBe(true);
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

  describe('startCatalogRefresh / stop', () => {
    // Captured before useFakeTimers() replaces the global: refreshCatalog does
    // a real Postgres round trip per pass, and that I/O settles on the real
    // event loop, not on vitest's virtual clock. advanceTimersByTimeAsync
    // alone only flushes microtasks -- it does not give the real socket
    // callback a turn -- so each advance is interleaved with a short real
    // wait to let the previous pass's DB query actually resolve before the
    // next advance (or the final assertion) runs. Without this, `calls`
    // silently stayed at 0 forever, having nothing to do with stop() at all.
    const realSetTimeout = globalThis.setTimeout.bind(globalThis);
    const realWait = (ms: number) => new Promise((resolve) => realSetTimeout(resolve, ms));

    afterEach(() => {
      vi.useRealTimers();
    });

    it('stops scheduling further passes once stop() is called', async () => {
      await catalogue('@gl3-plugins/a');

      vi.useFakeTimers();
      let calls = 0;
      const stop = startCatalogRefresh(
        h.db,
        async () => {
          calls += 1;
          return MANIFEST;
        },
        silentLogger(),
        100
      );

      // The first pass fires ~1s after boot; each following pass intervalMs
      // later. Advance through several passes so the count is unambiguously
      // still climbing before stop() is called.
      await vi.advanceTimersByTimeAsync(1000);
      await realWait(20);
      for (let i = 0; i < 6; i++) {
        await vi.advanceTimersByTimeAsync(100);
        await realWait(20);
      }
      const callsBeforeStop = calls;
      expect(callsBeforeStop).toBeGreaterThanOrEqual(3);

      stop();

      for (let i = 0; i < 5; i++) {
        await vi.advanceTimersByTimeAsync(1000);
        await realWait(20);
      }
      expect(calls).toBe(callsBeforeStop);
    });
  });

  it('resolves with zero counts when database query fails', async () => {
    // Critical: refreshCatalog must never throw, even when listing packages fails.
    // A stub object cast to Db type lets us make the query reject on demand without
    // a real SQL error. This tests our error handling, not the database itself.
    const failingDb = {
      query: async () => {
        throw new Error('connection timeout');
      },
    } as unknown as typeof h.db;

    const result = await refreshCatalog(failingDb, async () => MANIFEST, silentLogger());

    expect(result).toEqual({ refreshed: 0, failed: 0, skipped: 0 });
  });
});
