import type { Db } from './db.js';
import type { Logger } from './log.js';
import type { Manifest } from './registry.js';

export type FetchManifest = (packageName: string) => Promise<Manifest | null>;

export type RefreshResult = {
  /** Packages whose metadata was updated from a manifest. */
  refreshed: number;
  /** Packages whose fetch threw. Cached values were left alone. */
  failed: number;
  /** Packages the registry does not have yet (404). */
  skipped: number;
};

/**
 * One pass over every catalogued package.
 *
 * Never throws. It runs from a timer callback, where an escaping rejection
 * would be an unhandled rejection and take the process down -- and a registry
 * being briefly unreachable is routine, not fatal.
 *
 * A failed fetch never clears a previously good value: the website showing
 * slightly old metadata is always better than it showing none.
 */
export async function refreshCatalog(
  db: Db,
  fetchManifest: FetchManifest,
  logger: Logger
): Promise<RefreshResult> {
  const { rows } = await db.query<{ package: string }>(
    'select package from catalog_packages order by position, package'
  );

  const result: RefreshResult = { refreshed: 0, failed: 0, skipped: 0 };

  for (const { package: packageName } of rows) {
    try {
      const manifest = await fetchManifest(packageName);

      if (manifest === null) {
        // Curated but not published yet. Keep whatever we had.
        await db.query(
          "update catalog_packages set fetch_error = 'not_published' where package = $1",
          [packageName]
        );
        result.skipped += 1;
        continue;
      }

      await db.query(
        `update catalog_packages
            set version = $2,
                description = $3,
                keywords = $4,
                license = $5,
                readme = $6,
                fetched_at = now(),
                fetch_error = null
          where package = $1`,
        [
          packageName,
          manifest.version,
          manifest.description ?? null,
          manifest.keywords ?? null,
          manifest.license ?? null,
          manifest.readme ?? null,
        ]
      );
      result.refreshed += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn('catalog refresh failed', { package: packageName, err: message });

      // fetched_at is deliberately left alone: stamping it here would reset the
      // staleness clock on a failed attempt and hide the outage from the site.
      await db
        .query('update catalog_packages set fetch_error = $2 where package = $1', [
          packageName,
          message,
        ])
        .catch(() => {});
      result.failed += 1;
    }
  }

  return result;
}

/**
 * Runs `refreshCatalog` on an interval, plus one pass shortly after boot.
 *
 * The first pass is scheduled rather than awaited so a slow or unreachable
 * registry cannot delay the service becoming healthy. Returns a stop function.
 */
export function startCatalogRefresh(
  db: Db,
  fetchManifest: FetchManifest,
  logger: Logger,
  intervalMs: number
): () => void {
  const pass = (): void => {
    void refreshCatalog(db, fetchManifest, logger).then((result) => {
      logger.info('catalog refreshed', result);
    });
  };

  const first = setTimeout(pass, 1000);
  const timer = setInterval(pass, intervalMs);

  // Neither timer should hold the process open at shutdown.
  first.unref();
  timer.unref();

  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
