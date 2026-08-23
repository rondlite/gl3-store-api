import { describe, expect, it } from 'vitest';

import { loadEnv } from '../src/env.js';

const BASE = {
  DATABASE_URL: 'postgres:///x',
  INTERNAL_API_KEY: 'k'.repeat(32),
};

describe('loadEnv registry settings', () => {
  it('leaves the registry unconfigured when nothing is set', () => {
    const env = loadEnv(BASE);
    expect(env.REGISTRY_URL).toBeUndefined();
    expect(env.REGISTRY_REFRESH_MS).toBe(900_000);
  });

  it('accepts a full registry configuration', () => {
    const env = loadEnv({
      ...BASE,
      REGISTRY_URL: 'https://npm.gl3.dev',
      REGISTRY_USERNAME: 'storefront',
      REGISTRY_TOKEN: 'gl3_abc',
      REGISTRY_REFRESH_MS: '60000',
    });
    expect(env.REGISTRY_URL).toBe('https://npm.gl3.dev');
    expect(env.REGISTRY_USERNAME).toBe('storefront');
    expect(env.REGISTRY_TOKEN).toBe('gl3_abc');
    expect(env.REGISTRY_REFRESH_MS).toBe(60_000);
  });

  it('strips a trailing slash from the registry url', () => {
    // The client joins with '/', so a trailing slash would produce '//name'.
    const env = loadEnv({ ...BASE, REGISTRY_URL: 'https://npm.gl3.dev/' });
    expect(env.REGISTRY_URL).toBe('https://npm.gl3.dev');
  });
});
