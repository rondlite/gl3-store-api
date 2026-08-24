import { describe, expect, it } from 'vitest';

import { runCatalogCommand } from '../src/catalog-cli.js';
import { setupHarness } from './helpers.js';

const h = setupHarness();

/** Captures what the command printed, so tests assert on output rather than on a spy. */
function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    log: (msg: string) => out.push(msg),
    errorLog: (msg: string) => err.push(msg),
  };
}

function rows() {
  return h.db
    .query<{ package: string; position: number }>(
      'select package, position from catalog_packages order by position, package'
    )
    .then((r) => r.rows);
}

describe('catalog add', () => {
  it('adds a package in the paid scope', async () => {
    const io = capture();

    const code = await runCatalogCommand(
      { db: h.db, log: io.log, errorLog: io.errorLog },
      ['add', '@gl3-plugins/plugin-a', '10']
    );

    expect(code).toBe(0);
    expect(await rows()).toEqual([{ package: '@gl3-plugins/plugin-a', position: 10 }]);
  });

  it('adds a package in the public scope', async () => {
    const io = capture();

    const code = await runCatalogCommand(
      { db: h.db, log: io.log, errorLog: io.errorLog },
      ['add', '@gl3/plugin-sdk', '1']
    );

    expect(code).toBe(0);
    expect(await rows()).toEqual([{ package: '@gl3/plugin-sdk', position: 1 }]);
  });

  it('refuses a name outside both GL3 scopes and writes nothing', async () => {
    const io = capture();

    const code = await runCatalogCommand(
      { db: h.db, log: io.log, errorLog: io.errorLog },
      ['add', 'lodash', '1']
    );

    expect(code).toBe(1);
    expect(io.err.join('\n')).toMatch(/lodash/);
    expect(await rows()).toEqual([]);
  });

  it('appends to the end when no position is given', async () => {
    // Gaps of ten so a later package can be slotted between two existing ones
    // without renumbering the whole list.
    const io = capture();
    const deps = { db: h.db, log: io.log, errorLog: io.errorLog };

    await runCatalogCommand(deps, ['add', '@gl3/plugin-sdk', '5']);
    await runCatalogCommand(deps, ['add', '@gl3-plugins/plugin-a']);

    expect(await rows()).toEqual([
      { package: '@gl3/plugin-sdk', position: 5 },
      { package: '@gl3-plugins/plugin-a', position: 15 },
    ]);
  });

  it('starts at ten when the catalogue is empty and no position is given', async () => {
    const io = capture();

    await runCatalogCommand({ db: h.db, log: io.log, errorLog: io.errorLog }, [
      'add',
      '@gl3/plugin-sdk',
    ]);

    expect(await rows()).toEqual([{ package: '@gl3/plugin-sdk', position: 10 }]);
  });

  it('repositions rather than duplicating when the package is already catalogued', async () => {
    const io = capture();
    const deps = { db: h.db, log: io.log, errorLog: io.errorLog };

    await runCatalogCommand(deps, ['add', '@gl3/plugin-sdk', '5']);
    await runCatalogCommand(deps, ['add', '@gl3/plugin-sdk', '99']);

    expect(await rows()).toEqual([{ package: '@gl3/plugin-sdk', position: 99 }]);
  });

  it('refuses a position that is not a whole number', async () => {
    const io = capture();

    const code = await runCatalogCommand(
      { db: h.db, log: io.log, errorLog: io.errorLog },
      ['add', '@gl3/plugin-sdk', 'first']
    );

    expect(code).toBe(1);
    expect(io.err.join('\n')).toMatch(/position/i);
    expect(await rows()).toEqual([]);
  });

  it('refuses to run without a package name', async () => {
    const io = capture();

    const code = await runCatalogCommand({ db: h.db, log: io.log, errorLog: io.errorLog }, ['add']);

    expect(code).toBe(1);
    expect(await rows()).toEqual([]);
  });
});

describe('catalog list', () => {
  it('reports an empty catalogue plainly rather than printing nothing', async () => {
    const io = capture();

    const code = await runCatalogCommand({ db: h.db, log: io.log, errorLog: io.errorLog }, [
      'list',
    ]);

    expect(code).toBe(0);
    expect(io.out.join('\n')).toMatch(/no packages/i);
  });

  it('lists packages in position order with their paid flag and version', async () => {
    const io = capture();
    const deps = { db: h.db, log: io.log, errorLog: io.errorLog };

    await runCatalogCommand(deps, ['add', '@gl3-plugins/plugin-a', '20']);
    await runCatalogCommand(deps, ['add', '@gl3/plugin-sdk', '10']);
    await h.db.query(
      "update catalog_packages set version = '1.2.3', fetched_at = now() where package = $1",
      ['@gl3-plugins/plugin-a']
    );

    const listing = capture();
    await runCatalogCommand({ db: h.db, log: listing.log, errorLog: listing.errorLog }, ['list']);
    const text = listing.out.join('\n');

    expect(text.indexOf('@gl3/plugin-sdk')).toBeLessThan(text.indexOf('@gl3-plugins/plugin-a'));
    expect(text).toMatch(/1\.2\.3/);
    expect(text).toMatch(/paid/i);
  });

  it('shows a package with no fetched metadata as pending rather than as blank', async () => {
    const io = capture();
    const deps = { db: h.db, log: io.log, errorLog: io.errorLog };

    await runCatalogCommand(deps, ['add', '@gl3/plugin-sdk', '1']);

    const listing = capture();
    await runCatalogCommand({ db: h.db, log: listing.log, errorLog: listing.errorLog }, ['list']);

    expect(listing.out.join('\n')).toMatch(/not fetched yet/i);
  });
});

describe('catalog remove', () => {
  it('removes a catalogued package', async () => {
    const io = capture();
    const deps = { db: h.db, log: io.log, errorLog: io.errorLog };

    await runCatalogCommand(deps, ['add', '@gl3/plugin-sdk', '1']);
    const code = await runCatalogCommand(deps, ['remove', '@gl3/plugin-sdk']);

    expect(code).toBe(0);
    expect(await rows()).toEqual([]);
  });

  it('exits non-zero when the package was not catalogued, so a typo is noticed', async () => {
    const io = capture();

    const code = await runCatalogCommand({ db: h.db, log: io.log, errorLog: io.errorLog }, [
      'remove',
      '@gl3/never-added',
    ]);

    expect(code).toBe(1);
    expect(io.err.join('\n')).toMatch(/@gl3\/never-added/);
  });

  it('refuses to run without a package name', async () => {
    const io = capture();

    const code = await runCatalogCommand({ db: h.db, log: io.log, errorLog: io.errorLog }, [
      'remove',
    ]);

    expect(code).toBe(1);
  });
});

describe('unknown commands', () => {
  it('prints usage and exits non-zero', async () => {
    const io = capture();

    const code = await runCatalogCommand({ db: h.db, log: io.log, errorLog: io.errorLog }, [
      'frobnicate',
    ]);

    expect(code).toBe(1);
    expect(io.err.join('\n')).toMatch(/frobnicate/);
  });
});

describe('catalog refresh', () => {
  const MANIFEST = {
    version: '2.0.0',
    description: 'fetched by the cli',
    keywords: ['gl3'],
    license: 'UNLICENSED',
    readme: '# hello',
  };

  it('fetches metadata for catalogued packages and reports the counts', async () => {
    const io = capture();
    const deps = { db: h.db, log: io.log, errorLog: io.errorLog };

    await runCatalogCommand(deps, ['add', '@gl3-plugins/plugin-a', '10']);

    const run = capture();
    const code = await runCatalogCommand(
      {
        db: h.db,
        log: run.log,
        errorLog: run.errorLog,
        fetchManifest: async () => MANIFEST,
      },
      ['refresh']
    );

    expect(code).toBe(0);
    expect(run.out.join('\n')).toMatch(/1 refreshed/);

    const { rows: after } = await h.db.query<{ version: string | null }>(
      'select version from catalog_packages where package = $1',
      ['@gl3-plugins/plugin-a']
    );
    expect(after[0]?.version).toBe('2.0.0');
  });

  it('reports a package the registry does not have as skipped rather than failed', async () => {
    const io = capture();
    await runCatalogCommand({ db: h.db, log: io.log, errorLog: io.errorLog }, [
      'add',
      '@gl3-plugins/plugin-a',
      '10',
    ]);

    const run = capture();
    const code = await runCatalogCommand(
      { db: h.db, log: run.log, errorLog: run.errorLog, fetchManifest: async () => null },
      ['refresh']
    );

    expect(code).toBe(0);
    expect(run.out.join('\n')).toMatch(/1 skipped/);
  });

  it('exits non-zero when a fetch fails, so a broken credential is not reported as success', async () => {
    const io = capture();
    await runCatalogCommand({ db: h.db, log: io.log, errorLog: io.errorLog }, [
      'add',
      '@gl3-plugins/plugin-a',
      '10',
    ]);

    const run = capture();
    const code = await runCatalogCommand(
      {
        db: h.db,
        log: run.log,
        errorLog: run.errorLog,
        fetchManifest: async () => {
          throw new Error('registry responded 401');
        },
      },
      ['refresh']
    );

    expect(code).toBe(1);
    expect(run.out.join('\n')).toMatch(/1 failed/);
  });

  it('refuses to run when the registry is not configured, naming what is missing', async () => {
    const io = capture();

    const code = await runCatalogCommand(
      { db: h.db, log: io.log, errorLog: io.errorLog, env: {} },
      ['refresh']
    );

    expect(code).toBe(1);
    const message = io.err.join('\n');
    expect(message).toMatch(/REGISTRY_URL/);
    expect(message).toMatch(/REGISTRY_USERNAME/);
    expect(message).toMatch(/REGISTRY_TOKEN/);
  });

  it('names only the variables that are actually missing', async () => {
    const io = capture();

    const code = await runCatalogCommand(
      {
        db: h.db,
        log: io.log,
        errorLog: io.errorLog,
        env: { REGISTRY_URL: 'https://npm.gl3.dev', REGISTRY_USERNAME: 'storefront' },
      },
      ['refresh']
    );

    expect(code).toBe(1);
    expect(io.err.join('\n')).toMatch(/REGISTRY_TOKEN/);
    expect(io.err.join('\n')).not.toMatch(/REGISTRY_URL/);
  });
});
