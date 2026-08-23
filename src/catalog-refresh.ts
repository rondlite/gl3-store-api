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
  const result: RefreshResult = { refreshed: 0, failed: 0, skipped: 0 };

  let rows: { package: string }[];
  try {
    const queryResult = await db.query<{ package: string }>(
      'select package from catalog_packages order by position, package'
    );
    rows = queryResult.rows;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('catalog refresh failed to list packages', { err: message });
    // Database unreachable is a blip, not a failure: return zero counts and let
    // the next pass try again. Do not throw.
    return result;
  }

  for (const { package: packageName } of rows) {
    try {
      const manifest = await fetchManifest(packageName);

      if (manifest === null) {
        // Curated but not published yet. Keep the cached metadata columns, but
        // do stamp fetched_at: it distinguishes "the refresher ran and this
        // package genuinely is not published" from "the refresher never ran".
        await db.query(
          "update catalog_packages set fetched_at = now(), fetch_error = 'not_published' where package = $1",
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
 *
 * Uses setTimeout chaining instead of setInterval to prevent overlapping passes:
 * a pass runs, and when it completes schedules the next one intervalMs later.
 * This makes overlap structurally impossible even with a slow registry.
 */
export function startCatalogRefresh(
  db: Db,
  fetchManifest: FetchManifest,
  logger: Logger,
  intervalMs: number
): () => void {
  let stopped = false;
  let pending: NodeJS.Timeout | null = null;

  const scheduleNext = (delayMs: number): void => {
    if (stopped) {
      return;
    }
    pending = setTimeout(() => {
      // Run the pass and schedule the next one when it finishes, so passes
      // never overlap even with a slow registry.
      void refreshCatalog(db, fetchManifest, logger)
        .then((result) => {
          logger.info('catalog refreshed', result);
          scheduleNext(intervalMs);
        })
        .catch((err) => {
          // Catch any rejection so nothing can escape the timer callback and
          // become unhandled. Schedule the next pass regardless.
          const message = err instanceof Error ? err.message : String(err);
          logger.error('catalog refresh crashed', { err: message });
          scheduleNext(intervalMs);
        });
    }, delayMs);
    pending.unref();
  };

  scheduleNext(1000);

  return () => {
    stopped = true;
    if (pending) {
      clearTimeout(pending);
      pending = null;
    }
  };
}
