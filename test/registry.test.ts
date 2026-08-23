import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';

import { fetchManifest } from '../src/registry.js';

let server: Server | undefined;

afterEach(async () => {
  if (server !== undefined) {
    await new Promise((resolve) => server!.close(resolve));
    server = undefined;
  }
});

/** Starts a throwaway registry and returns the config pointing at it. */
async function startRegistry(
  handler: (url: string, auth: string | undefined) => { status: number; body?: unknown }
) {
  server = createServer((req, res) => {
    const { status, body } = handler(req.url ?? '', req.headers.authorization);
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(body === undefined ? '' : JSON.stringify(body));
  });

  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const port = (server!.address() as { port: number }).port;

  return {
    url: `http://127.0.0.1:${port}`,
    username: 'storefront',
    token: 'gl3_secret',
    timeoutMs: 5000,
  };
}

const MANIFEST = {
  name: '@gl3-plugins/plugin-a',
  'dist-tags': { latest: '1.2.3' },
  readme: '# plugin-a',
  versions: {
    '1.2.3': {
      version: '1.2.3',
      description: 'a paid plugin',
      keywords: ['gl3', 'plugin'],
      license: 'UNLICENSED',
    },
  },
};

describe('fetchManifest', () => {
  it('returns the latest version fields', async () => {
    const config = await startRegistry(() => ({ status: 200, body: MANIFEST }));

    expect(await fetchManifest(config, '@gl3-plugins/plugin-a')).toEqual({
      version: '1.2.3',
      description: 'a paid plugin',
      keywords: ['gl3', 'plugin'],
      license: 'UNLICENSED',
      readme: '# plugin-a',
    });
  });

  it('sends HTTP Basic credentials', async () => {
    let seen: string | undefined;
    const config = await startRegistry((_url, auth) => {
      seen = auth;
      return { status: 200, body: MANIFEST };
    });

    await fetchManifest(config, '@gl3-plugins/plugin-a');

    const expected = `Basic ${Buffer.from('storefront:gl3_secret').toString('base64')}`;
    expect(seen).toBe(expected);
  });

  it('url-encodes the scoped name', async () => {
    let seen: string | undefined;
    const config = await startRegistry((url) => {
      seen = url;
      return { status: 200, body: MANIFEST };
    });

    await fetchManifest(config, '@gl3-plugins/plugin-a');
    expect(seen).toBe('/%40gl3-plugins%2Fplugin-a');
  });

  it('resolves null for 404 — a curated but unpublished package is normal', async () => {
    const config = await startRegistry(() => ({ status: 404, body: { error: 'no such package' } }));
    expect(await fetchManifest(config, '@gl3-plugins/nope')).toBeNull();
  });

  it('throws on 403, so a broken credential is never mistaken for an empty package', async () => {
    const config = await startRegistry(() => ({ status: 403, body: { error: 'denied' } }));
    await expect(fetchManifest(config, '@gl3-plugins/plugin-a')).rejects.toThrow(/403/);
  });

  it('throws when dist-tags.latest is missing', async () => {
    const config = await startRegistry(() => ({
      status: 200,
      body: { name: 'x', versions: {} },
    }));
    await expect(fetchManifest(config, '@gl3-plugins/plugin-a')).rejects.toThrow(/latest/);
  });

  it('throws when dist-tags.latest names a version absent from versions', async () => {
    const config = await startRegistry(() => ({
      status: 200,
      body: { name: 'x', 'dist-tags': { latest: '9.9.9' }, versions: { '1.0.0': {} } },
    }));
    await expect(fetchManifest(config, '@gl3-plugins/plugin-a')).rejects.toThrow(/9\.9\.9/);
  });

  it('drops a string keywords field but keeps the rest of the version', async () => {
    // A legacy manifest shape: keywords as a comma-separated string instead of
    // an array. Written straight through this would hit a text[] column and
    // fail with a Postgres "malformed array literal" on every future pass.
    const config = await startRegistry(() => ({
      status: 200,
      body: {
        name: 'x',
        'dist-tags': { latest: '1.0.0' },
        readme: '# plugin-a',
        versions: {
          '1.0.0': {
            description: 'a paid plugin',
            keywords: 'gl3, plugin',
            license: 'UNLICENSED',
          },
        },
      },
    }));

    const manifest = await fetchManifest(config, '@gl3-plugins/plugin-a');
    expect(manifest).toEqual({
      version: '1.0.0',
      description: 'a paid plugin',
      license: 'UNLICENSED',
      readme: '# plugin-a',
    });
  });

  it('drops an object-shaped license field but keeps the rest of the version', async () => {
    // The pre-SPDX license shape. Cast straight through, pg stringifies the
    // object and the website ends up displaying it as the licence text.
    const config = await startRegistry(() => ({
      status: 200,
      body: {
        name: 'x',
        'dist-tags': { latest: '1.0.0' },
        versions: {
          '1.0.0': {
            description: 'a paid plugin',
            keywords: ['gl3'],
            license: { type: 'MIT', url: 'https://example.com/license' },
          },
        },
      },
    }));

    const manifest = await fetchManifest(config, '@gl3-plugins/plugin-a');
    expect(manifest).toEqual({
      version: '1.0.0',
      description: 'a paid plugin',
      keywords: ['gl3'],
    });
  });
});
