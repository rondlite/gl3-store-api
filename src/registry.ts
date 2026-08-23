export type Manifest = {
  version: string;
  description?: string;
  keywords?: string[];
  license?: string;
  readme?: string;
};

export type RegistryConfig = {
  url: string;
  username: string;
  token: string;
  timeoutMs: number;
};

type ManifestDocument = {
  'dist-tags'?: { latest?: string };
  versions?: Record<string, { description?: string; keywords?: string[]; license?: string }>;
  readme?: string;
};

/**
 * Fetches a package manifest from the GL3 registry.
 *
 * HTTP Basic, not a bearer token: Verdaccio rejects a raw `gl3_` token in an
 * Authorization: Bearer header with a 401, and the only bearer it accepts is a
 * session JWT obtained by logging in -- which would add a login round-trip and
 * an expiry model for nothing this needs.
 *
 * Resolves null for 404. A curated package that has not been published yet is a
 * normal state, not a failure, and must not be confused with one: every other
 * non-2xx throws so that a revoked credential surfaces loudly instead of quietly
 * emptying the website's catalogue.
 */
export async function fetchManifest(
  config: RegistryConfig,
  packageName: string
): Promise<Manifest | null> {
  const auth = Buffer.from(`${config.username}:${config.token}`).toString('base64');

  const response = await fetch(`${config.url}/${encodeURIComponent(packageName)}`, {
    headers: { authorization: `Basic ${auth}`, accept: 'application/json' },
    signal: AbortSignal.timeout(config.timeoutMs),
  });

  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`registry responded ${response.status} for ${packageName}`);
  }

  const doc = (await response.json()) as ManifestDocument;
  const latest = doc['dist-tags']?.latest;
  if (latest === undefined) {
    throw new Error(`registry returned no dist-tags.latest for ${packageName}`);
  }

  const version = doc.versions?.[latest];
  if (version === undefined) {
    throw new Error(`registry returned no version ${latest} for ${packageName}`);
  }

  return {
    version: latest,
    ...(version.description !== undefined ? { description: version.description } : {}),
    ...(version.keywords !== undefined ? { keywords: version.keywords } : {}),
    ...(version.license !== undefined ? { license: version.license } : {}),
    ...(doc.readme !== undefined ? { readme: doc.readme } : {}),
  };
}
