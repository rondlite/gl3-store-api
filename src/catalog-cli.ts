import { fileURLToPath } from 'node:url';

import { type FetchManifest, refreshCatalog } from './catalog-refresh.js';
import { createPool, type Db } from './db.js';
import { silentLogger } from './log.js';
import { PUBLIC_SCOPE, SCOPE, isCatalogPackage, isPaidPackage } from './packages.js';
import { fetchManifest as fetchFromRegistry } from './registry.js';
import { addCatalogPackage, listCatalog, removeCatalogPackage } from './service.js';

export type CatalogCliDeps = {
  db: Db;
  log: (msg: string) => void;
  errorLog: (msg: string) => void;
  /** Injected by tests. When absent, `refresh` builds one from the environment. */
  fetchManifest?: FetchManifest;
  /** Overridden by tests so the registry configuration check is drivable. */
  env?: Record<string, string | undefined>;
};

/** Gap between appended entries, so a package can be slotted between two later. */
const POSITION_STEP = 10;

async function nextPosition(db: Db): Promise<number> {
  const { rows } = await db.query<{ max: number | null }>(
    'select max(position) as max from catalog_packages'
  );
  const highest = rows[0]?.max ?? null;
  return highest === null ? POSITION_STEP : highest + POSITION_STEP;
}

async function add(deps: CatalogCliDeps, args: string[]): Promise<number> {
  const packageName = args[0];
  if (packageName === undefined) {
    deps.errorLog('usage: catalog-cli add <package> [position]');
    return 1;
  }

  if (!isCatalogPackage(packageName)) {
    deps.errorLog(
      `not a GL3 package name: ${packageName}. Expected "${SCOPE}name" or "${PUBLIC_SCOPE}name".`
    );
    return 1;
  }

  const rawPosition = args[1];
  let position: number;

  if (rawPosition === undefined) {
    position = await nextPosition(deps.db);
  } else {
    position = Number(rawPosition);
    if (!Number.isInteger(position)) {
      deps.errorLog(`position must be a whole number, got: ${rawPosition}`);
      return 1;
    }
  }

  await addCatalogPackage(deps.db, { package: packageName, position });
  deps.log(`added ${packageName} at position ${position}`);
  return 0;
}

async function list(deps: CatalogCliDeps): Promise<number> {
  const packages = await listCatalog(deps.db);

  if (packages.length === 0) {
    deps.log('no packages catalogued');
    return 0;
  }

  for (const row of packages) {
    const tier = isPaidPackage(row.package) ? 'paid' : 'free';
    // A row with no version has been registered but not yet fetched from the
    // registry. Saying so beats an empty column, which reads as a broken entry.
    const version = row.version ?? 'not fetched yet';
    const note = row.fetch_error === null ? '' : `  (${row.fetch_error})`;
    deps.log(`${String(row.position).padStart(5)}  ${row.package.padEnd(32)} ${tier.padEnd(4)}  ${version}${note}`);
  }

  return 0;
}

async function remove(deps: CatalogCliDeps, args: string[]): Promise<number> {
  const packageName = args[0];
  if (packageName === undefined) {
    deps.errorLog('usage: catalog-cli remove <package>');
    return 1;
  }

  const removed = await removeCatalogPackage(deps.db, packageName);
  if (!removed) {
    // Non-zero so a typo in a deploy script is noticed rather than reported as
    // a successful no-op.
    deps.errorLog(`not catalogued: ${packageName}`);
    return 1;
  }

  deps.log(`removed ${packageName}`);
  return 0;
}

/**
 * Builds the registry client from the environment, or names what is missing.
 *
 * Only `refresh` needs these. The other commands stay database-only, which is
 * why this is checked here rather than at startup.
 */
function registryFetch(
  deps: CatalogCliDeps
): { ok: true; fetch: FetchManifest } | { ok: false; missing: string[] } {
  if (deps.fetchManifest !== undefined) {
    return { ok: true, fetch: deps.fetchManifest };
  }

  const env = deps.env ?? process.env;
  const missing = ['REGISTRY_URL', 'REGISTRY_USERNAME', 'REGISTRY_TOKEN'].filter(
    (name) => (env[name] ?? '') === ''
  );

  if (missing.length > 0) {
    return { ok: false, missing };
  }

  const config = {
    url: (env.REGISTRY_URL as string).replace(/\/+$/, ''),
    username: env.REGISTRY_USERNAME as string,
    token: env.REGISTRY_TOKEN as string,
    // Matches the service's own wiring: longer than the auth plugin's 5s
    // timeout, because the registry answers this call by calling back into
    // store-api through that plugin.
    timeoutMs: 10_000,
  };

  return { ok: true, fetch: (packageName: string) => fetchFromRegistry(config, packageName) };
}

async function refresh(deps: CatalogCliDeps): Promise<number> {
  const registry = registryFetch(deps);

  if (!registry.ok) {
    deps.errorLog(`refresh needs the registry configured. Missing: ${registry.missing.join(', ')}`);
    return 1;
  }

  // The pass logs its own per-package warnings through a Logger. The counts it
  // returns are what an operator reads, so the pass itself stays quiet here.
  const result = await refreshCatalog(deps.db, registry.fetch, silentLogger());

  deps.log(
    `${result.refreshed} refreshed, ${result.failed} failed, ${result.skipped} skipped (not published)`
  );

  // Non-zero on any failure so a broken credential or an unreachable registry is
  // not reported to a deploy script as success.
  return result.failed > 0 ? 1 : 0;
}

/**
 * Runs one catalogue command and returns the process exit code.
 *
 * Takes its dependencies rather than reaching for the environment, so tests
 * drive it against a real database without spawning a process.
 */
export async function runCatalogCommand(deps: CatalogCliDeps, argv: string[]): Promise<number> {
  const [command, ...args] = argv;

  switch (command) {
    case 'add':
      return add(deps, args);
    case 'list':
      return list(deps);
    case 'remove':
      return remove(deps, args);
    case 'refresh':
      return refresh(deps);
    default:
      deps.errorLog(`unknown command: ${command ?? '(none)'}`);
      deps.errorLog(USAGE);
      return 1;
  }
}

const USAGE = `usage:
  catalog-cli add <package> [position]   register a package, appending if no position
  catalog-cli list                        show the catalogue in display order
  catalog-cli remove <package>            unregister a package
  catalog-cli refresh                     fetch metadata now instead of waiting for the timer

add, list and remove need DATABASE_URL.
refresh also needs REGISTRY_URL, REGISTRY_USERNAME and REGISTRY_TOKEN.`;

// Only run when invoked directly, not when imported by tests.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // Deliberately not loadEnv(): managing the catalogue needs a database, and for
  // refresh a registry credential. Requiring INTERNAL_API_KEY here would hand the
  // deploy's admin secret to a job with no use for it, the same reasoning
  // migrate.ts records.
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('DATABASE_URL is required');
    console.error(USAGE);
    process.exit(1);
  }

  const db = createPool(databaseUrl);
  try {
    const code = await runCatalogCommand(
      { db, log: console.log, errorLog: console.error },
      process.argv.slice(2)
    );
    if (code !== 0) {
      process.exitCode = code;
    }
  } finally {
    await db.end();
  }
}
