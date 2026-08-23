import { z } from 'zod';

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

/**
 * A manifest is authored by whoever published the package, not by the
 * registry, and two legacy-but-common npm shapes violate the types below:
 * `keywords` as a comma-separated string instead of an array, and `license`
 * as the pre-SPDX `{type, url}` object instead of a string. Each field
 * `.catch()`es back to undefined on a type mismatch rather than failing the
 * whole parse, so a package with a malformed field still gets its other
 * fields cached instead of failing identically on every future pass.
 */
const versionEntrySchema = z.object({
  description: z.string().optional().catch(undefined),
  keywords: z.array(z.string()).optional().catch(undefined),
  license: z.string().optional().catch(undefined),
});

const manifestDocumentSchema = z.object({
  'dist-tags': z
    .object({ latest: z.string().optional().catch(undefined) })
    .optional()
    .catch(undefined),
  versions: z.record(z.string(), z.unknown()).optional().catch(undefined),
  readme: z.string().optional().catch(undefined),
});

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

  const parsedDoc = manifestDocumentSchema.safeParse(await response.json());
  if (!parsedDoc.success) {
    throw new Error(`registry returned an unexpected manifest shape for ${packageName}`);
  }
  const doc = parsedDoc.data;

  const latest = doc['dist-tags']?.latest;
  if (latest === undefined) {
    throw new Error(`registry returned no dist-tags.latest for ${packageName}`);
  }

  const rawVersion = doc.versions?.[latest];
  if (rawVersion === undefined) {
    throw new Error(`registry returned no version ${latest} for ${packageName}`);
  }

  const parsedVersion = versionEntrySchema.safeParse(rawVersion);
  if (!parsedVersion.success) {
    throw new Error(`registry returned a malformed version ${latest} for ${packageName}`);
  }
  const version = parsedVersion.data;

  return {
    version: latest,
    ...(version.description !== undefined ? { description: version.description } : {}),
    ...(version.keywords !== undefined ? { keywords: version.keywords } : {}),
    ...(version.license !== undefined ? { license: version.license } : {}),
    ...(doc.readme !== undefined ? { readme: doc.readme } : {}),
  };
}
